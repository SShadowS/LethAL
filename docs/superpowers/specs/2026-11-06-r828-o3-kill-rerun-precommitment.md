# R828 pre-commitment: a timeout kill re-runs at a larger budget, and the limit that decides O3

**NOT ADOPTED, 2026-11-06: read the addendum at the end. Do not build this rule or run this measurement. The body is kept as the record of what was tried.**

Written 2026-11-06 by lethal-code, before any live run. It replaces the budget rule withdrawn in `2026-11-06-r828-loop-compare-measurement-precommitment.md`, Addendum 1, and lists each thing that addendum
said a new pre-commitment must state. One opus review found five faults in a first draft; this text carries their fixes. Nothing here is built. A false `timeout-killed` is a BLOCK. Offline figures: `/coord/handoff/R-828/o3/` (`m-census.txt`, `rp2-limit.txt`, which replaces `rp-limit.txt`).

## The question

O3 reads one Boolean local per mutant at loop entry and puts a plain compare in the loop. So a run gets slower by a fixed amount per pass, also in a mutant's run. A test that fits its budget today could time out under
O3 with the mutant doing no harm, and with `--stop-hung-sessions` that scores `timeout-killed`: a false kill. Without the flag it ends `in-flight-unknown` and a quarantine: loud and safe, and this rule changes nothing there.

## The rule

**In `reproduceKill`, a timeout kill re-runs the killer ALONE, as one single run, at `min(M x B, cap)`**, where `B` is the budget the killing run was sent, `M = 1.5`, and `cap = requestCeilingMs - STOP_GRACE_MS`, 270 s by default, taken from the session's setting and not the constant.

- **Only a second `timeout` at the full `M x B` scores `timeout-killed`.** A `pass` or `fail` is `kill-not-reproduced` as today.
- **If `cap < M x B`, so `B` is over 180 s by default, the margin cannot be met.** The run goes at `cap`, and even a second `timeout` scores `kill-not-reproduced`, naming the margin. A lost kill, never a false one. It affects a test with a baseline over 90 s, and a user-set budget over 180 s.
- **At every position, not only position 1.** A prefix replay cannot carry this budget: `RunMany` caps when `Elapsed + budget + grace > ceiling`, which at 270 s is any elapsed time above zero, so every replay would end `warm-confirmation-incomplete`. So a timeout kill at position 2 or later drops the replay. **The loss, by name:** a hang that needs the methods before it in the same call no longer reproduces, and scores `kill-not-reproduced`. A lost kill, never a false one. `fail` kills keep their replay and their budget.
- **Only where a stop is the budget (`inRunStopIsBudget`).** A backend without that keeps today's re-run: al-runner-v3 cannot be raised by `reproduceKill`, and must not claim a stop at `M x B` it never had.
- **No constant moves.** `fits`, the floors and the ceiling stay, so `groupedCalls`, `warmKills` and `killPosition` stay. `M` is new and named.
- **The cost:** a true hang at the default floor costs 180 s + 270 s = 450 s, against 360 s today.
- **Why 1.5:** `fits` needs `budget + 30 s <= 300 s`, and the code's own note says a hosted server's proxy aborted 330 s and has a 360 s ceiling. So 270 s plus the grace is the largest held time the code already calls safe. Whether BC's 408 arrives at that length is shape 3 below.

## Why it covers O3, and the limit

**Entry reads.** The locals are read by an early-exit chain, `if Active(a) then La := true else if Active(b) then Lb := true ...`, not one read each. So an active mutant at position k pays k reads, exactly as today's chain does, and the entry cost cannot grow. Reading all N would turn a position-1 mutant's 1 `Active` into N, in a callee the mutant may call far more often: a false kill. Only one mutant is active in a run, so the reads a chain skips are false.

**Per pass.** A pass pays only the compares on the path it runs. For each innermost loop, `rp` is the largest, over paths, of compares on the path divided by statements on the path that hold mutants. A path takes one branch at an `if` or `case`, and ends at `exit`, `continue`, `break` or a plain `Error(...)`. A nested loop's header compares count in the outer pass, also when the inner body does not run. Statements with no mutant only add time, so this bounds a pass. With `F` the cost of a statement plus one compare, over the statement alone, and the loop's own cost taken out (see the reading below):

`S = 1 + rp x (F - 1)`, the most a pass in that loop can slow down.

A run that fit `B` today fits `S x B` under O3. A false kill needs that run to time out at `M x B` too, so the rule covers a loop when `M >= S x margin`. A slower baseline only raises `B`. Callees add time, so the largest `S` bounds the sum. **The margin is 1.1**, for what the formula leaves out: samples, load, and a real server's `F`. So `S <= 1.36`, and:

`rp <= 0.36 / (F - 1)`

