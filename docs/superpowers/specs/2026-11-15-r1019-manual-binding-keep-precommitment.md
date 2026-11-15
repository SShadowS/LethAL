# R1019 pre-commitment: keep the serve daemon after the manual-binding cascade (coord PR-14 part 1)

Lane lethal-bugs, 2026-11-15, committed before any gate or corpus re-run of the change. Split agreed with lethal-code (keep-list
owner): lethal-bugs measures and builds, code reviews `lethal/pr-14`.

## The change

`V3_SERVE_SAFE_REFUSALS` gains `cascade-manual-binding`, exactly the text al-runner gives when a test failed while it held a
manual event subscription and the next test's bind is refused:
`NotRun: out-of-scope: a test before this one in the codeunit did not pass (<test>: failed (<message>) and left a manual event
subscription bound that it would have unbound later: the bindings this test starts with are not BC's; this failure is not
trusted: The binding of codeunit <N> was unsuccessful. The codeunit has already been bound.` The failing test's part is a
`SAFE_TAIL` (a timeout or panic word there closes); everything after it is fixed.

Leg C's `serve-keep-reasons` gains one invented case (codeunits 50683 publisher, 50684 manual subscriber, 50685 with
`A_BindThenFail` and `B_BindAgain`), judged by the new entry: 14 entries, sixteen codeunits, eighteen tests.

Basis: R-967's kit on edge-5a58a0f16 (`/coord/handoff/PR-14/probe/README.md`): on one kept daemon 72 reader answers after
refusals all equal the control, 20 fresh daemons equal it, the pid unchanged, no panic text, under isolation "test" and
"codeunit"; a passing test that never unbinds measured the same (code's request).

## Predictions

1. `itest:alrunner-v3` on `current` (edge-5a58a0f16) passes every leg. Leg C's `serve-keep-reasons` reads `matches`, its
   `measured` naming `cascade-manual-binding: refusal` and "all 14 entries". No other pinned verdict, figure or leg outcome moves.
2. Filter Tokens re-run (same config `/coord/handoff/PR-03/v3.filtertokens.json`, same build, fresh store, the change's head):
   - serve daemon closes by the manual-binding cascade: 0 (PR-03 run: 424);
   - serve daemons at most 60 (PR-03 run: 466);
   - every mutant both runs report has the same verdict and killing test as the PR-03 run (`/coord/handoff/PR-03/
     filtertokens.v3.events.ndjson`: 214 killed, 108 survived, 8 timeout-killed, 13 error, 10 no-coverage). Any difference is a
     BLOCK.
