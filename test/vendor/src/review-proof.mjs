import {NETWORK,ENVIRONMENT} from './network.mjs';
import {canonical} from './canonical.mjs';
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
export const DEFAULT_CRITERION = 'Material factual claims are supported by cited sources';
export function criteriaFor(brief) {
  const platform = brief?.platformCriteria ?? [DEFAULT_CRITERION];
  if (!Array.isArray(brief?.acceptanceCriteria) || !Array.isArray(platform) ||
      [...brief.acceptanceCriteria, ...platform].some(item => typeof item !== 'string')) {
    throw Error('Invalid frozen criteria');
  }
  return [...new Set([...brief.acceptanceCriteria, ...platform])];
}
export function proofContext(assignment, dispatch) {
  return {...(ENVIRONMENT==='mainnet'?{deployment:{environmentId:'mainnet',profileId:NETWORK.profileId,chainId:NETWORK.chainId,asset:NETWORK.asset,audience:NETWORK.audience}}:{}),jobId: dispatch.jobId, dispatchToken: dispatch.dispatchToken,
    briefHash: assignment.briefHash, submissionHash: assignment.submissionHash};
}
function sameContext(value, expected) {
  return value && canonical(value) === canonical(expected);
}
export function validateRetainedProof(decision, assignment, dispatch, retained) {
  const expected = proofContext(assignment, dispatch);
  if (!retained || !sameContext(retained.context, expected) || !Array.isArray(retained.sources)) {
    throw Error('Current-dispatch retained proof required');
  }
  const evidence = new Map();
  let witnesses = 0;
  for (const source of retained.sources) {
    if (!sameContext(source.context, expected) || typeof source.url !== 'string' ||
        !assignment.markdown.includes(source.url)) throw Error('Evidence request context mismatch');
    const body = source.body;
    if (source.status === 200) {
      if (!uuid(body?.id) || !uuid(body.attemptId) || body.sourceUrl !== source.url ||
          typeof body.excerpt !== 'string' || !digest(body.bodyHash) ||
          !Number.isFinite(Date.parse(body.fetchedAt))) throw Error('Invalid retained evidence response');
      const id = body.id.toLowerCase();
      if (evidence.has(id) && canonical(evidence.get(id)) !== canonical(body)) {
        throw Error('Conflicting retained evidence ID');
      }
      evidence.set(id, body); witnesses++;
    } else if (source.status === 422) {
      if (source.error !== 'source_unverified' || !uuid(source.attemptId)) {
        throw Error('Unwitnessed source failure');
      }
      witnesses++;
    } else if (source.status !== 400) {
      throw Error('Unresolved evidence response');
    }
  }
  let noFetch = false;
  if (retained.citationCheck) {
    const check = retained.citationCheck;
    if (!sameContext(check.context, expected)) throw Error('Citation policy context mismatch');
    if (check.status === 200) {
      if (!uuid(check.body?.attemptId) || check.body.fetched !== false || check.body.evidenceId !== null ||
          !['not_fetched_policy_blocked', 'not_fetched_no_supported_citation'].includes(check.body.outcome)) {
        throw Error('Invalid retained citation-policy response');
      }
      noFetch = true; witnesses++;
    } else if (check.status !== 409 || check.error !== 'supported_source_present') {
      throw Error('Unresolved citation-policy response');
    }
  }
  if (!witnesses) throw Error('Completed server source witness required');
  for (const check of decision.checks) {
    if (check.status === 'UNVERIFIED') continue; // shape validation requires [] / null
    const ids = check.evidenceIds.map(id => id.toLowerCase());
    if (new Set(ids).size !== ids.length || ids.length > 12 ||
        ids.some(id => !evidence.has(id))) throw Error('Evidence ID not retained for current dispatch');
    if (check.quote.length > 1000 || !ids.some(id => evidence.get(id).excerpt.includes(check.quote))) {
      throw Error('Exact quote not present in cited retained evidence');
    }
  }
  if (noFetch && (decision.verdict !== 'INCONCLUSIVE' ||
      decision.checks.some(check => check.status !== 'UNVERIFIED'))) {
    throw Error('No-fetch witness permits only all-UNVERIFIED INCONCLUSIVE');
  }
}