**O3 applies only to loops inside that limit, tested with `<=`. Any other loop keeps O1's flat chain, which pays nothing per pass.** A loop nested in an outer flat chain converts only if every innermost loop with mutants in that chain is inside the limit. This is `rp`-aware emission, which is new. The emitter computes `rp` on the same walk, and that walk gets its own tests.

Modelled sizes over the 38 largest files, not emitted. O1's figure equals the real total byte for byte. O1 is 108,930 KB, worst file 43,360 KB, 2 files over 10 MB.

| measured `F`, at most | `rp` limit | total KB | saved against O1 | worst file KB | files over 10 MB |
|---|---|---:|---:|---:|---:|
| 1.07 | 5 | 27,507 | 75% | 3,125 | 0 |
| 1.12 | 3 | 31,577 | 71% | 3,547 | 0 |
| 1.18 | 2 | 43,996 | 60% | 7,169 | 0 |
| 1.24 | 1.5 | 85,040 | 22% | 24,192 | 2 |
| 1.36 | 1 | 89,655 | 18% | 24,192 | 2 |
| over 1.36 | none | 108,930 | 0% | 43,360 | 2 |

`rp <= 2` holds 89.0%, 93.9% and 96.2% of the loops in DC/Cloud, DO/Cloud and DO/Test. Largest `rp`: 11.0, 5.0, 5.67. Largest own mutants of one statement, `mp`: 25, 28, 15. The step at `rp = 2` comes from `ImportXmlDocument`: two inner loops at exactly 2.0 keep its outer chain flat below that limit.

**What we know of `F`: R246's one sample, 1.63, on a latch in a tight loop, with the loop's own cost not taken out. Taken at its word, O3 does not pass at any limit.** One sample cannot decide a constant, and a measurement costs about 30 minutes. `F` is read on the cheapest real statement, so it overstates a real loop: a pass bound, not a typical cost.

## The measurement

Two servers, one coord lease each, one scratch app, ids 91500-91599, checked free first, no table, removed afterwards: **`bc2`, BC 28.4, and `bc4`, BC 29**. `bc4`'s 13 non-hang gates reproduced at control 1.0.0.25 (`/coord/handoff/R-826b/bc4/`); hang does not run on `bc1`. Publishing a scratch app needs the owner's word in the lane's session.

**Shapes.** In one tight `while`:

- **empty:** the loop alone.
- **plain:** the loop and one Integer assignment.
- **guarded(k):** the same assignment with k Boolean-local compares in front of it, in the text O3 emits, with k of 1, 2, 3, 11 (the largest `rp`) and 28 (the largest `mp`). Each local is read once before the loop, from a procedure that returns false.

The pass count is set once, so that `guarded(28)` takes under 60 s, the probe's hard bound. Each round runs every shape once, in a new shuffled order, with coverage OFF, then ON (`CodeCoverageLog`). Five rounds.

**Reading.** For round i, with `e`, `p`, `g` the times of empty, plain and guarded(k): `Fk(i) = 1 + (g - p) / (k x (p - e))`. Then `Fk` is the median over rounds, and **`F` is the largest `Fk` over k, coverage mode and server.** The empty shape is what makes it a bound: without it, `F - 1` divides by the statement plus the loop, and a loop with many statements slows by more than the formula says. The five `Fk(i)` of any k must lie within 0.02 of their median, which is under the distance between the table's rows. If not, run that k once more; a second failure means the limit fails.

**Three more shapes, each pass or fail:**

1. **Hot call, position 1 with the mutant active.** A procedure with one loop, 40 locals, called 100,000 times, under the early-exit read, against the same procedure with today's chain, with the FIRST mutant active on both. It fails if the O3 call costs over 1.36 x the chain's. This is the pair that can give a false kill. Also with the last mutant active.
2. **1,000 locals.** Publishes, installs and runs, and the call costs under 1 s more than with no locals. If not, O3 takes a local cap per procedure from the largest count that passed: that is a pass with a cap, and the size table is recomputed with it.
3. **A held request at 270 s.** One scratch hang, budget 270 s, stopped by the control app on each server: does BC's 408 arrive inside `270 s + STOP_GRACE_MS`? No gate holds a request over 180 s. This measures the on-prem shape only; a hosted server stays unmeasured. If it fails, `cap` falls to the largest held time that passed, `M` falls with it, and the limit formula and the table are recomputed from that `M` before anything is decided.

**Server health:** `itest:bcdev` passes on each server afterwards, under the same lease. If a stop does not end a session, the lease stays held and the measurement stops.

## The decision

The `rp` limit comes from the table, by the lowest row whose `F` the measured value meets, after any recomputing above. **Only a limit of 2 or better gets the worst file under 10 MB, so O3 is built only if `rp` reaches 2, with all three shapes passing. At `M = 1.5` that is `F <= 1.18`.** Otherwise O3 is not built, and R828 ends at O1, reported plainly, with #28 left unresolved: the gain below that line is under a quarter, and two files stay over 10 MB. The owner may overrule that line, not the formula.

