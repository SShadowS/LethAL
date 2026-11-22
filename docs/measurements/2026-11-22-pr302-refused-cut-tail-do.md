# PR-302 (2026-11-22): `alRunnerV3.refusedCutTail` measured on DO, flag on (t1) against c2

lethal-preproc. Pre-commitment: `docs/superpowers/specs/2026-11-22-pr302-refused-cut-tail-do.md` (and amendment 1). The BC sample
was recorded before any BC call: `docs/measurements/2026-11-22-pr302-bc-sample.md`. Evidence: `/coord/handoff/PR-302/`. Numbers
and names only.

## What ran
- **t1:** a full DO run from master f92e87c8a (PR-297, PR-292 and PR-307 in HEAD), main-ccd0f823d (sha256 checked by the
  script), c2's settings, `refusedCutTail: true`, `ciSessionKind: client`, `--peak 24`.
- **The first leg** was stopped at 01:48:48Z by my own watchdog, after 1,099 mutants. It counted active page cache as used
  memory; that was fixed, then R1172 / PR-323. The resume (t1b, `--resume`, the same store, head and settings) ran 06:49Z to
  12:11:50Z, rc 0. The resume's report holds all 43,511 mutants. The resume repeated the end-of-baseline stability pass.
- **6 of 8 lanes** started, at 4.0 GiB per lane.
- **OFF arm:** c2 (the flag absent). Master's code commits between c2 and t1 move no DO verdict (pre-commitment).

## The void check: passed
- Stability (the green tail tests stable alone, from the notices; the same in both legs): 68874 1 of 1, 68906 12 of 12, 68975 49
  of 49, 68984 20 of 21 (1 unstable).
- 68959 has a cut and 0 green tail tests; it is outside the sizing and wins nothing back.
- Tail alone calls: stability 83, under a mutant 29,864.

## Verdicts, t1 against c2, per mutant (43,511 joined, 0 mutantCode differences)
- **c2:** no-coverage 26,676 / survived 8,536 / killed 6,500 / **error 1,793** / timeout-killed 6.
- **t1:** 26,676 / 9,291 / 6,725 / **812** / 7.
- **Inside the 1,590 named cut-error mutants:** 984 left `error`: 755 survived, 228 killed, 1 timeout-killed. 606 stay `error`
  (68984: 601, 68975: 5).
  - Per codeunit: 68874 (7 killed, 47 survived), 68906 (13 / 83), 68975 (121 / 338, 1 timeout-killed, 5 error), 68984 (87 / 287,
    601 error).
- **Tail kills:** 229 moves to killed or timeout-killed.
  - 226 carry the PR-297 note. The other 3 (M12658, M12661, M12671) are killed by a test of ANOTHER codeunit (c2's class-A named
    set), not through the tail.
  - 228 are reproduced. The 229th is the timeout kill (M13125), noted, and confirmed the timeout way.
- **Outside the 1,590: 3 moves, all `killed -> error`** (M2519, M2548, M2549). Filed as R1178. They are NOT a flag effect.
  - **CORRECTED 2026-11-22:** this note first said they came from the flag through R197's ledger. That was wrong.
  - **In c2,** the walk scored them `error` too, and PR-144's withheld-kill recheck made them `killed`.
  - **In t1,** the first leg was stopped by my watchdog, so its recheck did not run. The resume re-walked them with an empty
    ledger (carried kills), read a plain refusal first, and that note is not recheck-eligible.
  - **The defect** is that recheck eligibility depends on walk order, flag on or off. Its fix is coord PR-341.
  - **By the pre-commitment** this is a move not named from the master-commit list, caused by the stop and the resume. It
    is named here, and it does not touch the flag.

## BC check (lethal-bugs, bcdev on bc4, BC 29: done, all 228)
The sample was 100 of the 228 `error -> killed` moves, seed 302 (68874: 3, 68906: 6, 68975: 53, 68984: 38), 35 marked
session-dependent. It found 1 contradiction, so the check escalated to all 228.

| part | rows | kill confirmed | contradiction | killed on BC by another test | named test not run on BC, survived | not judgeable |
|---|---|---|---|---|---|---|
| unmarked | 142 | 136 | **1** | 5 | 0 | 0 |
| not listed in the sample (counted with unmarked) | 8 | 4 | 0 | 0 | 4 | 0 |
| marked session-dependent (PR-299) | 78 | 0 | 0 | 0 | 2 | 76 (no coverage on headless BC) |

- **The 1 contradiction is an al-runner false kill, not a flag effect** (upstream #8721). The killing test passes on BC. It
  needed the flag only to run at all: in c2 its codeunit is cut, so the test never ran under that mutant. An invented repro
  (one row copied twice in one test, then a Modify with no Find) gives al-runner's "not up-to-date" error in a plain test,
  where BC accepts it.
- **4 kills are not confirmed and not contradicted.** BC's coverage says the named test does not reach these mutants, so BC never
  ran it under them. One test's name suggests a session effect that PR-299 does not list. Open.

## Cost and R1156
- **Bound checks:** the resume made 34,619 checks, 282 ms each (t1's first leg: 270 checks, 269 ms), for 9,777 s in total.
  c2 made 4,679 checks at 218 ms, for 1,022 s.
  - Every tail alone call is its own send, with its own bound check. So the flag's main cost is bound checks, about 8,700 s
    more, not test time.
- **R1156's live claim** (under 130 ms per check at 6+ lanes, with PR-292's worker): **MISSED**, 282 ms at 6 lanes. A
  reading, not a verdict on the worker alone: the tail route made the checks 7x more frequent.
- **Mutant phase** (the resume leg): 14,397 s for 15,798 covered mutants, 0.91 s per covered mutant (c2: 0.71 at 5 lanes).
  Not a like-for-like speed claim: the resume repeated the baseline and stability pass, and the tail calls added work.

## So
- The flag wins back 984 verdicts (error 1,793 -> 812) on DO.
- On BC, 140 of the 150 unmarked and unlisted kills are confirmed (136 plus 4), 5 more are killed by another test, and 1 is
  an al-runner false kill (#8721). The other 78 cannot be judged on headless BC.
- **The ruling (orchestrator, 2026-11-22):** `refusedCutTail` becomes the default together with PR-344's packing, not before.
  Without packing, the flag costs about 9,777 s of bound checks per DO run. PR-344 packs a mutant's tail alone calls into one
  send (spec `docs/superpowers/specs/2026-11-22-pr344-pack-tail-alone.md`). Its submit flips the default and closes R1160.
