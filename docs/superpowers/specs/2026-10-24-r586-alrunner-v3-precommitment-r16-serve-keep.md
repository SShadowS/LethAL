# R586 / R705: pre-commitment r16 (a delta to r15): leg C's `serve-keep-reasons` fact, redefined

Delta to `docs/superpowers/specs/2026-10-24-r586-alrunner-v3-precommitment-r15-alpha5.md`. Everything in r15 stands
except what is named here. Commit this file alone, as `docs/superpowers/specs/2026-10-24-r586-alrunner-v3-precommitment-r16-serve-keep.md`
(r16: the next free number after r15, checked against origin/master), `[skip ci]`, before the offline alpha.5 run and
before any live run. The offline run counts as one heavy job. Nothing about alpha.5 was
measured to write it.

## What changes in the fact (committed before the code)
`serve-keep-reasons` (warn, `V3_WARN_FACTS`, gate-only) keeps its name, kind and registration. Its content:

| | Before (r15) | After (R705) |
|---|---|---|
| Tests in the one `serve` request | 5 codeunits: 50670 Http, 50671 Commit, 50672 Cascade, 50673 OnRun, 50674 NoCallee | **4 codeunits (five tests)**: 50670-50673. Codeunit 50674 is deleted |
| `V3_SERVE_SAFE_REFUSALS` entries | 5 | **4**: `no-callee` removed. `http`, `commit`, `cascade`, `onrun-failed` unchanged |
| A case is OK when | the row is a `notRun` `error` refusal matching its entry | the same, OR (http and cascade only) a plain trusted fail: `status fail`, `notRun` not true, no v3 refusal marker; for cascade also `message === "later"` (LaterFails' own failure) |
| `measured` on a match | `all 5 entries match` | `the keep rule accepts every row of all 4 entries (http: <how>, commit: <how>, cascade: <how>, onrun-failed: <how>)`, `<how>` = `refusal` or `plain fail` |
| Missing row, pass row, `notRun` fail, unlike refusal, commit/onrun-failed as plain fail | MOVED | MOVED (unchanged) |

Why no-callee leaves: a #5602-fixed build refuses a request whose apps do not compile and returns no rows. The
fact must not read "no row" as fine. A fixed build cannot produce the row, so no gate can pin it. On alpha.2 the
entry was real; with it gone, such a row closes the daemon (slower, never a different verdict). In serve-entries, a
warm-up whose every entry refuses with one identical no-callee text now throws
`al-runner-v3-entries-batch-refused`: the safe direction, opt-in and rare.

## What r16 supersedes, by name
1. r15's sentence "If alpha.5 is ever admitted, `.gated.warnFacts["serve-keep-reasons"]` will read `diverged`" (section
   `serve-keep-reasons`, last paragraph). That was a statement about the old, blind probe and no longer holds as a
   prediction. `.gated` stores only the verdict word, never the measured text, so the `gate.log` is the record of
   which branch (refusal or plain fail) each entry took.
2. R705's close option "the http text and the cascade case ... need new pins or removal, each by a delta". r16 does
   neither: it tolerates both as plain trusted fails and keeps their regexes.
Also, R705's "alpha.3 (#5602 present)" means the bug was still present (alpha.3 is before the fix), reading `matches`.

Why http and cascade are tolerated rather than re-pinned or read per build: on #5602-fixed builds the localhost call is
a plain `fail` (r15, `refusal-row-shape`) and `LaterFails` is a trusted `fail` (`refusal-cascade` is `gone`). The
daemon rule keeps such rows without any entry. The fact says which branch matched, so a receipt shows the kind of
build without a build test in the code. No new regex is added.

The probe's five-to-four change makes the old r15 sentence about alpha.5 ("all five read MOVED no row") a statement
about the OLD probe. It is not an upstream difference (r15 §"Candidate upstream differences" item 4 stands: nothing to file).

## Leg C fact set
Unchanged: 28 facts, 9 defect, 18 contract, 1 warn. Only the warn fact's content moves. `V3_WARN_FACTS` is still
`["serve-keep-reasons"]`. No fact is added, removed or reclassified.

## Expected readings per build

