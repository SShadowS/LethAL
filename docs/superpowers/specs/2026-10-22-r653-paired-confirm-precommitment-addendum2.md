# R-653 pre-commitment, addendum 2: the final head (before any final-head leg ran)

Base: `docs/superpowers/specs/2026-10-22-r653-paired-confirm-precommitment.md` (master 2500dbd3) and addendum 1
(ed20b2fb). Committed to master by lethal-code before any leg below ran.

## 1. The final head

- **`lethal/r653` at 1b4706c6.** That is the reviewed build 0dda9a84, its two empty CI commits, and master 5255bef8
  merged in, which carries R-654 S1, R-659 and R-660. The merge had no conflict. In al-runner-v3-backend.ts, S1
  changed only import lines.
- **Unit checks on this head:** verify PASS, 10098 pass / 8 skip / 0 fail. `r654-v3-imports.test.ts` passes 4 of 4,
  so R-653 adds no import from a v2 module. CI run 39833644683 was started on this head.
- **The early run** (head 0dda9a84, `/coord/handoff/R-653/live/results-early.md`) found no STOP. It is evidence
  only. R653 closes on this run.

## 2. What runs

Every leg in base §1, judged by base §2-§4 with addendum 1's relations:
- E0-S, E1, E0-T, E2, E0-D, E3a and E3b, each with its report-diff against R-652 (seven in all);
- then V2, `itest:alrunner --parallel=3`, against its frozen baselines.

The driver is `/coord/handoff/R-653/live/chain.sh` with `FULL=1 HEAD_SHA=1b4706c6`. Outputs go to
`/coord/handoff/R-653/live/final/`, so they are kept apart from the early run.

**The V2 leg on this head.** S1 moved v2-shared helpers into neutral modules. Its own pre-commitment (4e8d9f38)
pins every gate as unchanged per mutant. So V2 is expected to PASS against its frozen baselines, exactly as base §1
says. Any difference is a BLOCK on this head, and it is traced to S1 or R-653 before anything else.

Nothing else changes: the figures, the gain ranges and the STOP rules are as in the base and addendum 1.
