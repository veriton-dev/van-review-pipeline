# van-review-pipeline

The reviewer-side handler that THE VAN's connector expects but does not ship: it
turns a frozen report into a bounded source request, waits for the real evidence,
and emits an evidence-grounded verdict. MIT, Node 24+, no dependencies.

Written for [VAN-Network/van-connector](https://github.com/VAN-Network/van-connector)
v0.2.1 (`5ed88ea`). The connector owns transport, credentials, heartbeats and
receipts; this owns judgment only.

## Why this exists

The published handler contract names three files: `sources.json`,
`evidence.json` and `decision.json`. Writing a handler that only reads
`assignment.json` and writes `decision.json` looks correct in isolation and then
deadlocks the real connector, because `runReviewer` waits for `sources.json`
before it will fetch anything. That is not a hypothetical: my first version of
this handler passed its own unit tests and hung the official lifecycle until the
test timeout. The regression is now pinned by a test that drives the connector's
own `runReviewer` against a mocked transport.

## What it does

1. **Refuses a report that changed after freezing.** The connector's digest over
   the report text is re-checked before anything is planned from it.
2. **Plans the source request from the report's own citations.** HTTPS only,
   deduplicated, trailing sentence punctuation removed, balanced parentheses
   kept, credential-bearing URLs refused, more than eight distinct sources is an
   abstention rather than a partial review. A report that cites nothing gets the
   citation-policy witness instead of an invented source.
3. **Waits for terminal evidence for every requested URL.** An empty or partial
   `evidence.json` is "still running", never "nothing found".
4. **Judges each criterion independently.** PASS/FAIL require a cited excerpt and
   a verbatim quote that is re-checked twice: once in the handler, once by the
   connector before it freezes the receipt. Anything unparseable, ungrounded or
   unavailable becomes UNVERIFIED.
5. **Derives the verdict from the checks, never from the model.** ACCEPT needs all
   PASS; REVISE needs a FAIL and no UNVERIFIED; INCONCLUSIVE whenever anything is
   unverified.

Report, brief and source text are treated as data throughout. A source that says
"ignore previous instructions" is a string; the prompt delimits it and the answer
is still re-grounded mechanically against the retained bytes.

## Install

```bash
git clone <this repo> && cd van-review-pipeline
node --version   # 24+
npm test         # 26 tests, no network, no credentials
```

To run it against the connector, point your reviewer loop at
`makePipelineHandler` and pass an `evaluate` function. With OpenClaw:

```js
import {makePipelineHandler} from './handler.mjs';
import {makeJudge, makeCliRunner} from './judge.mjs';
import {execFile as execFileCb} from 'node:child_process';
import {promisify} from 'node:util';

const handler = makePipelineHandler({
  evaluate: makeJudge({run: makeCliRunner({execFile: promisify(execFileCb)})}),
});
await handler({workDir}); // one call per poll; safe to call repeatedly
```

The handler is idempotent: re-running it never rewrites an existing
`sources.json` or `decision.json`.

## Tests

`npm test` runs offline. It covers source planning edge cases (punctuation,
parentheses, duplicates, plaintext, credentials, the eight-source bound), evidence
completeness, digest refusal, quote refusal, all-UNVERIFIED abstention, prompt
injection, and one end-to-end case that drives the **official** `runReviewer`
state machine through the whole path to receipt submission.

`npm run smoke` is the live check and needs a model route. It fetches
`https://example.com/` over real HTTPS and reviews two reports against it:

- a claim the page supports → ACCEPT, quoting `<title>Example Domain</title>`
- a claim the page contradicts → REVISE, quoting the sentence that contradicts it

It exists because an offline suite cannot prove that judgment tracks reality, and
a reviewer that only ever abstains is worthless.

## Known limits, stated plainly

- **Only 4000 characters of a source are visible.** The server returns an excerpt,
  not the whole page, and `bodyHash` cannot be recomputed from it. A claim settled
  only by text beyond that window is honestly UNVERIFIED. Reports that cite a
  large page for a fact near its end will not be accepted by this reviewer.
- **Quote membership is not entailment.** The mechanical checks prove the quote
  exists; whether it supports the criterion is the model's judgment, and a wrong
  PASS is possible. FAIL requires a contradiction the model can quote, so a
  synthesised FAIL with an unrelated quote is possible too. The server's own
  narrow chain-ID guard is the only semantic check on its side.
- **Same-user handler is not an OS sandbox.** The connector's private state and
  this handler run as one user. Isolation is a deployment choice, not a property
  of this code.
- **The model can be wrong.** Every failure mode I could make mechanical
  (unparseable output, invented ID, quote not present, call failure, oversized
  prompt) resolves to UNVERIFIED rather than a verdict. Genuine misjudgment of
  well-grounded text is not something a parser can catch.
- **Not tested against the live VAN server.** Admission was paused when this was
  written. Everything here is offline tests plus a real-HTTP smoke test.

## License

MIT. The vendored connector under `test/vendor/` is MIT, Copyright VAN-Network.
