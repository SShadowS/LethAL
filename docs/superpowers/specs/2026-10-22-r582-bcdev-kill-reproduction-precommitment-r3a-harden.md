# R582 pre-commitment r3a: one corrected count in `itest:harden`'s row (a delta on 39eaf536)

Written 2026-10-22 by the lane, after `itest:harden`'s first R-582 run and BEFORE its re-run. Everything in r3
(`2026-10-22-r582-bcdev-kill-reproduction-precommitment.md`, 39eaf536) stands except the one cell below.

## The miss, recorded

`itest:harden` on bc2, head 7a8ff82c (`/coord/handoff/R-582/gate/bc2/harden.log`) PASSED its own checks:
- leg A: 16 / 5 / 0, every kill reproduced (2 killer rows each);
- leg B (`sandbox-harden-answers`): **18 killed / 3 survived / 0**, every kill reproduced, S1 to S4 killed by name, S5
  survives.

r3's §4 harden row says the kills that must carry `killReproduced` are "A 16, B **20**". That cell is wrong. Leg B
had 18 kills BEFORE R-582 as well: R-604 measured leg B at 18 / 3 / 0 on bc2
(`/coord/handoff/R-604/bc2-harden.c23.log`, `[leg B, sandbox-harden-answers] killed=18 survived=3`). The "20" was copied
from `itest:agreement`'s leg B (20 / 1 / 0, C02-08), which is a different suite. No gate code asserts it. No verdict
moved.

By §2 a differing figure is a BLOCK, so the first run is recorded as BLOCKED on a pre-commitment counting error. It is
not a regression.

## The correction

§4, `itest:harden`, "Kills that must carry `killReproduced`": **A 16, B 18** (not B 20). Everything else in the row,
and in r3, is unchanged. `itest:agreement`'s row keeps "B 20": its fresh B is 20 / 1 / 0, before R-582 (R-604) and on
this run (`/coord/handoff/R-582/gate/bc2/agreement.log`, step 4).

## What follows

`itest:harden` is re-run ONCE on the same build head, after this file is committed. It must reproduce leg A 16 / 5 / 0
and leg B 18 / 3 / 0 per mutant, with every kill reproduced. Any other difference is a BLOCK. The harden gate page's
"B's 20" becomes "B's 18".
