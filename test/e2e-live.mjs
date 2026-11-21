// End-to-end proof with a REAL model call: the official connector state machine
// (heartbeats → poll → claim → evidence → receipt) driven against a mocked
// transport, with the actual judgment done by the model runner.
//
// The offline suite proves the state machine; the live smoke proves judgment on
// real HTTP. Neither proves the two together. This does: the receipt that the
// connector would post is produced by the real model from real fetched text,
// and every quote in it is re-checked against the retained bytes.
//
//   node test/e2e-live.mjs
//
// No VAN server, no credential, no payment, no dispatch attempt consumed.
import {mkdtemp, rm, chmod, mkdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {execFile as execFileCb} from 'node:child_process';
import {promisify} from 'node:util';
import {runReviewer} from './vendor/src/reviewer.mjs';
import {Store} from './vendor/src/store.mjs';
import {canonical} from './vendor/src/canonical.mjs';
import {criteriaFor} from './vendor/src/review-proof.mjs';
import {makePipelineHandler} from '../handler.mjs';
import {makeJudge, makeCliRunner} from '../judge.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const execFile = promisify(execFileCb);
const EXCERPT_LIMIT = 4000;
const URL_UNDER_TEST = 'https://example.com/';

async function fetchExcerpt(url) {
  const response = await fetch(url, {
    headers: {'user-agent': 'veriton-reviewer-proof/1.0 (independent review test)'},
    redirect: 'follow',
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw Error(`source fetch failed: HTTP ${response.status}`);
  const text = (await response.text()).replaceAll('\u0000', '');
  return {status: response.status, excerpt: text.slice(0, EXCERPT_LIMIT), bytes: text.length};
}

async function runOnce({label, markdown, brief, expected, excerpt}) {
  const dispatch = {jobId: randomUUID(), dispatchToken: randomUUID(), attempt: 1, timingVersion: 2};
  const now = Date.now();
  const assignment = {
    jobId: dispatch.jobId,
    timingVersion: 2,
    brief,
    markdown,
    briefHash: sha(canonical(brief)),
    submissionHash: sha(markdown),
    requiredCriteria: criteriaFor(brief),
    leaseUntil: new Date(now + 180000).toISOString(),
    processingDeadline: new Date(now + 600000).toISOString(),
    hardDeadline: new Date(now + 1200000).toISOString(),
  };
  const evidenceId = randomUUID();
  const posts = [];
  const requests = [];

  const client = {
    async request(path, body) {
      requests.push(path);
      if (path === '/agents/instances/heartbeat' || path === '/reviews/heartbeat') return {};
      if (path.endsWith('/review/heartbeat')) return assignment;
      if (path === '/reviews/next') return {dispatch};
      if (path.endsWith('/claim')) return assignment;
      if (path.endsWith('/evidence')) {
        return {
          id: evidenceId, attemptId: randomUUID(), sourceUrl: body.url, excerpt,
          bodyHash: sha(excerpt), fetchedAt: new Date().toISOString(),
        };
      }
      if (path.endsWith('/citation-check')) {
        return {attemptId: randomUUID(), outcome: 'not_fetched_policy_blocked', fetched: false, evidenceId: null};
      }
      if (path === `/jobs/${dispatch.jobId}/review`) {
        posts.push(structuredClone(body));
        return {jobId: dispatch.jobId, verdict: body.verdict};
      }
      throw Error(`unexpected path in mock transport: ${path}`);
    },
  };

  const dir = await mkdtemp(process.env.TMPDIR ? join(process.env.TMPDIR, 'van-e2e-') : join('/home/agent/.cache/agentbox/runtime-tmp', 'van-e2e-'));
  await chmod(dir, 0o700);
  const store = new Store(dir);
  await store.init();
  const handler = makePipelineHandler({evaluate: makeJudge({run: makeCliRunner({execFile})})});

  const controller = new AbortController();
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const active = await store.read('active.json');
      if (!active?.assignment || active.receipt || active.phase === 'completed') return;
      const workDir = `${store.root}/${sha(active.dispatch.dispatchToken).slice(0, 32)}`;
      await mkdir(workDir, {recursive: true});
      await handler({workDir});
    } catch {
      // Assertions below are the failure surface.
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
    await rm(dir, {recursive: true, force: true});
  }

  const receipt = posts[0];
  const check = receipt?.checks?.[0];
  const verdictOk = receipt?.verdict === expected;
  const quoteGrounded = check && (check.status === 'UNVERIFIED'
    ? check.quote === null
    : typeof check.quote === 'string' && excerpt.includes(check.quote));
  console.log(JSON.stringify({
    label,
    expected,
    verdict: receipt?.verdict ?? null,
    checks: receipt?.checks?.length ?? 0,
    criterionStatus: check?.status ?? null,
    quoteGrounded: Boolean(quoteGrounded),
    quote: check?.quote ? check.quote.slice(0, 120) : null,
    reason: check?.reason ? check.reason.slice(0, 160) : null,
    receiptsPosted: posts.length,
    evidenceFetched: requests.some((p) => p.endsWith('/evidence')),
    ok: Boolean(verdictOk && quoteGrounded && posts.length === 1),
  }, null, 1));
  return Boolean(verdictOk && quoteGrounded && posts.length === 1);
}

const {status, excerpt, bytes} = await fetchExcerpt(URL_UNDER_TEST);
console.log(`source ${URL_UNDER_TEST} -> HTTP ${status}, body ${bytes} chars, excerpt ${excerpt.length} chars`);

const supported = await runOnce({
  label: 'supported claim',
  brief: {brief: 'What title does the cited page display?', acceptanceCriteria: ['Reports the page title shown on the cited page'], platformCriteria: []},
  markdown: `## Finding\nThe cited page is titled "Example Domain".\n\nSource: ${URL_UNDER_TEST}`,
  expected: 'ACCEPT',
  excerpt,
});

const contradicted = await runOnce({
  label: 'contradicted claim',
  brief: {brief: 'What does the cited page tell visitors to do next?', acceptanceCriteria: ['Describes the action the cited page asks a visitor to take'], platformCriteria: []},
  markdown: `## Finding\nThe cited page invites visitors to add this domain to a shopping cart and complete a purchase.\n\nSource: ${URL_UNDER_TEST}`,
  expected: 'REVISE',
  excerpt,
});

console.log(supported && contradicted ? 'RESULT: PASS' : 'RESULT: FAIL');
process.exitCode = supported && contradicted ? 0 : 1;
