// Offline tests. The last one drives the OFFICIAL connector lifecycle
// (`runReviewer`) against a mocked HTTP transport, so the sources.json stage is
// exercised by the real state machine rather than by calling the handler alone.
// Calling the handler directly is exactly what hid the deadlock before.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, chmod, mkdir, writeFile, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {planSourceRequest, sourceRequestFile, MAX_URLS} from '../source-plan.mjs';
import {makePipelineHandler, evidenceComplete, usableEvidence} from '../handler.mjs';
import {runReviewer} from './vendor/src/reviewer.mjs';
import {Store} from './vendor/src/store.mjs';
import {canonical} from './vendor/src/canonical.mjs';
import {criteriaFor} from './vendor/src/review-proof.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const URL_A = 'https://example.org/a';

async function privateDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await chmod(dir, 0o700);
  return dir;
}

// ---------- source planning ----------

test('a report with one https citation yields exactly that source request', () => {
  const plan = planSourceRequest(`Finding.\nSource: ${URL_A}`);
  assert.deepEqual(plan.urls, [URL_A]);
  assert.equal(plan.citationCheck, false);
  assert.deepEqual(sourceRequestFile(plan), {urls: [URL_A], citationCheck: false});
});

test('sentence punctuation is not part of the URL', () => {
  const plan = planSourceRequest('As shown at https://example.org/a. That is all.');
  assert.deepEqual(plan.urls, ['https://example.org/a']);
});

test('a balanced parenthesis inside the URL survives, an unbalanced one does not', () => {
  assert.deepEqual(planSourceRequest('see https://example.org/wiki/Foo_(bar)').urls,
    ['https://example.org/wiki/Foo_(bar)']);
  assert.deepEqual(planSourceRequest('see (https://example.org/a)').urls,
    ['https://example.org/a']);
});

test('duplicate citations collapse to one request', () => {
  const plan = planSourceRequest(`${URL_A} and again ${URL_A}`);
  assert.deepEqual(plan.urls, [URL_A]);
  assert.equal(plan.citationCheck, false);
});

test('a report with no citation asks for the citation policy witness, not a fake source', () => {
  const plan = planSourceRequest('I think the market was paused. No link here.');
  assert.deepEqual(plan.urls, []);
  assert.equal(plan.citationCheck, true);
});

test('plaintext http is never requested', () => {
  const plan = planSourceRequest('Source: http://example.org/a');
  assert.deepEqual(plan.urls, []);
  assert.equal(plan.citationCheck, true);
});

test('URLs carrying credentials are refused rather than silently stripped', () => {
  const plan = planSourceRequest('Source: https://user:pass@example.org/a');
  assert.deepEqual(plan.urls, []);
  assert.equal(plan.citationCheck, true);
});

test('more than eight distinct citations abstains instead of reviewing a subset', () => {
  const many = Array.from({length: MAX_URLS + 1}, (_, i) => `https://example.org/${i}`).join(' ');
  const plan = planSourceRequest(many);
  assert.deepEqual(plan.urls, []);
  assert.equal(plan.citationCheck, true);
  assert.match(plan.reason, /more than 8/);
});

// ---------- evidence completeness ----------

test('partial evidence is not complete evidence', () => {
  const request = {urls: [URL_A, 'https://example.org/b'], citationCheck: false};
  assert.equal(evidenceComplete(request, {sources: [], citationCheck: null}), false);
  assert.equal(evidenceComplete(request, {sources: [{url: URL_A, status: 200}], citationCheck: null}), false);
  assert.equal(evidenceComplete(request, {
    sources: [{url: URL_A, status: 200}, {url: 'https://example.org/b', status: 422}],
    citationCheck: null,
  }), true);
});

test('a failed source is terminal but never usable', () => {
  const evidence = {
    sources: [
      {url: URL_A, status: 422, error: 'source_unverified'},
      {url: 'https://example.org/b', status: 200, body: {id: randomUUID(), excerpt: 'text'}},
    ],
    citationCheck: null,
  };
  const usable = usableEvidence(evidence);
  assert.equal(usable.length, 1);
  assert.equal(usable[0].url, 'https://example.org/b');
});

test('a citation-only request needs its witness before the handler decides', () => {
  const request = {urls: [], citationCheck: true};
  assert.equal(evidenceComplete(request, {sources: [], citationCheck: null}), false);
  assert.equal(evidenceComplete(request, {sources: [], citationCheck: {status: 200, body: {}}}), true);
});

