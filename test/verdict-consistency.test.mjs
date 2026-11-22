// Cross-check the reviewer's verdict rule against VAN's own validator.
//
// The handler derives a verdict from its checks; the connector then validates
// that receipt before submitting it. If the two disagree, the review is spent
// and rejected - the failure surfaces only after a real dispatch, so offline
// agreement is the only cheap place to catch it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, chmod, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {deriveVerdict} from '../verdict.mjs';
import {receiptFor} from './vendor/src/reviewer.mjs';
import {canonical} from './vendor/src/canonical.mjs';
import {criteriaFor, proofContext} from './vendor/src/review-proof.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const CRITERION = 'Names the role that paused the market';
const URL_A = 'https://example.org/a';
const EXCERPT = 'On 2024-03-02 the guardian role called setPaused(true).';

async function privateDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await chmod(dir, 0o700);
  return dir;
}

// One assignment, one dispatch, every status combination.
function fixture() {
  const brief = {brief: 'Which role paused the market?', acceptanceCriteria: [CRITERION], platformCriteria: []};
  const now = Date.now();
  const dispatch = {jobId: randomUUID(), dispatchToken: randomUUID(), attempt: 1, timingVersion: 2};
  const assignment = {
    jobId: dispatch.jobId,
    timingVersion: 2,
    brief,
    markdown: `The guardian paused the market. Source: ${URL_A}`,
    briefHash: sha(canonical(brief)),
    submissionHash: sha(`The guardian paused the market. Source: ${URL_A}`),
    requiredCriteria: criteriaFor(brief),
    leaseUntil: new Date(now + 600000).toISOString(),
    processingDeadline: new Date(now + 600000).toISOString(),
    hardDeadline: new Date(now + 1200000).toISOString(),
  };
  const evidenceId = randomUUID();
  const context = proofContext(assignment, dispatch);
  const evidence = {
    context,
    sources: [{
      context,
      status: 200,
      url: URL_A,
      body: {
        id: evidenceId,
        attemptId: randomUUID(),
        sourceUrl: URL_A,
        excerpt: EXCERPT,
        bodyHash: sha(EXCERPT),
        fetchedAt: new Date(now).toISOString(),
      },
    }],
  };
  return {assignment, dispatch, evidence, evidenceId};
}

function check(status, evidenceId) {
  if (status === 'UNVERIFIED') {
    return {criterion: CRITERION, status, reason: 'The excerpt does not establish it.', evidenceIds: [], quote: null};
  }
  return {
    criterion: CRITERION,
    status,
    reason: status === 'PASS' ? 'The excerpt names the guardian role.' : 'The excerpt contradicts the claimed role.',
    evidenceIds: [evidenceId],
    quote: 'the guardian role called setPaused(true)',
  };
}

const verdicts = ['PASS', 'FAIL', 'UNVERIFIED'];

test('the derived verdict is the one VAN\'s validator accepts, for every status', async () => {
  for (const first of verdicts) {
    const {assignment, dispatch, evidence, evidenceId} = fixture();
    const checks = [check(first, evidenceId)];
    const verdict = deriveVerdict(checks);
    const decision = {verdict, reason: 'One criterion, judged against the retained excerpt.', checks};
    // Throws if the connector disagrees with the derivation.
    const receipt = receiptFor(decision, assignment, dispatch, evidence);
    assert.equal(receipt.verdict, verdict);
    assert.equal(receipt.attempt, dispatch.attempt);
    assert.equal(receipt.checks.length, 1);
  }
});

test('a mixed FAIL and UNVERIFIED resolves to INCONCLUSIVE, which the validator accepts', async () => {
  const {assignment, dispatch, evidence, evidenceId} = fixture();
  const brief = {...assignment.brief, acceptanceCriteria: [CRITERION, 'States the date of the pause']};
  assignment.brief = brief;
  assignment.briefHash = sha(canonical(brief));
  assignment.requiredCriteria = criteriaFor(brief);
  evidence.context = proofContext(assignment, dispatch);
  evidence.sources[0].context = evidence.context;
  const criteria = assignment.requiredCriteria;
  const checks = [
    {...check('FAIL', evidenceId), criterion: criteria[0]},
    {...check('UNVERIFIED', evidenceId), criterion: criteria[1]},
  ];
  const verdict = deriveVerdict(checks);
  assert.equal(verdict, 'INCONCLUSIVE');
  assert.doesNotThrow(() =>
    receiptFor({verdict, reason: 'One contradicted claim and one unresolved criterion.', checks},
      assignment, dispatch, evidence));
});

test('this reviewer never derives REJECT', () => {
  // REJECT removes the counterparty's revision option; REVISE carries the same
  // FAIL evidence, so automatic derivation must not produce REJECT.
  for (const first of verdicts) {
    for (const second of verdicts) {
      const {evidenceId} = fixture();
      const checks = [
        {...check(first, evidenceId), criterion: 'a'},
        {...check(second, evidenceId), criterion: 'b'},
      ];
      assert.notEqual(deriveVerdict(checks), 'REJECT');
    }
  }
});

test('an unknown status fails loudly instead of quietly becoming ACCEPT', () => {
  assert.throws(() => deriveVerdict([{status: 'pass'}]), /unknown check status/);
  assert.throws(() => deriveVerdict([]), /checks required/);
  assert.throws(() => deriveVerdict(undefined), /checks required/);
});

test('a decision whose verdict disagrees with its own checks is refused by the validator', async () => {
  const {assignment, dispatch, evidence, evidenceId} = fixture();
  const checks = [check('FAIL', evidenceId)];
  assert.throws(() =>
    receiptFor({verdict: 'ACCEPT', reason: 'Wrong on purpose.', checks}, assignment, dispatch, evidence),
    /Inconsistent verdict/);
});

test('an UNVERIFIED check carrying a quote is refused before submission', async () => {
  const {assignment, dispatch, evidence, evidenceId} = fixture();
  const bad = {...check('UNVERIFIED', evidenceId), quote: 'the guardian role called setPaused(true)'};
  assert.throws(() =>
    receiptFor({verdict: 'INCONCLUSIVE', reason: 'Unresolved.', checks: [bad]}, assignment, dispatch, evidence),
    /Unsupported check evidence/);
});

test('a quote that is not in the retained excerpt is refused by the validator', async () => {
  const {assignment, dispatch, evidence, evidenceId} = fixture();
  const fabricated = {...check('PASS', evidenceId), quote: 'the guardian role called setPaused(false)'};
  assert.throws(() =>
    receiptFor({verdict: 'ACCEPT', reason: 'Grounded.', checks: [fabricated]}, assignment, dispatch, evidence),
    /Exact quote not present|Evidence request context/i);
});