### alpha.2 (`alrunner 3.0.0-alpha.2 (91253f2d6)`, the current pin): PREDICTED, `matches`
- `serve-keep-reasons = matches | the keep rule accepts every row of all 4 entries (http: refusal, commit: refusal, cascade: refusal, onrun-failed: refusal)`.
- Basis: r12-r14 and the regate log `/work/tools/al-runner-v3/regate/befe8024....gate.log` line 28 read all five
  entries `matches` with the same four rows; the removed fifth test was in the SAME request, and alpha.2 returned
  its four other rows alongside it. Removing an uncompilable-by-design test does not change the other four rows
  on a build that has no #5602 fix (the rows came back with it present). Residual risk: the four rows' texts come
  from the same one daemon whose request now has one test fewer; the text of a row does not depend on its sibling.
- `.gated.warnFacts` = `{serve-keep-reasons: matches}` on a pass.

### alpha.5 (`failed/v3.0.0-alpha.5@6eddda0b…/al-runner`), offline leg C only: MEASURED AFTERWARDS AND REPORTED, NOT JUDGED HERE
What IS predicted (structure, not text):
1. **Rows come back.** All four tests compile (50670-50673 hold nothing the checker cannot resolve; they compiled on
   alpha.2 and alpha.3, and the one-shot facts on 6eddda0b already compile similar code). So the reading is no
   longer `no row` for any of the four. If any of the four still reads `no row`, that is a finding to report, not a pass.
2. **Not predicted: the reading itself.** The facts known from r15 (one-shot) are: http = plain fail, cascade = plain fail
   (`later`), commit = unchanged refusal (second wording), onrun-failed = unmeasured. Serve rows may differ from
   one-shot rows (the entry text, the exit code, `notRun`). The most likely reading from one-shot alone is
   `matches (http: plain fail, commit: refusal, cascade: plain fail, onrun-failed: refusal)`. This is a guess from
   one-shot facts, not a prediction. The result is recorded in `/coord/handoff/R-705/alpha5-legC.log` and in R705's Done section, and the
   outcome of the offline run is NOT a pass/fail of this pre-commitment.
3. Leg C's classification on alpha.5 is not part of this run's judgement: r15 B/C already predicts `gate-fail`. The
   offline run exits non-zero for that reason; the serve fact line is printed before.
4. A reading of `diverged` on alpha.5 after the fix is NOT a BLOCK. It would be the first real measurement of alpha.5's
   keep reasons, and it feeds R-586c (a K / serve measurement on alpha.5 stays its prerequisite). Do not move any pin,
   regex or flag after seeing it without a further delta.

## The full v3 gate on the final head with alpha.2: PREDICTED, every leg passes
`LETHAL_ITEST_ALRUNNER_V3=1 bun run itest:alrunner-v3` (all default legs, alpha.2 via `current`) on the final head:
- C: `pass`, 28 facts: 9 defect all `defect-present`, 18 contract `matches`, 1 warn `serve-keep-reasons` **`matches`** (the line
  above). The same classifier lines as r15 section A.
- S1, S3, N1, X, L1, Y-A, Y-B, MO, WR, D1, D1c, T, K (K outside `V3_GATE_LEGS`): the figures of r15 table A, unchanged.
  Nothing in this change is on those legs' path: `V3_SERVE_SAFE_REFUSALS` is read by the serve-entries transport (K and the
  entries legs), where a no-callee row does not occur on the fixtures (every test compiles).
- `gate-pages.test.ts` stays green once `docs/gates/alrunner-v3.md` says four. No baseline file moves.
- `itest:bcdev`, `itest:lease`, `itest:tables`, `itest:chunked` (the other legs `selectLegs` picks for `packages/runner/`):
  unchanged figures, each per mutant, on the server their proof table lists. Any difference is a BLOCK.
If `serve-keep-reasons` reads anything but `matches` on alpha.2 after the change, that is a BLOCK (a regression
in the probe or the daemon, not a result).

## Tests committed with the build (red first)
In `al-runner-v3-contract.test.ts`, `al-runner-serve-rule.test.ts`, `al-runner-v3-entries.test.ts`:
old-build reading (four refusals -> `matches`, `measured` says `refusal`); fixed-build reading (http and cascade plain fail,
commit and onrun refusals -> `matches`, `measured` says `plain fail`); narrow tolerance (commit plain fail, http pass,
http `notRun` fail, http with the refusal marker -> `diverged`); the probe app holds no 50674 / `NoSuchProcedure`; a no-callee
row closes the v3 daemon (serve rule) and in the serve-entries transport (T4). Each piece red-checked alone (the plan lists five reverts).

## Open question for the owner
The offline alpha.5 run needs leg C alone to work with `LETHAL_ITEST_V3_LEGS=C` and a candidate path. If it refuses, the
builder reports the refusal and does not patch around it.
