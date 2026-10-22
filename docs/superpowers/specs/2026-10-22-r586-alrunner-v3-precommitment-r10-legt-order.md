# R-586 pre-commitment r10 (R-647): leg T classifies and prints before it judges, and X (d) stays a gate-fail on a timed-out baseline

This file is final as of 2026-10-22. It was revised after the delta review (`/coord/handoff/R-647/review-r10-delta.md`,
ADOPT with fixes; I1-I5 and M1-M7 applied). Lane bugs committed it to master before any R-647 code and before any live
run.

It is a delta on r9 (`2026-10-22-r586-alrunner-v3-precommitment-r9-bc-readings.md`, 4995b8f6). Everything earlier
stands, except what is below. A differing verdict in any leg is still a BLOCK.

Evidence:
- the diagnosis, `/coord/handoff/R-647/diagnosis.md` (findings A and B);
- the kept rejudge, `/work/tools/al-runner-v3/rejudge/edge-57f1e4f98@711c94d9…/`;
- R-635's E0-T session reports, `/coord/handoff/R-635/live/control/T.report.json` and `live/run2/control/T.report.json`.

## Why

**Leg T.** The edge rejudge at 711c94d9 gate-failed leg T on its counts: 290 / 50 / 59 with 7 errors, against the
pre-committed 290 / 57 / 59.
- In `legT`, `assertCounts` runs BEFORE `classifyLegT`. Every move that r9 §7 holds changes a count, so r9 §7's `held`
  could never be reached.
- R-647's diagnosis ran `classifyLegT` offline on R-635's two E0-T reports, which used the same edge binary. It reads
  `held`.
- Exactly 7 rows move, `survived -> error / runner-refused`: M0157-M0159 and M0161-M0164, the 7 pinned #5603 rows.
  Nothing else moves.
- The leg printed no row, so the mutant ids had to come from another lane's report.

**X (d).** The same rejudge gate-failed X (d): all five mutants read `no-coverage`.
- The cause is inferred, from the code and from leg C's measured `sleep-is-noop = gone`.
- On edge a `Sleep` counts toward the time limit. So `SleeperDoubles` (`Sleep(600000)`) times out at its 120 s
  baseline and covers nothing.
- The gate log does not show the baseline verdict that would prove it.

**r9 prediction B's misses (M6), recorded:**
- **X:** r9 B predicted "(d)-(f) unchanged". Measured: (d) gate-failed, with all five mutants `no-coverage`.
- **T:** r9 B predicted `held`. Measured: gate-fail, because of the order above. The rows themselves were as predicted.
- **Overall:** r9 B predicted a gate-fail "from leg C". Measured: C, X and T all gate-failed.
- **Erratum (M4):** r9 B's D1c figure was a slip in the prose. The code pins 51 / 8 / 4 for D1c, and edge measured
  exactly that.

## What changes

### (a) Leg T: classify, compare and print first, then judge in order

The judgement moves into one pure function in `al-runner-v3-gate.ts`, `judgeLegT`. The itest calls it, and the unit
tests drive it. `legT` keeps only the session, the printing and the throw.

**Its inputs:**
- the classification `classifyLegT(own, now, bc)`;
- the per-mutant compare `compareMutants(own, now, { sameScheme })` (I1). Here `now = normalizeForComparison(r)`, and
  `sameScheme` is computed the way `assertGateBaseline` computes it today;
- `r.counts` and `r.mutants.length`;
- `r.unsupportedTests`;
- the Sleep index size;
- `knownDifferencesRefusal(bc, own, TABLES_KNOWN_DIFFERENCES)`.

**Step 0 always comes first (I3).** The classification and the compare are computed, and every (b) line is printed and
pushed to the receipt. This happens BEFORE any check can fail. Printing moves no verdict.

**Then the judgement, in this order.** The first step that fails decides `gate-fail`.
1. **Sleep index `0 + 0`.** This comes before any `held`, because "LethAL §6 cannot fire on leg T" rests on it.
2. **`unsupportedTests.length === 3`,** unchanged.
   - **A build that changes `unsupportedTests` is gate-fail by design. The Commit-fix held needs its own delta.**
   - Leg T's 3 refused tests are exactly the three Commit tests. A #5607 fix would drop them to 0 and move the 41
     Commit rows. Step 0 still prints those rows.