// ---------- handler stages ----------

test('handler writes sources.json and does not decide before evidence arrives', async () => {
  const dir = await privateDir('van-pipe-');
  try {
    const markdown = `The guardian paused the market. Source: ${URL_A}`;
    const brief = {brief: 'Who paused it?', acceptanceCriteria: ['Names the role'], platformCriteria: []};
    await writeFile(`${dir}/assignment.json`, JSON.stringify({
      jobId: randomUUID(), brief, markdown,
      requiredCriteria: criteriaFor(brief),
      briefHash: sha(canonical(brief)), submissionHash: sha(markdown),
    }));
    await writeFile(`${dir}/evidence.json`, JSON.stringify({sources: [], citationCheck: null}));

    const handler = makePipelineHandler({evaluate: async () => { throw Error('must not judge yet'); }});
    const first = await handler({workDir: dir});
    assert.equal(first.status, 'waiting_for_evidence');

    const written = JSON.parse(await readFile(`${dir}/sources.json`, 'utf8'));
    assert.deepEqual(written, {urls: [URL_A], citationCheck: false}); // no extra keys
    let decided = true;
    try { await readFile(`${dir}/decision.json`); } catch { decided = false; }
    assert.equal(decided, false);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('handler refuses a report whose text no longer matches the frozen digest', async () => {
  const dir = await privateDir('van-pipe-');
  try {
    const brief = {brief: 'b', acceptanceCriteria: ['c'], platformCriteria: []};
    await writeFile(`${dir}/assignment.json`, JSON.stringify({
      jobId: randomUUID(), brief, markdown: `edited. ${URL_A}`,
      requiredCriteria: criteriaFor(brief),
      briefHash: sha(canonical(brief)), submissionHash: sha('original'),
    }));
    const handler = makePipelineHandler({evaluate: async () => { throw Error('must not run'); }});
    await assert.rejects(handler({workDir: dir}), /report changed since it was frozen/);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('a quoted span that is not in the retained excerpt is refused, not downgraded', async () => {
  const dir = await privateDir('van-pipe-');
  try {
    const markdown = `The guardian paused the market. Source: ${URL_A}`;
    const brief = {brief: 'Who paused it?', acceptanceCriteria: ['Names the role'], platformCriteria: []};
    await writeFile(`${dir}/assignment.json`, JSON.stringify({
      jobId: randomUUID(), brief, markdown,
      requiredCriteria: criteriaFor(brief),
      briefHash: sha(canonical(brief)), submissionHash: sha(markdown),
    }));
    await writeFile(`${dir}/sources.json`, JSON.stringify({urls: [URL_A], citationCheck: false}));
    const id = randomUUID();
    await writeFile(`${dir}/evidence.json`, JSON.stringify({
      sources: [{url: URL_A, status: 200, body: {id, excerpt: 'The timelock paused the market.'}}],
      citationCheck: null,
    }));
    const handler = makePipelineHandler({
      evaluate: async () => ({status: 'PASS', reason: 'ok', evidenceId: id, sourceQuote: 'the guardian paused'}),
    });
    await assert.rejects(handler({workDir: dir}), /source quote not present verbatim/);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('with only failed sources every criterion abstains and the verdict is INCONCLUSIVE', async () => {
  const dir = await privateDir('van-pipe-');
  try {
    const markdown = `The guardian paused the market. Source: ${URL_A}`;
    const brief = {brief: 'Who paused it?', acceptanceCriteria: ['Names the role', 'States a date'], platformCriteria: []};
    await writeFile(`${dir}/assignment.json`, JSON.stringify({
      jobId: randomUUID(), brief, markdown,
      requiredCriteria: criteriaFor(brief),
      briefHash: sha(canonical(brief)), submissionHash: sha(markdown),
    }));
    await writeFile(`${dir}/sources.json`, JSON.stringify({urls: [URL_A], citationCheck: false}));
    await writeFile(`${dir}/evidence.json`, JSON.stringify({
      sources: [{url: URL_A, status: 422, error: 'source_unverified'}], citationCheck: null,
    }));
    const handler = makePipelineHandler({evaluate: async () => { throw Error('nothing to judge'); }});
    const result = await handler({workDir: dir});
    assert.equal(result.verdict, 'INCONCLUSIVE');
    const decision = JSON.parse(await readFile(`${dir}/decision.json`, 'utf8'));
    assert.ok(decision.checks.every((c) => c.status === 'UNVERIFIED' && c.evidenceIds.length === 0 && c.quote === null));
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

// ---------- the real connector state machine ----------

test('official runReviewer lifecycle completes a review through this handler', async () => {
  const MARKDOWN = `The guardian role paused the market on 2024-03-02. Source: ${URL_A}`;
  const EXCERPT = 'On 2024-03-02 the guardian role called setPaused(true) on the market proxy.';
  const dispatch = {jobId: randomUUID(), dispatchToken: randomUUID(), attempt: 1, timingVersion: 2};
  const brief = {
    brief: 'Which role paused the market, and on what date?',
    acceptanceCriteria: ['Names the role that executed the pause'],
    platformCriteria: [],
  };
  const now = Date.now();
  const assignment = {
    jobId: dispatch.jobId, timingVersion: 2, brief, markdown: MARKDOWN,
    briefHash: sha(canonical(brief)), submissionHash: sha(MARKDOWN),
    requiredCriteria: criteriaFor(brief),
    leaseUntil: new Date(now + 180000).toISOString(),
    processingDeadline: new Date(now + 600000).toISOString(),
    hardDeadline: new Date(now + 1200000).toISOString(),
  };

  const evidenceId = randomUUID();
  const submits = [];
  const requests = [];
  const client = {
    async request(path, body) {
      requests.push(path);
      if (path === '/agents/instances/heartbeat' || path === '/reviews/heartbeat') return {};
      // The reviewer lease heartbeat must return the current deadlines.
      if (path.endsWith('/review/heartbeat')) return assignment;
      if (path === '/reviews/next') return {dispatch};
      if (path.endsWith('/claim')) return assignment;
      if (path.endsWith('/evidence')) {
        assert.equal(body.url, URL_A, 'only the report citation is fetched');
        return {
          id: evidenceId, attemptId: randomUUID(), sourceUrl: body.url, excerpt: EXCERPT,
          bodyHash: sha(EXCERPT), fetchedAt: new Date().toISOString(),
        };
      }
      if (path.endsWith('/citation-check')) {
        return {attemptId: randomUUID(), outcome: 'not_fetched_policy_blocked', fetched: false, evidenceId: null};
      }
      if (path === `/jobs/${dispatch.jobId}/review`) {
        submits.push(structuredClone(body));
        return {jobId: dispatch.jobId, verdict: body.verdict};
      }
      return {};
    },
  };

  const storeDir = await privateDir('van-store-');
  const store = new Store(storeDir);
  await store.init();

  const handler = makePipelineHandler({
    evaluate: async (input) => ({
      status: 'PASS',
      reason: 'The cited page names the guardian role and the date of the pause.',
      evidenceId: input.evidence[0].id,
      sourceQuote: 'the guardian role called setPaused(true)',
    }),
  });

  const controller = new AbortController();
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const active = await store.read('active.json');
      if (!active?.assignment || active.receipt || active.phase === 'completed') return;
      const workDir = `${store.root}/${sha(active.dispatch.dispatchToken).slice(0, 32)}`;
      // The connector opens the same path as a private store and refuses
      // anything group/world-accessible. Created here with the default umask
      // (0755) this races the connector and fails intermittently, which is how
      // this line was found - it failed once in three full runs.
      await mkdir(workDir, {recursive: true, mode: 0o700});
      await handler({workDir});
    } catch {
      // Real failures surface through the assertions below.
    } finally {
      busy = false;
    }
  }, 15);

  try {
    await runReviewer(client, store, {instanceId: randomUUID(), minRewardAtomic: '17000'},
      {once: true, pulseMs: 40, interval: 10, signal: controller.signal});
  } finally {
    clearInterval(timer);
    while (busy) await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await rm(storeDir, {recursive: true, force: true});
  }

  assert.ok(requests.some((p) => p.endsWith('/evidence')), 'the connector fetched the planned source');
  assert.equal(submits.length, 1, 'exactly one receipt was submitted');
  assert.equal(submits[0].verdict, 'ACCEPT');
  assert.equal(submits[0].checks.length, 1);
  assert.equal(submits[0].checks[0].status, 'PASS');
  assert.ok(EXCERPT.includes(submits[0].checks[0].quote));
});
