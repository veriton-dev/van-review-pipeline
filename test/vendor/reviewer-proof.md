# Reviewer proof and recovery contract (v0.2.1)

This document describes the current VAN server contract and the connector's
additional local checks. It is not a certificate of source truth or semantic
correctness. The independent handler still evaluates the actual claims.

## Exact hash preimages

- `briefHash`: lowercase hex SHA-256 of UTF-8 RFC 8785 canonical JSON of the
  **entire frozen `brief` object returned by claim**. Do not hash the request
  wrapper, pretty JSON, `requiredCriteria`, or just `brief.brief`. Do not trim or
  normalize Unicode. New budget briefs have the platform criterion inserted by
  the server before freezing; hash the returned object exactly, not a reconstructed
  object with optional fields added/removed. The connector canonicalizes that
  returned object and checks its digest before handing it to the handler.
- `submissionHash`: lowercase hex SHA-256 of the exact UTF-8 `markdown` string.
  No Markdown parsing, newline conversion, Unicode normalization or trimming.
  A final newline or CRLF instead of LF changes the hash.
- `bodyHash`: SHA-256 of all accumulated successful source response-body bytes
  as exposed by Node fetch (after HTTP content decoding), before conversion to
  a string, NUL removal or excerpt truncation. The full body is capped at 1 MiB.
  It is not a hash of HTTP headers, compressed wire bytes, rendered HTML or the
  returned excerpt. The excerpt is `bytes.toString('utf8').replaceAll(NUL,'')`
  followed by `.slice(0,4000)` (UTF-16 code units). The API returns only the
  excerpt and full-body digest, not full bytes; the connector cannot recompute
  bodyHash from that excerpt and does not claim otherwise.

Independent checkable inputs/preimages/digests are in
[examples/vectors/hash-preimages.json](../examples/vectors/hash-preimages.json).
They include Unicode, CRLF, NUL removal and a trailing newline. Digests were
computed with Python hashlib independently of the connector's Node code, then
checked by the test suite. These are synthetic inputs, not live evidence.

## requiredCriteria

Exactly the server's insertion-ordered Set of:

```js
[...brief.acceptanceCriteria,
 ...(brief.platformCriteria ?? [
   'Material factual claims are supported by cited sources'
 ])]
```

Exact duplicate strings are removed, preserving first occurrence. No sorting,
case folding, trimming or Unicode normalization occurs. An explicit empty
platformCriteria array adds no default; absent/null adds the default. This
criteria list is derived separately; never inject a default into the brief hash
preimage. The connector independently derives it and rejects a mismatching claim.

## What the server independently checks

The server selects the assignment by job, authenticated reviewer, submission and
current dispatch token. For a NEW receipt it verifies current status/lease/order
deadline, dispatch attempt number and exact frozen brief/submission hashes.
It requires each frozen criterion once, consistent verdict/status combinations,
and evidence-free UNVERIFIED (`evidenceIds:[]`, `quote:null`).

For each PASS/FAIL, every referenced evidence ID must exist for that submission
and be referenced by a completed `verified` source attempt for **that reviewer
and dispatch token**. The supplied quote must be an exact, case-sensitive substring
of at least one of the excerpts referenced by that same check. An actual quote
in some other uncited record is insufficient. Invalid receipts are rejected
before applying their review/financial effects. There is an additional narrow
Base-Sepolia-chain-ID pilot guard; this is not general semantic fact checking.

Source collection requires a server-allowlisted URL present in the frozen report,
the authenticated assigned reviewer/current token, current submission/worker lease,
live review lease and unexpired order. Redirects are refused. Only the server
constructs receipt sourceAttempts; clients cannot assert retrieval or qualification.

A real evidence row/quote does not prove that it supports a criterion. The
server's `verified` outcome means successfully retrieved bytes with a retained excerpt/digest,
not a verified factual conclusion. Relevance, completeness, contradiction and
instruction-injection handling remain responsibilities of the independent agent.

## Local connector guard

`receiptFor(decision, assignment, dispatch, retainedProof)` now requires records
from the connector's private active state, not the handler's evidence.json copy.
The connector attaches the exact request's job/token/brief/submission context and
checks it before using a response. It rejects invented, stale, cross-context or
failed-source evidence IDs, malformed witness metadata, duplicate references,
and quotations not literally in the cited retained excerpt. No-fetch records
permit only all-UNVERIFIED INCONCLUSIVE. A bare error/400/409 or empty evidence
array cannot qualify an inconclusive receipt. A completed 422 source_unverified
needs the server attemptId, which the connector now retains privately.

The API response does not include a signed dispatch attestation. This local
binding is established by the pinned authenticated HTTPS request/response and
private saved context; it is not an independently verifiable server signature.
A handler sharing the same OS user can modify private state: this is not an OS
sandbox. The server still independently enforces database bindings.

## Uncertain /evidence response: exact retry

The server uniqueness key is `(submission_id, reviewer_id, dispatch_token,
source_url)`. It inserts a pending attempt before network retrieval, under an
order lock. Retrying the same POST/token/URL while still eligible:

- Completed verified: returns the same attemptId and evidence ID/excerpt/hash;
  no new fetch/attempt or additional source-limit slot is allocated.
- Completed technical failure: returns 422 source_unverified with the same
  attemptId. This witnesses failure, not usable factual evidence.
- Still pending: 409 source_fetch_pending; it does not start a second fetch.
- Lost/replaced/expired token or closed order: 409 source_unavailable; old work
  cannot be renewed/rebound by retrying.

There is no separate public source read-back endpoint; exact POST is the cache
read while the dispatch is eligible. Maximum eight recorded source entries per
dispatch; repeats reuse their slot. A later dispatch may fetch anew and has its
own attempt. The evidence ID itself may be reused if the same submission/URL/body
was already retained; a *new current verified attempt* is still required.
Completed attempts cannot be updated/deleted by normal server operations.

## Uncertain /citation-check response

Exact POST/token retry reuses the immutable policy row under
`urn:van:report-citation-policy` for the same submission/reviewer/dispatch and
returns the same attemptId/outcome. No URL fetch takes place. Supported-source
409 creates no no-fetch witness. Expired/replaced/unclaimed/completed/v1 dispatch
returns 409 review_unavailable. These outcomes are not evidence of a network outage
or fabrication, and do not justify PASS/FAIL/REVISE/REJECT.

## Connector recovery behavior and payment boundary

After a transport error the connector stops with active state retained. Restart
with the same state/token/source request to read the server's cached result. It
never resets an attempt counter, invents an attempt ID, changes the URL/token to
bypass uncertainty, or asks for another dispatch while active work is unresolved.
A pending 409 currently stops as well; coordinate a bounded exact retry while the
lease is valid and keep required heartbeats alive. A permanently pending attempt
(e.g. server crash before completion) is not auto-completed by retry. If it cannot
be reconciled within the lease/hard deadline, preserve state and use bounded
expiry/operator reconciliation; never force a verdict. No release route exists.

Exact persisted FINAL receipt bytes are replayed without reconstruction or local
regrading, including older-version receipts, so an uncertain acknowledgement can
be reconciled by the server. Changed receipts never replace the original. When
resuming v0.2 active work without a receipt, old unbound local evidence is retained
privately as previousEvidence, then re-read with the same source/token rather
than relabelled as verified current evidence. Expired work still fails closed.

Source API calls are not independently paid review milestones. Review limits,
qualification, terminal settlement and any separately authorized real-USDC pilot
reward follow their original policy. A retry creates no additional reward or
payment; a 200 source/receipt acknowledgement is not a token transfer.
