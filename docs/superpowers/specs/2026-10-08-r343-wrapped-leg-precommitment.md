# R-343 pre-commitment: the `sandbox-wrapped` legs of `itest:alrunner`, after wrapped objects are indexed

Written 2026-10-08, BEFORE any live run of the changed code. Branch `lethal/r343`. It supersedes
`docs/superpowers/specs/2026-10-06-r300b-wrapped-leg-precommitment.md` §4 (the table), §5's
totals and §6 item 4. Every other part of that spec (setup, layout, tests, the `--define` pair,
what would mean what) stands unchanged. A difference in a live run is a finding and a STOP, never a
re-record. The owner approved moving this frozen leg (orchestrator, 2026-10-08).

## 1. Why the leg changes

R343: an object wrapped whole in `#if` was never indexed by the symbol table, so typed operators
emitted nothing inside it. That is why the R-300b table carried two twin-only rows (M0016, M0030):
`swap-additive` on `Grow`'s `exit(X + 1)` in the unwrapped twins, absent from the wrapped files. With
R-343 an object in an arm the build compiles (`WrappedTop`, `WrappedPre` under `WRAPDEF`) is indexed
like a root object, so the wrapped files gain the same row. `TWIN_ONLY` is gone: each admitted
wrapped file now equals its twin row for row.

**Derived OFFLINE**, the same way as R-300b's table. The mutant list comes from `generateMutationSet`
under the gate's symbols (`WRAPDEF` from the config, `WRAPAPP` from app.json) and
`writeInstrumentedProject`'s manifest order on the R-343 build (`/coord/handoff/R-343/scratch/wrapped-codes.ts`):
36 rows, the old 34 plus the two below. Every pre-existing row keeps its file, line, operator,
procedure, verdict and test. Only its code shifts.

## 2. The two new rows

| code | file | line | operator | procedure | verdict | killing / covering test |
|---|---|---|---|---|---|---|
| M0010 | WrappedPre | 11 | swap-additive | Grow | killed | GrowPre |
| M0024 | WrappedTop | 9 | swap-additive | Grow | killed | GrowTop |

Why: `Grow(20)` takes `exit(X + 1)`; `swap-additive` makes it `exit(X - 1)` = 19, not 21, so the
test's `Error(...)` fires: killed. These are the same verdict and the same reason as their twins'
rows, M0017 and M0032 below (M0016 and M0030 before).

## 3. The full table ("adds" reading)