3. **`knownDifferencesRefusal(...) === undefined`,** unchanged.
4. **The classification's outcome:**
   - **`gate-fail`:** the leg is gate-fail.
   - **`held`:** the set of keys on which `compareMutants` reports a difference must EQUAL the set of keys of the held
     lines (I1). If not, the leg is gate-fail.
     - This catches a row whose mutated text changed (`mutatedTextSha256`), which `classifyLegT`'s `sameRow` does not
       compare.
     - If the two sets are equal, the leg is `held`. The counts are printed but NOT compared with 290 / 57 / 59.
   - **`pass`:** `compareMutants` must report 0 differences (I1), and then `assertCounts(r, "T", 290, 57, 59, 406)`
     must hold. The existing `assertGateBaseline` compare stays as well.

**There is no count check on `held` (I2).** `r.counts` is folded from the rows, and `classifyLegT` already walks the
union of keys one to one. So the guard against an extra moved row is that key walk, together with I1's key-set
equality.

**The record branch** keeps its order, with the counts checked first: a baseline is recorded only from a run that
matches the counts. If the record branch moves into the judge, a test pins that order (M1).

### (b) Leg T prints every differing row, in one format (M2)

`classifyLegT` now returns structured rows instead of formatted strings:
`{ key, kind: "held-bc" | "held-refusal" | "gate-fail", own: NormalizedMutant | undefined, now: NormalizedMutant | undefined }`.
Keys carry their ordinal, so a key holds at most one row on each side (M3).

`judgeLegT` formats each row as ONE line. The line goes to the log AND becomes its own receipt line:

```
T: <held|gate-fail>: <mutantCode> <key>: <old verdict>/<old errorClass>/<old killingTest> -> <new verdict>/<new errorClass>/<new killingTest> (<reason>)
```

- `-` stands for a null field, and `absent` for a missing row. `mutantCode` is read from the session report by key, and
  is `-` for a row the report does not hold.
- The `<reason>` texts are r9's:
  - `held-bc`: "the BC verdict, a known difference";
  - `held-refusal`: "a named refusal: v3 notRun or LethAL §6; not BC's verdict; re-pre-commit";
  - `gate-fail` on a known key: "a known row, but not to its BC verdict";
  - any other gate-fail: no reason text.
- A compare difference that is not a classification row (a text-only change) prints as
  `T: gate-fail: <mutantCode> <key>: <compareMutants' difference text>`.
- `pass` prints no row line.
- The old string lines are gone; they are never printed beside the new ones.
  - Test T1 (`tests/r586-gate.test.ts`) changes from the old exact string to the structured row
    `{ key: "K1", kind: "held-refusal", … }`, plus the formatted line above.
  - T2-T5 assert outcomes only, and stay as they are.
- The receipt's per-line cut (`slice(0, 1000)`) applies only to the joined failure message. Every row line is its own
  receipt line, so no row is cut off.

### (c) X (d): still `gate-fail` on a timed-out baseline, with the reason printed; follow-up R649

No verdict rule of X (d) changes, and the r5 table stays the only pass. No reading is re-kinded: the cause is inferred,
and no BC run of this probe exists.

**The printing (I4, M7).** Right after `session(...)` returns, and BEFORE the Sleep-index `must`, X (d) prints:
- **Its source:** the `baseline-batch-finished` event's verdict for `Sleep Probe.SleeperDoubles`, read from the
  session's event stream, or from the store if the run records the event. It prints `outcome` and the whole
  `failureMessage`, or `absent` when that verdict is not there.
- `r.baselineGreen`, and each mutant's `coveringTests`.
- "stop 120 s (computed from `BASELINE_TIMEOUT_DEFAULT`, not read from the call)".

Raw `notRun` and `durationMs` are NOT printed. `TestVerdict` does not carry `notRun`, and the event's `durationMs` is
set only on `pass`. They could come in only through a named backend hook, which r10 does not add.

**The reason line.** It is added when the per-mutant check fails AND SleeperDoubles's baseline verdict is present and
not `pass`.
- The failure line then ends with "X (d): SleeperDoubles is not green at baseline (<outcome>: <failureMessage>): the
  Sleep rule was not exercised; gate-fail".
- The helper that builds this text is keyed on SleeperDoubles's verdict alone, not on `baselineGreen`.
- The leg is still gate-fail.

**X (b) (M5).** X (b)'s `xHeld` line goes into the log and the receipt as soon as it is known, so a later gate-fail in
(d) cannot hide it. The outcome rule is unchanged.

**Why gate-fail is right.**
- X (d) is the Sleep rule's only live positive control. No mutant call was made, so a pass would admit a build on which
  §6 was never seen to fire.
- The change is toward BC: on BC, `Sleep` waits real time (plan §6, and `lease.itest.ts` P9B). And `no-coverage` is the
  safe direction for a user's score. But neither makes it a measured pass.

