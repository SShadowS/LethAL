# R-652 pre-commitment, addendum 1: leg T on the merged head

Committed by lethal-code on 2026-10-22, before the run it names. It amends `2026-10-22-r652-bound-per-send-precommitment.md`
(58a8266b).

**What reruns.** E0-T and E2 run again on lethal/r652 at 6974404f (master cdb9bf87 merged), with the same figures as
before:
- 7 pre-named errors;
- 0 per-mutant differences between E2 and E0-T;
- E2 `boundChecks` 607.

**Why only these two legs.** The merge brought R-650's dd7215d0, which changes how leg T's held path is judged
(`bareHashRows`). R-592b's store change does not touch any gate leg, because none of them lends. All other legs stand
from 58a8266b.
