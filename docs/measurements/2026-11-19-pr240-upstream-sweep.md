# Upstream sweep of the roadmap items that wait on al-runner (coord PR-240, 2026-11-19)

lethal-preproc. Read-only: GitHub reads of `aldevtools/BusinessCentral.AL.Runner` (issues, timelines, PRs, and
`compare/<fix>...4ebfe7913`), no repro run. Names and issue numbers only.

- **`current`** = `al-runner 3.0.0-alpha.14+edge.20261115 (4ebfe7913)`; upstream's `edge` tag still names 4ebfe7913.
- **Upstream main** = 310a9daef (2026-11-19 18:01), 506 commits ahead of `current`.
- **Classes:**
  - A: fixed in `current` (a repro re-measure on `current` may close the item);
  - B: fixed upstream, not in `current` (waits for the next pin move);
  - C: still open upstream, or no fix found.
- **Result: no item is class A, so none closes now.**

| item | upstream | state | fix | in current | class |
|---|---|---|---|---|---|
| R933 | #7811, #7812 | #7811 closed (fix 82e39010a); #7812 reopened 11-19 (control characters 0-31; TAB fixed by 39fa31610) | both fixes in current | ahead | C (#7812) |
| R936 | #7818, #7819 | open | none | - | C |
| R942 | #7922 | open | none | - | C |
| R946 | #7853, #7854 | #7853 closed (fix 2b30e6689, in current); #7854 open | - | ahead | C (#7854) |
| R993 | #8027 | open | none | - | C |
| R994 | #8032 | open | none | - | C |
| R995, R1011 | #8036 | open | none | - | C |
| R997 | #8038 | open | none | - | C |
| R1003 | #8056 | open | none | - | C |
| R1010 | #7760 | open | none | - | C |
| R1048 | #8160 | open; PR 8166 (d0155ce2e, "Refs") merged 11-17 | not in current | behind | B (partial: needs #8166 plus the installed-apps flag) |
| R1092 | #8244 (+ #8204, #8211 open) | #8244 closed 11-19 (PR 8485, b805a9561, opt-in `coverage:"hit"`) | not in current | behind | B for #8244 |
| R1098 | #8210 | closed 11-19 (PR 8484, f7b156fb4, `stopAfterFirstFailure`) | not in current | behind | B |
| R1099 | #8204, #8211 | open | none | - | C |
| R1116 | #8267 | open | none | - | C |
| R1126 | #8333 | open | none | - | C |
| R1140 | #7760, #7764, #8036, #8486 | open | none | - | C |
| R1146 | PR 8484 | merged 11-19 (f7b156fb4) | not in current | behind | B (its trigger) |
| R1149 | #8239 (P2) | open | none | - | C |

**Notes.**
- R098 (#1656, a merged PR in the retired .NET repo) is already done; not part of this sweep.
- R1149 cites `#8149` by number in one place; its blocker is #8239 (#8149 is an unrelated merged corpus-bump PR).
- R1146 and R1098: upstream's `stopAfterFirstFailure` is scoped to the request, stopping "later tests of its codeunit and
  every later entry of the request", each codeunit on its own: not the fork's per-group `stopGroup`. R1146's pre-committed
  re-measure on the first `current` that has it still decides.
- The repro ids per issue are in `scripts/upstream-repros/manifest.json`; R1092, R1098, R1099, R1146 and R1149 have none.
- **The next pin move past f7b156fb4, b805a9561 and d0155ce2e** should re-measure R1048, R1092 (#8244's part), R1098 and
  R1146; the class-B items say so.
