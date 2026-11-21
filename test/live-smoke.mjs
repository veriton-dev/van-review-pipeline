// Live proof, run manually: real HTTP fetch + real model judgment + real
// handler, on claims whose truth we already know. No VAN server, no
// credentials, no payments.
//
//   node live-smoke.mjs
//
// Design constraint this test makes explicit: the server returns at most 4000
// characters of a source. So a claim is only reviewable if it can be settled
// from that excerpt. Choosing a source whose first 4000 chars are page chrome
// and then asserting a fact buried later is a report defect, and the honest
// verdict is UNVERIFIED - which is also what the second scenario checks.
import {createHash} from 'node:crypto';
import {execFile as execFileCb} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, chmod, writeFile, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {canonical} from './vendor/src/canonical.mjs';
import {criteriaFor} from './vendor/src/review-proof.mjs';
import {makePipelineHandler} from '../handler.mjs';
import {makeJudge, makeCliRunner} from '../judge.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const execFile = promisify(execFileCb);
const EXCERPT_LIMIT = 4000;

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

async function reviewReport({label, markdown, brief, excerpt, url}) {
  const dir = await mkdtemp(join(tmpdir(), 'van-live-'));
  await chmod(dir, 0o700);
  try {
    const evidenceId = '8f14e45f-ceea-467a-9a3e-4b67f0e3e7a1';
    await writeFile(`${dir}/assignment.json`, JSON.stringify({
      jobId: 'a1b2c3d4-0000-4000-8000-000000000001',
      brief, markdown,
      requiredCriteria: criteriaFor(brief),
      briefHash: sha(canonical(brief)), submissionHash: sha(markdown),
    }));
    await writeFile(`${dir}/sources.json`, JSON.stringify({urls: [url], citationCheck: false}));
    await writeFile(`${dir}/evidence.json`, JSON.stringify({
      sources: [{url, status: 200, body: {id: evidenceId, excerpt}}],
      citationCheck: null,
    }));
    const handler = makePipelineHandler({evaluate: makeJudge({run: makeCliRunner({execFile})})});
    const result = await handler({workDir: dir});
    const decision = JSON.parse(await readFile(`${dir}/decision.json`, 'utf8'));
    console.log(`\n=== ${label}`);
    console.log('handler:', JSON.stringify(result));
    console.log('verdict:', decision.verdict, '|', decision.reason);
    for (const check of decision.checks) {
      console.log(`  [${check.status}] ${check.criterion}`);
      console.log(`     ${check.reason}`);
      if (check.quote) console.log(`     quote: ${JSON.stringify(check.quote.slice(0, 140))}`);
    }
    return decision;
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}

// example.com is small and static: its whole body fits inside the 4000-char
// excerpt, so the two scenarios differ only in whether the claim is true.
const URL_UNDER_TEST = 'https://example.com/';
const {status, excerpt, bytes} = await fetchExcerpt(URL_UNDER_TEST);
console.log(`source ${URL_UNDER_TEST} -> HTTP ${status}, body ${bytes} chars, excerpt ${excerpt.length} chars`);

const trueBrief = {
  brief: 'What title does the cited page display?',
  acceptanceCriteria: ['Reports the page title shown on the cited page'],
  platformCriteria: [],
};
const trueReport = `## Finding
The cited page is titled "Example Domain" and is used for documentation examples.\n\nSource: ${URL_UNDER_TEST}`;

const falseBrief = {
  brief: 'What does the cited page tell visitors to do next?',
  acceptanceCriteria: ['Describes the action the cited page asks a visitor to take'],
  platformCriteria: [],
};
const falseReport = `## Finding\nThe cited page invites visitors to add this domain to a shopping cart and complete a purchase.\n\nSource: ${URL_UNDER_TEST}`;

const a = await reviewReport({
  label: 'A - claim supported by the page', markdown: trueReport, brief: trueBrief, excerpt, url: URL_UNDER_TEST,
});
const b = await reviewReport({
  label: 'B - claim contradicted by the page', markdown: falseReport, brief: falseBrief, excerpt, url: URL_UNDER_TEST,
});

const passA = a.verdict === 'ACCEPT';
// A reviewer that cannot see a shopping cart must not ACCEPT the shopping claim.
const passB = b.verdict === 'REVISE' || b.verdict === 'INCONCLUSIVE';
console.log('\n=== summary');
console.log('A verdict:', a.verdict, '(expected ACCEPT)', passA ? 'OK' : 'WRONG');
console.log('B verdict:', b.verdict, '(expected REVISE or INCONCLUSIVE)', passB ? 'OK' : 'WRONG');
console.log(passA && passB ? 'RESULT: PASS' : 'RESULT: FAIL');
process.exitCode = passA && passB ? 0 : 1;
