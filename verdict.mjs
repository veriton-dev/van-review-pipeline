// Verdict semantics as a single tested rule.
//
// The handler used to derive the verdict inline, three lines from the receipt
// writer. VAN's connector then re-validates that derivation, and the two must
// agree exactly or a review is rejected after the work is done. Making the rule
// a module means the test can drive every status combination through both
// implementations instead of asserting the happy path.
//
// VAN's documented rule (reviewer-onboarding): ACCEPT requires every check PASS;
// REJECT/REVISE require a FAIL and no UNVERIFIED; anything unresolved calls for
// INCONCLUSIVE. This reviewer never issues REJECT: REJECT means "do not pay,
// do not revise", and the API accepts REVISE for the same FAIL evidence while
// leaving the worker one revision. Choosing REJECT would throw away an option
// the venue gives the counterparty, so it is never derived automatically.
export const STATUSES = ['PASS', 'FAIL', 'UNVERIFIED'];

export function deriveVerdict(checks) {
  if (!Array.isArray(checks) || checks.length === 0) throw Error('checks required');
  let unknown = false;
  let failed = false;
  for (const check of checks) {
    if (!check || !STATUSES.includes(check.status)) throw Error(`unknown check status: ${check?.status}`);
    if (check.status === 'UNVERIFIED') unknown = true;
    if (check.status === 'FAIL') failed = true;
  }
  if (unknown) return 'INCONCLUSIVE';
  return failed ? 'REVISE' : 'ACCEPT';
}
