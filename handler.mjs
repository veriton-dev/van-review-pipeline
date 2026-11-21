// Complete VAN reviewer file handler: sources -> evidence -> decision.
//
// The connector drives the protocol and owns transport, credentials, heartbeats
// and receipts. This process owns judgment. It writes only the three files the
// published handler contract names:
//
//   sources.json   once, from the frozen report's own citations
//   decision.json  once, only after every requested source has a terminal result
//
// and it never writes a verdict it cannot ground. The earlier version of this
// handler skipped sources.json entirely, so the connector waited forever for a
// source request and no receipt was ever produced - a deadlock that only shows
// up when the real lifecycle runs, not when the handler is called directly.

import {readFile, writeFile, rename, open, unlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {planSourceRequest, sourceRequestFile} from './source-plan.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function readJson(dir, name) {
  try {
    const raw = await readFile(`${dir}/${name}`, 'utf8');
    if (!raw.trim()) return {state: 'empty'};
    return {state: 'ok', value: JSON.parse(raw), raw};
  } catch (error) {
    if (error.code === 'ENOENT') return {state: 'missing'};
    // A handoff file that exists but is unreadable is not "not ready yet".
    return {state: 'unreadable', error: error.message};
  }
}

// Write-then-rename so the connector never reads a half-written control file.
async function writeJsonAtomic(dir, name, value) {
  const tmp = `${dir}/.${name}.${process.pid}.tmp`;
  const handle = await open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, `${dir}/${name}`);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

/**
 * Evidence is complete only when every requested URL has a terminal entry and a
 * citation-only request has its witness. An empty or partial file is "still
 * running", never "nothing found".
 */
export function evidenceComplete(request, evidence) {
  if (!request) return false;
  if (request.citationCheck === true && request.urls.length === 0) {
    return evidence?.citationCheck != null;
  }
  if (!Array.isArray(evidence?.sources)) return false;
  if (evidence.sources.length < request.urls.length) return false;
  return request.urls.every((url, index) => {
    const entry = evidence.sources[index];
    if (!entry || entry.url !== url) return false;
    return entry.status === 200 || entry.status === 400 || entry.status === 422;
  });
}

// Only successful, excerpt-bearing sources can ground a PASS/FAIL.
export function usableEvidence(evidence) {
  if (!Array.isArray(evidence?.sources)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of evidence.sources) {
    if (entry?.status !== 200) continue;
    const body = entry.body;
    if (!body || typeof body.id !== 'string' || typeof body.excerpt !== 'string') continue;
    if (!body.excerpt.trim()) continue;
    if (seen.has(body.id)) continue;
    seen.add(body.id);
    out.push({id: body.id, url: entry.url, excerpt: body.excerpt});
  }
  return out;
}

export function makePipelineHandler({evaluate, log = () => {}}) {
  if (typeof evaluate !== 'function') throw Error('evaluate required');
  return async function handle({workDir}) {
    const assignment = await readJson(workDir, 'assignment.json');
    if (assignment.state === 'missing') return {status: 'waiting_for_assignment'};
    if (assignment.state !== 'ok') throw Error(`assignment.json unreadable: ${assignment.error ?? assignment.state}`);

    const file = assignment.value;
    if (typeof file.markdown !== 'string' || !file.markdown.trim()) throw Error('empty report');
    // Integrity first: never plan sources from a report the server did not freeze.
    if (sha256(file.markdown) !== file.submissionHash) throw Error('report changed since it was frozen');

    const existingSources = await readJson(workDir, 'sources.json');
    let request;
    if (existingSources.state === 'ok') {
      request = existingSources.value;
      log('sources_reused');
    } else {
      const plan = planSourceRequest(file.markdown);
      request = sourceRequestFile(plan);
      await writeJsonAtomic(workDir, 'sources.json', request);
      log(`sources_planned:${request.urls.length}:${plan.reason}`);
    }

    const evidence = await readJson(workDir, 'evidence.json');
    if (evidence.state !== 'ok' || !evidenceComplete(request, evidence.value)) {
      return {status: 'waiting_for_evidence', requested: request.urls.length};
    }

    if ((await readJson(workDir, 'decision.json')).state === 'ok') return {status: 'already_decided'};

    const usable = usableEvidence(evidence.value);
    const criteria = file.requiredCriteria;
    if (!Array.isArray(criteria) || criteria.length === 0) throw Error('no acceptance criteria in assignment');

    // No source could be retrieved or none carried text: every criterion must
    // abstain. This is a real answer, not a failure, and it is the only answer
    // the evidence supports.
    if (usable.length === 0) {
      const decision = {
        verdict: 'INCONCLUSIVE',
        reason: 'No retrieved source carried usable text; no criterion could be judged.',
        checks: criteria.map((criterion) => ({
          criterion,
          status: 'UNVERIFIED',
          reason: 'No retained source excerpt was available for this criterion.',
          evidenceIds: [],
          quote: null,
        })),
      };
      await writeJsonAtomic(workDir, 'decision.json', decision);
      log('decision_written:INCONCLUSIVE');
      return {status: 'decided', verdict: decision.verdict};
    }

    const checks = [];
    for (const criterion of criteria) {
      const result = await evaluate({
        brief: file.brief,
        submission: file.markdown,
        criterion,
        evidence: usable,
      }, {signal: new AbortController().signal});

      if (!result || typeof result.reason !== 'string') throw Error('invalid evaluation result');
      const reason = result.reason.trim().slice(0, 1000) || 'No reason supplied.';
      if (result.status === 'UNVERIFIED') {
        checks.push({criterion, status: 'UNVERIFIED', reason, evidenceIds: [], quote: null});
        continue;
      }
      if (result.status !== 'PASS' && result.status !== 'FAIL') throw Error(`unknown status ${result.status}`);
      const cited = usable.find((e) => e.id === result.evidenceId);
      // The model's quote is re-checked against the retained bytes here; the
      // connector re-checks it again. Two independent refusals are cheap.
      if (!cited) throw Error('evaluation cited an unknown evidence id');
      if (typeof result.sourceQuote !== 'string' || !result.sourceQuote.trim()) throw Error('missing source quote');
      if (!cited.excerpt.includes(result.sourceQuote)) throw Error('source quote not present verbatim');
      checks.push({
        criterion,
        status: result.status,
        reason,
        evidenceIds: [cited.id],
        quote: result.sourceQuote,
      });
    }

    const unknown = checks.some((c) => c.status === 'UNVERIFIED');
    const failed = checks.some((c) => c.status === 'FAIL');
    // Verdict is derived from the checks, never taken from the model.
    const verdict = unknown ? 'INCONCLUSIVE' : failed ? 'REVISE' : 'ACCEPT';
    const decision = {
      verdict,
      reason: unknown
        ? 'At least one criterion could not be established from the retrieved sources.'
        : failed
          ? 'A cited source contradicts the report on at least one criterion.'
          : 'Every criterion is supported by the report\'s own cited sources.',
      checks,
    };

    await writeJsonAtomic(workDir, 'decision.json', decision);
    log(`decision_written:${verdict}`);
    return {status: 'decided', verdict, checks: checks.map((c) => c.status)};
  };
}
