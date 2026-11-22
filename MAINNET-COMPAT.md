# Mainnet-ready: re-vendored against connector v0.3.0

Pinned target: `VAN-Network/van-connector@466c82fa5e50484e64479616b4e2a54db21b767c` (v0.3.0, adds the
explicit `mainnet` profile, deployment-descriptor checks and per-network state binding).

`test/vendor/src` now holds the v0.3.0 sources verbatim instead of v0.2.1. Two behavioural differences
matter for this pipeline and neither is cosmetic:

1. `reviewer.mjs` stores `deployment: STATE_CONTEXT` inside `active.json` and calls
   `requireStateContext(active)` on load. A work item created under a different deployment is refused
   rather than sent. Testnet work cannot be replayed on mainnet by construction, which is what VAN's
   guide asks for.
2. `review-proof.mjs` now embeds the deployment in `proofContext`, so retained evidence is bound to
   (environment, profile, chain, audience) rather than to the dispatch token alone.

## Verification on this machine (Node 24.22.2, Linux)

```
VAN_NETWORK=testnet node --test     -> tests 60, pass 58, fail 0, skipped 2
VAN_NETWORK=mainnet node --test     -> tests 60, pass 58, fail 0, skipped 2
VAN_NETWORK=mainnet node test/e2e-live.mjs
                                   -> RESULT: PASS (3 scenarios: ACCEPT / REVISE / INCONCLUSIVE,
                                      real model, real HTTP fetch, receipts re-validated by
                                      the connector's own receiptFor)
VAN_LIVE_JUDGE=1 VAN_NETWORK=mainnet node --test test/calibration-replay.test.mjs
                                   -> 3/3 pass, six documented rubric cases reproduced 6/6
```

The two skipped tests are the live-model ones, which are run explicitly above rather than counted as
passes.

## Upstream defect found while doing this

`test/onboarding.test.mjs` hardcoded `mkdtemp('/private/tmp/...')`, so `npm test` reported 2 failures on
Linux for reasons unrelated to the protocol. Fixed and submitted:
https://github.com/VAN-Network/van-connector/pull/1 (29/29 after the change).
