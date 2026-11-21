// Stage 3 of VAN's reviewer handler contract: choose the bounded source request.
//
// The connector's `sources.json` is `{urls, citationCheck}` with at most eight
// URLs, and the server rejects URLs that are not present in the frozen report.
// This module is pure: no network, no filesystem, no model call. It only decides
// which citations the report actually makes.
//
// Design rules that matter for correctness:
// - Only https is requested. A plaintext source could be rewritten in transit,
//   and the server allowlist is https-only anyway.
// - A URL must be written in the report verbatim, so the server's "present in
//   the frozen report" check and our request cannot drift apart.
// - Text inside the report is data. Nothing here executes, follows or expands
//   anything a report says; a "fetch this instead" instruction is just prose.
// - When the report cites nothing, we ask for the citation policy check instead
//   of inventing a source or silently returning an empty plan.

export const MAX_URLS = 8;
const MAX_REPORT_BYTES = 64 * 1024;
const MAX_URL_CHARS = 2048;

const BARE_URL = /https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]*)?/g;

// Trailing punctuation belongs to the sentence, not to the URL.
function trimTrailingPunctuation(url) {
  let out = url;
  for (;;) {
    const last = out.at(-1);
    if (last === undefined) return out;
    if ('.,;:'.includes(last)) { out = out.slice(0, -1); continue; }
    // A closing bracket is punctuation unless it balances an opening one.
    if (last === ')' && (out.match(/\(/g)?.length ?? 0) < (out.match(/\)/g)?.length ?? 0)) {
      out = out.slice(0, -1);
      continue;
    }
    return out;
  }
}

function acceptable(url) {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL_CHARS) return false;
  if (!url.startsWith('https://')) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    // Credentials in a URL are never a citation; refuse rather than strip.
    if (parsed.username || parsed.password) return false;
    if (!parsed.hostname || parsed.hostname.includes('_')) return false;
    if (!parsed.hostname.includes('.')) return false;
    if (parsed.hostname === 'localhost') return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Plan the source request for one frozen report.
 * Returns `{urls, citationCheck}` exactly as the connector accepts it.
 * `reason` is local diagnostics only; it is never sent to the server.
 */
export function planSourceRequest(markdown) {
  if (typeof markdown !== 'string') return {urls: [], citationCheck: true, reason: 'report not a string'};
  if (Buffer.byteLength(markdown, 'utf8') > MAX_REPORT_BYTES) {
    return {urls: [], citationCheck: true, reason: 'report too large'};
  }

  const found = [];
  const seen = new Set();
  for (const match of markdown.matchAll(BARE_URL)) {
    const url = trimTrailingPunctuation(match[0]);
    if (!acceptable(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    found.push(url);
    if (found.length > MAX_URLS) break;
  }

  if (found.length === 0) {
    // No supported citation. Ask for the policy witness rather than fabricating
    // a source; a no-fetch witness permits only an all-UNVERIFIED verdict.
    return {urls: [], citationCheck: true, reason: 'no https citation in report'};
  }
  if (found.length > MAX_URLS) {
    // Honest abstention: we will not silently review a subset of a report whose
    // evidence base exceeds the protocol's eight-source bound.
    return {urls: [], citationCheck: true, reason: `report cites more than ${MAX_URLS} distinct sources`};
  }
  return {urls: found, citationCheck: false, reason: `cited ${found.length} source(s)`};
}

// The exact object the connector reads. Kept separate so a caller cannot
// accidentally send the diagnostic `reason` field, which is not in the contract.
export function sourceRequestFile(plan) {
  return {urls: plan.urls, citationCheck: plan.citationCheck};
}
