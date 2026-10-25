# R-762 B pre-commitment, addendum 1 (lane bugs, 2026-10-25): the new edge pin a157b2d34

Committed before lethal-spare's R-771 pins `edge-a157b2d34` and before any gate run on that pin. The pre-commitment
(`2026-10-25-r762-b-retire-sleep-rule-precommitment.md`, master 8ea1cfcc) is not edited.

## The build
al-runner `3.0.0-alpha.5+edge.20261025 (a157b2d34)`, sha256
`d9429e53a6938dbafb58108f61ce5408f65389bd9604ff94b4788ef26c8d17fb` (held by the update gate at 55a1466b; receipt
`/work/tools/al-runner-v3/held/edge-a157b2d34/receipt.json`). R-771's readings (lethal-spare): leg C equals
dcdf9e821's pin exactly, including `sleep-is-noop` = gone (N=3: 46 ms; ShortSleep pass; LongSleepA error; no flag under
1 s) and `duplicate-key-insert-raises` = refused; X (b) exit 3, passed 0, notRun 0; T the same 7 keys to
error/runner-refused; the only new reading is N1E (#5798 fixed upstream; LethAL's serveRow still refuses a dotted
method by name, fail-closed, pinned by R-771).

## Predictions extended to this pin (any miss is a BLOCK)
The pin `edge-a157b2d34` shares `ALPHA5_READINGS`, so R768's switch (`sleepRuleRetiredFor`: the pin AND the session probe
read `sleep-is-noop` gone) applies to this build exactly as to edge-dcdf9e821:
- Leg X (d) on `Probe Sleeper`: M0001 killed (SleeperDoubles), M0002 survived, M0003 survived (no note), M0004 survived
  (no note), M0005 killed (SleeperDoubles); counts 2 killed / 3 survived / 0 error; Sleep index 4 + 5; "Sleep rule
  RETIRED" printed; no coverage document written by a mutant call.
- Leg X (e), (f1), (f2), (f3): "not applicable on a pinned-gone build", printed, never skipped silently.
- Every other leg figure on this pin is whatever R-771 pins for it; this addendum claims nothing about N1E or the other
  legs beyond "R768 moves none of them".
