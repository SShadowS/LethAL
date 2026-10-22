# R534 pre-commitment r2: al-runner rows that are answers never abort the session

## Changes from r1
- I3: a `timeout-unconfirmed`, or any other difference, is a MISS. Part B then does not match, and
  R534 stays "fixed in <commit>, live gate pending". The escape hatch and the drop-D3 alternative
  are gone.
- Two causes: ScopeLogic:6 is `runner-refused`; the handler mutants stay `runner-test-error`.
- M3: the reported stop N is pinned exactly (one-shot 60, `--server` 120). The per-spawn checks
  name the active mutant from the logged selector.
- No `alrunner-timeout-wording-unrecognised` warning is predicted on either leg.

Written 2026-10-09 BEFORE any live run of the R534 build. To be committed to master as
`docs/superpowers/specs/2026-10-09-r534-alrunner-precommitment.md` before Part A or Part B runs.
Plan: `/coord/handoff/R-534/plan.md` r2. Measurements: `/coord/handoff/R-534/measure.md`, al-runner
`2.12.0-main.43f76177`.

## Part A: `itest:alrunner` (the gate)

Inside the container: `LETHAL_ITEST_ALRUNNER=1 bun run itest:alrunner`.

Prediction: **PASS, with every frozen figure and every per-mutant verdict unchanged.**
- `fixtures/sandbox-app` + `-tests`: killed 3 / survived 12 / no-coverage 4 on the one-shot,
  `--server` and resource legs, per mutant equal to `al-runner.baseline.json`.
- `fixtures/sandbox-symbols` under `[LETHALA]` and `[LETHALB]`: 5 / 4 / 0 each, every leg, per
  mutant equal to the R321 pre-committed table.
- `fixtures/sandbox-layout` at `maxGuardsPerBatch` 7: 7 / 3 / 0, per mutant and per covering test.
- The R123 contract probe's facts are unchanged (R534 adds none). `timeout-exit-readable` is
  `matches`: its `Test exceeded 2s timeout.` still matches the anchored regex.
- No mutant in any leg has cause `runner-test-error` or `runner-refused`, and there is no
  `alrunner-timeout-wording-unrecognised` warning.

Why nothing can move: none of the seven committed `al-runner*.baseline.json` holds an `error`
verdict, and none contains `out-of-scope`, `OnRun trigger` or `UI handlers`. A differing verdict is
a BLOCK.

## Part B: local evidence run, `scripts/r534-probe/run.ts`

Uses local al-runner only: no BC, no lease, no config file read.
- Project `scripts/r534-probe/app`: codeunits `R534 Count Logic`, `R534 Scope Logic` and
  `R534 Ask Logic`, one per file.
- Tests `scripts/r534-probe/tests`:
  - 79690: an OnRun that calls `CountTo(10)`, and test `CountsToThree`;
  - 79691: `NoTaskAsked`;
  - 79692: `AsksOnce`, with handler `ConfirmYes`.
- Both are byte-identical to `/coord/handoff/R-534/session/` as measured.
- One `runSession` per leg over the whole project (no `--only`), `mutantTimeoutMs` 60000, coverage
  `al-runner`, the default 120 s baseline timeout.

From the worktree root, foreground, bounded:

```
timeout 2400 bun scripts/r534-probe/run.ts oneshot
timeout 2400 bun scripts/r534-probe/run.ts server
```

Part B is not a gate. ANY difference from what follows is a miss: Part B does not match, R534 stays
"fixed in <commit>, live gate pending", and the miss is reported and filed.

### B1. Every leg: the session COMPLETES (no `backend transport error ... spec §11`), and the baseline is green.

### B2. Per-mutant verdicts, identical on both legs (20 mutants, keyed by file:line operator)

| File:line | Operator | Verdict | cause |
|---|---|---|---|
| CountLogic:9 | empty-block | killed | - |
| CountLogic:10 | remove-assignment | survived | - |
| CountLogic:10 | shift-integer | survived | - |
| CountLogic:12 | void-method-call | **timeout-killed** (OnRun hang) | - |
| CountLogic:13 | loop-truncate | killed | - |
| CountLogic:13 | conditional-boundary | killed | - |
| CountLogic:14 | return-value | killed | - |
| CountLogic:18 | empty-block | **timeout-killed** (OnRun hang) | - |
| CountLogic:19 | remove-assignment | **timeout-killed** (OnRun hang) | - |
| CountLogic:19 | shift-integer | killed | - |
| ScopeLogic:5 | empty-block | killed | - |
| ScopeLogic:6 | negate-guard | **error** (out-of-scope refusal) | `runner-refused` |
| ScopeLogic:7 | return-value | survived | - |
| ScopeLogic:8 | return-value | killed | - |
| ScopeLogic:8 | flip-boolean-literal | killed | - |
| AskLogic:5 | empty-block | **error** (unexecuted handler) | `runner-test-error` |
| AskLogic:6 | negate-guard | **error** (unexecuted handler) | `runner-test-error` |
| AskLogic:7 | return-value | survived | - |
| AskLogic:8 | return-value | survived | - |
| AskLogic:8 | flip-boolean-literal | survived | - |

Totals per leg: killed 8, timeout-killed 3, survived 6, error 3 (`runner-refused` 1,
`runner-test-error` 2), no-coverage 0, `timeout-unconfirmed` 0.

### B3. The structure behind them

- The three timeout-killed mutants have `killingTest` `CountsToThree` and `killPosition` 1.
  - The mutated row's message is exactly `The test codeunit's OnRun trigger exceeded the <N>s timeout, so none of its test methods ran.`
  - **N = 60 on the one-shot leg**: the budget is the 60 s floor, because twice the baseline wall
    time is below it.
  - **N = 120 on `--server`**: the daemon's stop is `max(60 s floor, 120 s baseline timeout)`.
  - `reportedStopMs` = N x 1000.
- One-shot leg, read from the per-spawn log (each spawn is logged with the active selector's mutant
  id and its `--test`):
  - Each of the three hang mutants has exactly ONE spawn of `Codeunit79690.CountsToThree` with that
    mutant active. The next spawn is the confirm: the same test with NO mutant active.
  - ScopeLogic:6, AskLogic:5 and AskLogic:6 each have exactly ONE spawn with the mutant active (no
    retry).
- The three error notes carry the row's own message:
  - ScopeLogic:6 starts `RunnerOutOfScopeException: out-of-scope: TaskScheduler.TaskExists`;
  - AskLogic:5 and :6 contain `The following UI handlers were not executed: ConfirmYes`.
- No `alrunner-timeout-wording-unrecognised` warning on either leg.

Some outcomes are also a BLOCK on the build, because they mean a code defect, not only a miss:
- a hang mutant scored anything but `timeout-killed`;
- any mutant scored `killed` with an out-of-scope or handler message;
- a session abort.