| code | file | line | operator | procedure | verdict | killing / covering test |
|---|---|---|---|---|---|---|
| M0001 | WrappedArms | 7 | empty-block | Pick | no-coverage | (refused by name) |
| M0002 | WrappedArms | 8 | conditional-boundary | Pick | no-coverage | (refused by name) |
| M0003 | WrappedArms | 9 | return-value | Pick | no-coverage | (refused by name) |
| M0004 | WrappedPairA | 10 | empty-block | Pick | killed | PairPick |
| M0005 | WrappedPairA | 11 | conditional-boundary | Pick | survived | PairPick |
| M0006 | WrappedPairA | 12 | return-value | Pick | killed | PairPick |
| M0007 | WrappedPre | 9 | empty-block | Grow | killed | GrowPre |
| M0008 | WrappedPre | 10 | conditional-boundary | Grow | survived | GrowPre |
| M0009 | WrappedPre | 11 | return-value | Grow | killed | GrowPre |
| **M0010** | **WrappedPre** | **11** | **swap-additive** | **Grow** | **killed** | **GrowPre (new, R-343)** |
| M0011 | WrappedPre | 12 | return-value | Grow | survived | GrowPre |
| M0012 | WrappedPre | 35 | empty-block | Twice | killed | TwicePre |
| M0013 | WrappedPre | 36 | return-value | Twice | killed | TwicePre |
| M0014 | WrappedPreTwin | 9 | empty-block | Grow | killed | GrowPreTwin |
| M0015 | WrappedPreTwin | 10 | conditional-boundary | Grow | survived | GrowPreTwin |
| M0016 | WrappedPreTwin | 11 | return-value | Grow | killed | GrowPreTwin |
| M0017 | WrappedPreTwin | 11 | swap-additive | Grow | killed | GrowPreTwin |
| M0018 | WrappedPreTwin | 12 | return-value | Grow | survived | GrowPreTwin |
| M0019 | WrappedPreTwin | 35 | empty-block | Twice | killed | TwicePreTwin |
| M0020 | WrappedPreTwin | 36 | return-value | Twice | killed | TwicePreTwin |
| M0021 | WrappedTop | 7 | empty-block | Grow | killed | GrowTop |
| M0022 | WrappedTop | 8 | conditional-boundary | Grow | survived | GrowTop |
| M0023 | WrappedTop | 9 | return-value | Grow | killed | GrowTop |
| **M0024** | **WrappedTop** | **9** | **swap-additive** | **Grow** | **killed** | **GrowTop (new, R-343)** |
| M0025 | WrappedTop | 10 | return-value | Grow | survived | GrowTop |
| M0026 | WrappedTop | 32 | empty-block | Twice | killed | TwiceTop |
| M0027 | WrappedTop | 34 | remove-assignment | Twice | killed | TwiceTop |
| M0028 | WrappedTop | 36 | return-value | Twice | killed | TwiceTop |
| M0029 | WrappedTopTwin | 7 | empty-block | Grow | killed | GrowTopTwin |
| M0030 | WrappedTopTwin | 8 | conditional-boundary | Grow | survived | GrowTopTwin |
| M0031 | WrappedTopTwin | 9 | return-value | Grow | killed | GrowTopTwin |
| M0032 | WrappedTopTwin | 9 | swap-additive | Grow | killed | GrowTopTwin |
| M0033 | WrappedTopTwin | 10 | return-value | Grow | survived | GrowTopTwin |
| M0034 | WrappedTopTwin | 32 | empty-block | Twice | killed | TwiceTopTwin |
| M0035 | WrappedTopTwin | 34 | remove-assignment | Twice | killed | TwiceTopTwin |
| M0036 | WrappedTopTwin | 36 | return-value | Twice | killed | TwiceTopTwin |

The reasons for each verdict are R-300b's §4, unchanged. Covering tests are `Wrapped Tests.<name>`; a
survivor's covering test is its procedure's test.

**Totals ("adds"):** 36 mutants, killed 24, survived 9, no-coverage 3.
**Totals ("replaces", R-300b §5):** killed 22, survived 8, no-coverage 6. The pair M0004-M0006 reads
`no-coverage` with no covering test; every other row is as above.

## 4. What the gate asserts (each leg); replaces R-300b §6 item 4

1. One batch and a green baseline, as before.
2. Every row of §3 (the pair under the reading seen), per mutant: verdict, killing test and the
   complete covering-test set.
3. `WrappedArms`'s three rows carry R-300b's refusal sentence, unchanged.
4. **Strict parity.** Each admitted wrapped file equals its twin per (procedure, line, operator):
   verdict, killing test and covering tests, with the twin's test names being the wrapped ones plus
   `Twin`. That holds IN BOTH DIRECTIONS: no twin-only row and no wrapped-only row. (R-300b allowed
   the two twin-only rows M0016/M0030; they are gone.)
5. Zero R383 "the position wins" warnings and zero R-300b "the line is dropped" warnings, as before.
6. `--server` and resource equal the one-shot leg per mutant, as before.
7. The one-shot leg against `al-runner.wrapped.baseline.json`. It is re-recorded once by R332's
   procedure AFTER this file is committed: delete it, run with
   `LETHAL_ITEST_RECORD_BASELINE=al-runner.wrapped.baseline.json` (exit 3), then run again without
   it and pass on all three legs.

## 5. What would mean what (additions to R-300b §7)

- M0010 or M0024 not `killed` by its `Grow` test while its twin's row is: the wrapped object is
  indexed for generation but compiled or covered differently from its twin. That is a STOP.
- M0010 or M0024 missing: the build does not index the live wrapped object (the R-343 change is not
  in effect).
- Any other row differing from §3 (a verdict, a test, a code beyond the two shifts): a STOP, not a
  re-record.
