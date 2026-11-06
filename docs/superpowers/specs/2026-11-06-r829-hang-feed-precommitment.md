# R829 pre-commitment: the hang refusal follows a loop's feeds (GitHub #50, coord task R-818)

Build: `lethal/r818` at 08605e4d, dumped against master's cached dump at e3b53bfc (production identity keys, every operator).
`packages/builtin-tier1`, `engine` and `schemata` did not change on master between that dump and this build's base.
The dumps ran after the v3, lend and hang gates. Those gates rest on the fixture set, and no fixture key moves; the corpus figures
below do not touch them.

## Rule
A loop condition that does not name a cursor method now gets `indirectFeeds`, to a fixpoint, by name, with the guards around a
followed assignment. Before, only a name-free condition did (R480's boundary B1). Over-refusal is accepted: a wrong refusal loses
one mutant, a miss can end a run.

## Figures, frozen
| corpus | specs | hang-refused | removed | ordinals moved |
|---|---|---|---|---|
| fixtures (25) | 2131 = | 2 = | 0 | 0 |
| CDO | 57226 > 57189 | 471 > 508 | 37 | 4 |
| DO | 80778 > 80740 | 579 > 617 | 38 | 3 |
| DC | 199146 > 199026 | 2485 > 2605 | 120 | 14 |
| BC.History (519) | 2322798 > 2322158 | 64665 > 65308 | 640 | 77 |

Every set: 0 keys added, 0 tags moved, 0 tuples moved, 0 errors.
BC.History's hang-refused rises 643 for 640 specs. The other 3 sites are in `Email - Outlook REST API`'s Source project, in a file
that cannot be instrumented: they move from `skipped` (570 > 567) to hang-refused, and no spec is lost there.

By operator:
- CDO: remove-assignment 25, shift-integer 3, swap-additive 4, swap-call-arguments 5.
- DO: remove-assignment 26, shift-integer 4, swap-additive 5, swap-call-arguments 3.
- DC: flip-boolean-literal 11, remove-assignment 84, shift-integer 2, swap-additive 18, swap-call-arguments 5.
- BC.History: flip-boolean-literal 13, remove-assignment 421, shift-integer 34, swap-additive 70, swap-call-arguments 102.

Site lists: `/coord/handoff/R-818/evidence/removed-FINAL-<set>.tsv`.

## Scheme
Ordinals move, so `IDENTITY_SCHEME` goes 43 > 44. Ruling (orchestrator, 2026-11-05): R829 lands first; R810 keeps its 12 baselines
and records them once at 44. No fixture key moves, so R810's pinned record stands.

## Not sampled
The over-refusal sample in R829 (DC 17, BC.History 15) was taken before the guards were added. The sites the guards add (about
54 on DC, about 180 on BC.History) were not sampled.