**The follow-up is [[R649]]** (filed on master, 926c0bda). X (d) cannot pass on any build that carries #5605's fix, so
this is a product gap. R649 does it in two steps:
1. On a leased bc server, through bcdev, measure how BC records `Sleep(600000)` under the 120 s baseline deadline, and
   a Sleep shorter than the stop.
2. Re-cast X (d) on a probe whose Sleep fits edge's budget, with BC's readings as the oracle, under its own
   pre-commitment.

## Figures that move

None on alpha.2. On edge, only leg T's outcome moves, from gate-fail to held. No pre-committed count, fact count, index
size or baseline file changes, and no baseline is re-recorded.

## Predictions

"Measured" means a run showed it. "Inferred" means it comes from code, another LethAL head or another build.

### (d) `--edge-rejudge 57f1e4f98` at the R-647 head

This runs after (e) passes. The binary is the kept `failed/edge-57f1e4f98@de8f43e2…/al-runner`, sha256
`0642f9b2…8720`.

| Leg | Prediction | Basis |
|---|---|---|
| C | `gate-fail`: `refusal-row-shape` reads `unlike-bc` (#5700). Held lines for `none-selected-exit`, `quoted-name-unselectable`, `refusal-cascade`, `sleep-is-noop` and `upstream-compile-errors` (all `gone`), and for `duplicate-key-insert-raises` (`refused`). `serve-keep-reasons` reads `diverged` (a warn fact, no outcome) | **Measured** at 711c94d9. R-647 does not touch leg C |
| S1 | `pass`, 3 / 12 / 4 over 19, 0 differences from bcdev.baseline, Sleep index 0 + 0, with the `unlike-bc` warning line | **Measured** at 711c94d9 |
| S3 | `pass` (the resource selector is refused) | **Measured** |
| N1 | `pass`, 36 / 0 / 0 over 36, 0 differences | **Measured** |
| X (b) | its held line (v3 refuses the broken target, exit 3) is now in the log and the receipt | **Inferred.** Measured: `exit 3 passed 0 notRun 0`. The line was hidden before |
| X (d) | `gate-fail`: M0001-M0005 all `no-coverage`, Sleep index 4 + 5, `M0001 hits []` | **Measured** at 711c94d9 |
| X (d), new lines | SleeperDoubles's baseline verdict is `timeout`, `failureMessage` `Test exceeded 120s timeout.`. `baselineGreen` is false. Every mutant's `coveringTests` is empty. The failure line ends with the "not green at baseline" text | **Inferred,** from code plus leg C's measured `sleep-is-noop = gone`. This is the measurement finding B lacks. Any other reading goes to R649, not to a re-kind here |
| D1 | `pass`, 51 / 12 / 0 over 63, 0 differences from bc3-A, Sleep index 3 + 0 | **Measured** at 711c94d9 |
| D1c | `pass`, 51 / 8 / 4 over 63, 0 differences from bc3-B, Sleep index 3 + 0 | **Measured** at 711c94d9 |
| T | **`held`.** See the details below the table | See below |

**Leg T in detail.**
- **Prediction:**
  - The counts are printed: 290 / 50 / 59, errors 7, over 406.
  - `unsupportedTests` is 3, the index is 0 + 0, and the pinned 52 hold.
  - There are exactly 7 lines of the form `T: held: <code> <key>: survived/-/- -> error/runner-refused/- (a named refusal …)`,
    for M0157, M0158, M0159, M0161, M0162, M0163 and M0164.
  - `compareMutants` differs on exactly those 7 keys, and there is no `gate-fail` line.
- **Basis:** the rows were **measured** on this binary at R-635's heads 7a8f63b3 and ec6a2680, by running the E0-T
  reports offline through `classifyLegT`. They are **inferred** at the R-647 head, from the identical counts at
  711c94d9. The compare key set is inferred. The rejudge's printed rows close this: each of the 7 keys must be checked
  by name.

**Overall: `gate-fail`, from C and X.**
- The result goes to `failed/edge-57f1e4f98@<R-647 head>/`, with a copy in `rejudge/edge-57f1e4f98@<R-647 head>/`.
- `current` does not move.
- Nothing under `failed/…@de8f43e2…` or `failed/…@711c94d9…` changes.
- Any difference from this table is reported, never re-recorded.

### (e) `--regate <final R-647 head>` on alpha.2 (`alrunner 3.0.0-alpha.2 (91253f2d6)`): `pass` on all eight legs, unchanged

| Leg | Prediction | Basis |
|---|---|---|
| C | `pass`, 26 facts as in r9 A | **Measured** at 711c94d9 |
| S1, S3, N1 | 3 / 12 / 4; refused; 36 / 0 / 0 | **Measured** |
| X | `pass`. (d) reads the r5 table: M0001 killed, M0002 survived, M0003 and M0004 `error` by §6 at :25 and :37, M0005 killed. The new lines print SleeperDoubles's baseline verdict as `pass`, and `baselineGreen` | The verdicts are **measured** at 711c94d9. The printed baseline verdict is **inferred** (r6: alpha.2 runs every Sleep at once). `baselineGreen` is not predicted, because the leg never asserted it |
| D1, D1c | 51 / 12 / 0 and 51 / 8 / 4, 0 differences | **Measured** |
| T | `pass`: the classification is `pass` (no row line), `compareMutants` finds 0 differences, then 290 / 57 / 59 over 406, then 0 differences from the own baseline | **Measured** at 711c94d9 (`T: 290 / 57 / 59 (errors 0 …)`, `leg T: PASS`). The new order is inferred to change no figure |

On `pass`, `.gated` takes the new head.

## Tests (pre-committed, coded after this delta is committed)

Each test goes red on its own single revert, and each guard has a red test for EACH direction. The red logs go to
`/coord/handoff/R-647/red-unit/`.

**On `judgeLegT`** (fakes, no live run):
- **T-a1.** The rows classify `held` (one pinned #5603 row `survived -> error/runner-refused`), the compare differs on
  that key only, and the counts are 290 / 56 / 59: the result is `held`. Red on restoring "counts first".
- **T-a2.** The rows classify `pass` and the compare is empty, but the counts are 290 / 56 / 59: the result is
  `gate-fail`. Red on dropping the count check from the `pass` path.
- **T-a3.** The rows classify `pass`, the compare is empty, and the counts are 290 / 57 / 59 over 406: the result is
  `pass`. This is the other direction of T-a2.
- **T-a5.** `held` rows with Sleep index 1 + 0 give `gate-fail`. Red on dropping the index check from the held path.
  The other direction: index 0 + 0 with the same rows gives `held`.
- **T-a6.** `held` rows with `unsupportedTests` at 2 give `gate-fail`. Red on dropping that check from the held path.
  With 3, the result is `held`.
- **T-a7.** One `held` row and one `gate-fail` row give `gate-fail`.
- **T-a8 (M1).** `held` rows with `knownDifferencesRefusal` returning a refusal give `gate-fail`. Red on dropping step 3
  from the held path. With `undefined`, the result is `held`.
- **T-a9 (I1).** The rows classify `pass`, but the compare has one difference (`mutatedTextSha256` only): the result is
  `gate-fail`. Red on dropping "0 compare differences" from the `pass` path.
- **T-a10 (I1).** The rows classify `held` on key K1, but the compare differs on K1 and K2: the result is `gate-fail`.
  Red on dropping the key-set equality. The case where the compare differs on K1 alone, giving `held`, is T-a1.
- **T-a11 (I3).** A failing step 2 (`unsupportedTests` 0) still returns every row line of step 0. Red on moving the
  printing after the checks.
- **T-a12 (M1), only if the record branch moves into the judge.** Record mode with wrong counts gives `gate-fail`,
  before any classification.

T-a4 (the held-move count check) is dropped, together with the check itself (I2).

**On the line format of (b):**
- **T-b1.** A `held-bc` row, a `held-refusal` row and a known-key `gate-fail` row each give the exact line above, with
  the mutant code, the key, both verdicts, both `errorClass` values and both killing tests. Red on reverting the format.
- **T-b2.** A missing row prints `absent`, and a text-only compare difference prints its own `gate-fail` line. Red on
  reverting either branch.
- **T-b3.** `pass` prints no row line. This is the other direction of T-b1.
- **T-b4.** Every row line is its own receipt line, not cut at 1000 characters: a fake with 60 differing rows puts all
  60 in `lines`. Red on pushing them as one joined line.
- **T1, updated (M2):** asserts the structured row and its formatted line, in place of the old exact string.

**On X (d) and X (b):**
- **X-c1.** One test per case, on the helper:
  - the "not green at baseline" text is added when SleeperDoubles's verdict is present and not `pass`, and the check
    failed;
  - the text is absent when SleeperDoubles's verdict is `pass` while `baselineGreen` is false (another test is red);
  - the text is absent when the verdict itself is absent; that case prints `absent`, with no reason text.
- **X-b1 (M5).** The X (b) held line is in the receipt lines even when (d) then gate-fails. Red on restoring the
  end-of-leg report.
- No new verdict test: (c) changes no verdict, and the existing r5 X (d) checks stay as they are.

T2-T5 (`classifyLegT` outcomes) and the P, R, L and K tests stay unchanged.
