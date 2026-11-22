// Verdict semantics as a single tested rule.
//
// The handler used to derive the verdict inline, three lines from the receipt
// writer. VAN's connector then re-validates that derivation, and the two must
// agree exactly or a review is rejected after the work is done. Making the rule
// a module means a test can drive every status combination through both
// implementations instead of asserting the happy path.
//
// VAN's documented rule (reviewer-onboarding): ACCEPT requires every check PASS;
// REJECT/REVISE require a FAIL and no UNVERIFIED; anything unresolved calls for
// INCONCLUSIVE. The venue accepts both REJECT and REVISE for the same FAIL
// evidence, and they are not equivalent: REVISE leaves the worker its one
// revision, REJECT refuses payment and stops the order. So which one a FAIL
// produces is a policy choice, not a derivation:
//
//   auto (default)  follow the frozen brief: REVISE unless the brief itself
//                   says a contradiction requires REJECT
//   revise          always REVISE on a FAIL; never refuse outright
//   reject          always REJECT on a FAIL; no revisions
//
// A published rubric can also demand REJECT for the whole venue rather than per
// brief; that is a deployment setting (`--contradiction reject`), not something
// one report can argue its way into.
//
// The policy never upgrades anything: UNVERIFIED still forces INCONCLUSIVE, and
// an unknown status still throws rather than guessing.
export const STATUSES = ['PASS', 'FAIL', 'UNVERIFIED'];
export const POLICIES = ['auto', 'revise', 'reject'];
export const DEFAULT_POLICY = 'auto';

export function deriveVerdict(checks, {policy = DEFAULT_POLICY, reviseOnFailure = true} = {}) {
  if (!POLICIES.includes(policy)) throw Error(`unknown verdict policy: ${policy}`);
  if (typeof reviseOnFailure !== 'boolean') throw Error('reviseOnFailure must be boolean');
  if (!Array.isArray(checks) || checks.length === 0) throw Error('checks required');
  let unknown = false;
  let failed = false;
  for (const check of checks) {
    if (!check || !STATUSES.includes(check.status)) throw Error(`unknown check status: ${check?.status}`);
    if (check.status === 'UNVERIFIED') unknown = true;
    if (check.status === 'FAIL') failed = true;
  }
  if (unknown) return 'INCONCLUSIVE';
  if (!failed) return 'ACCEPT';
  if (policy === 'reject') return 'REJECT';
  if (policy === 'revise') return 'REVISE';
  return reviseOnFailure ? 'REVISE' : 'REJECT';
}

// A rubric can say a factual contradiction must be REJECTed rather than sent
// back. When the frozen brief states that in its own words, the reviewer follows
// it; otherwise the default favours the revision the venue offers.
//
// Only an explicit instruction flips this, and only the negative direction: no
// text can turn UNVERIFIED into a verdict or a FAIL into an ACCEPT.
const REJECT_REQUIRED = [
  /\brequires?\s+REJECT\b/i,
  /\bREJECT\s+rather\s+than\s+REVISE\b/i,
  /\bmust\s+be\s+REJECT(?:ED)?\b/i,
];

export function reviseOnFailureFromBrief(brief) {
  if (!brief || typeof brief !== 'object') return true;
  const parts = [];
  if (typeof brief.brief === 'string') parts.push(brief.brief);
  for (const key of ['acceptanceCriteria', 'platformCriteria']) {
    if (Array.isArray(brief[key])) parts.push(...brief[key].filter((v) => typeof v === 'string'));
  }
  const text = parts.join('\n');
  if (!text.trim()) return true;
  return !REJECT_REQUIRED.some((re) => re.test(text));
}