## What moves if it lands

The rule lands in its own commit before O3, and only if O3 goes ahead.

- **By name, outside `itest:hang`: nothing.** `fits` is unchanged, and no `*.baseline.json`, `sessionFingerprint` or batch hash holds a budget, so `--resume` and campaign freezes stay valid. Only `itest:hang` holds a timeout kill (R164).
- **`itest:hang`:** `stopRowFailures` takes two windows: the first run in `[B, B + grace)`, the re-run in `[M x B, M x B + grace)`, with `B` 20 s and so 30 s. The check in `hang.itest.ts` that reads one window, and the gate's run time, move with it. A re-run at position 2 or later is now `op_kind` single, not many, and one more stop row of its leg moves with that. `docs/gates/hang.md` is updated.
- **Text:** `answered`'s "at the same budget" becomes false, and the two tests that pin it change.
- **A planted test, offline:** a fake backend, with the server's cap in the fake, where the killer times out at `B` and finishes under `M x B`, at position 1 and at position 2 or later, must score `kill-not-reproduced` at each. Plus a timeout needing the prefix, and `cap < M x B` on a second timeout. No gate holds this race, and a hang-capable site may not enter another gate (R164), so offline is where it lives.
- **A baseline can slow past its limit.** `BASELINE_TIMEOUT_DEFAULT` stays at 120 s, so a baseline test over about 88 s could pass it under O3. That is a loud, named baseline failure and not a verdict. The withdrawn rule raised it; this one does not.
- **al-runner-v3: not covered.** If O3 is built, file it as its own item: v3 either keeps O1's chain or measures its own ratio. Its results are `authoritative: false` until R586.

## What this does not settle

The time of a real mutant in a real suite; only gates do that. Whether chain length caused #28's crash ([[R826]]). The `rp`-aware emitter's own soundness: the three holes in the plan's O3 still stand, and need the residual check extended before a build. Calls that may raise, such as `FieldError` and `TestField`, are not counted as path ends; a path through one only gets longer in the walk than it may run, and a raise there ends the test. Sizes are modelled, and `rp` is measured on the corpora at hand: a project can hold a loop over the limit, which keeps O1's chain, so it costs size, never a verdict.

No gate figure moves from the measurement. Nothing lands from it but its result.

## Addendum, 2026-11-06: not adopted

A second opus review found two more faults, and the second removes the body's limit. Nothing was run on a server; all figures are modelled.

**A warm kill re-runs cold.** At position 2 or later, the killer alone runs cold, so a slow lazy setup skipped in the warm run counts against the margin. Example: 80 s of setup, a mutant at 175 s warm today, 201 s under O3, 281 s alone: over 270 s, a false kill. It would need a cold control run, and `d <= (M - 1.1 x S) x B`, losing a timeout kill by name where that does not fit.

**`F` on a statement is about 2 by definition.** A mutated `if Flag then` costs about one compare, and O3 adds one more. With the loop's cost taken out, no measurement could pass `F <= 1.18`. **So `rp` is not a bound, and the table above does not hold.**

**A sound bound.** A pass must make its calls, and a call costs far more than a compare. With exactly one mutant active, `rc` is the largest, over paths and over which one mutant is active, of compares per call that pass must make. `rc` is infinite when a pass under some mutant makes no call. Modelled over the 38 largest files, `/coord/handoff/R-828/o3/rc2-limit.txt`:

| `rc` limit | total KB | saved against O1 | worst file KB | files over 10 MB |
|---|---:|---:|---:|---:|
| 1 | 108,843 | 0% | 43,360 | 2 |
| 2 | 89,139 | 18% | 24,193 | 2 |
| 5 | 86,733 | 20% | 24,193 | 1 |
| 10 | 79,854 | 27% | 24,193 | 1 |
| every finite `rc` | 56,062 | 49% | 24,193 | 1 |

The limit would be `0.36 x` the cheapest call's cost in compares, which is not measured. **No limit takes the worst file below 24 MB.** `ImportXmlDocument` converts at no limit: 16 of its 19 loops are infinite, 14 of them, by the tool, through a mutant on the loop's own condition (line 824 read by hand, the other 13 not).

**One open ruling could change that.** That mutant makes a pass cheaper, not slower: a run under it should take less time than baseline, so it may never reach its budget. If that holds, the scenario could be dropped. But it holds only if the mutant does not raise the number of passes, and proving that needs a new argument and a new review. It has not been made.

**The result.** O3 is not proven safe for the file it was for. A measurement now would decide only a limit worth about 20%, with the worst file still at 24 MB. So it is not asked for. R828 stands at O1 unless the owner wants the ruling above pursued.
