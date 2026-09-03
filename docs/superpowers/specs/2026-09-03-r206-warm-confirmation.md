# Design: session-warm verdicts and the warm confirmation (R206), with the per-method cost cut (R198 follow-up)

Status: DRAFT, revision 2, for a closure review before any code. Revision 1 was refused
(2026-09-03) on ten findings; two were decisions the draft had not made (the timeout grain, and
what the gates pin), one was a measurement it had cited wrongly (E12 now measures it), the rest
plumbing. All ten are applied here and listed at the end. Amends
`2026-09-03-r198-run-mutant-loop.md` §2.1, §3.4 and §5. Second opinion: gpt-5.6-sol,
`scratchpad/pi-sol-run3.md`.

## 1. What was measured, and what it means

Run 3 of the Document Output Templates slice (741 mutants, hosted sandbox): 8 verdicts moved
`survived` → `killed`, all cache code, every killer at position 2 or later of its group call,
every failure a stale-cache assertion; 20 kills kept their verdict with a different killer; 0
moved `killed` → `survived`. Mechanism: each method is its own `CODEUNIT.Run` under Microsoft's
`Test Runner - Isol. Codeunit`, and the DATABASE rolls back per method, **including writes the
test body itself `Commit()`s** (probe E12, 2026-09-03: a committed row is absent for the next
method in the same call, for the next call, and in the row count), but a `SingleInstance`
codeunit's variables live for the SESSION (Microsoft's `SingleInstance` documentation), a group
call is one session, and the pre-R198 path gave every test a fresh session (probe E11). `ClearAll`
is documented as NOT touching single-instance codeunits; no AL API resets them. So inside one
session the only cold method is the first, and the database is the same for every method.

**Ruling this design implements.** A kill is: *the test fails (or exceeds its budget) with the
mutant active, in a session where the same ordered prefix of tests passes (and completes inside
budget) without it.* That is the context the target's own CI runs in (many methods per session)
and the product runs in (a warm cache); the cold-per-test context was an accident of one session
per request. The direction of the residual error is the accepted one: a test that fails only cold
hides a kill (a false survivor), never manufactures one.

## 2. The warm confirmation (what changes in the orchestrator)

Today a `fail` is confirmed by re-running the killing test ALONE, unmutated, in a fresh session
(cold), and a `timeout` is scored `timeout-killed` on BC's 408 with no confirmation. For a kill of
EITHER kind at group position 1 that stays: method 1 of a call is cold, as it was. For a kill at
group position **k > 1**, both kinds are confirmed the same way:

- **The replay.** Methods 1..k of the call that produced the failure (the `chunkPrefix` the step
  carries: never recomputed from `ordered`, never an earlier call's methods), in that order,
  unmutated (`activate(null)` first, as today), through ONE `RunMutantMany` call with
  `StopAtFirstFailure` and `confirmation: true`. The answer is asserted by R198 §3.3's rules before
  it counts; each entry's `durationMs` is the server's own.
- **A `fail` at k is confirmed** when every method through k PASSES in the replay: `killed`,
  `killingTestFailure` from the mutated run, `killPosition = k`. If method j ≤ k fails in the
  replay: `error`, cause **`warm-prefix-unstable`** (a NEW value: the failure reproduces without
  the mutant, so it is the suite's own order sensitivity, never a kill), the note naming method j
  and its position, and the R26 permissions diagnosis and R59 runner-disagreement diagnosis read
  from **entry j's** failure text and name **entry j's** ref, not the killer's. `counts.unstable`
  does not absorb it.
- **A `timeout` at k is confirmed** when every method through k passes in the replay AND method
  k's replay `durationMs` is inside its own budget (`budgetOf(k)`, the cold-measured one): the
  mutant, not the warm session, made it exceed the budget: `timeout-killed`, `killPosition = k`.
  If method k completes unmutated but OUTSIDE its budget: `error`, cause
  **`warm-timeout-unconfirmed`** (the warm session, not the mutant, is slow; the budget was
  measured cold). If the replay fails or stops before k: as the `fail` case's outcomes.
- **Any other end of the replay** is `error`, never a kill, never a quarantine, never a lease
  latch, with its own cause: `endedBy: cap` → **`warm-confirmation-incomplete`** (the replay is a
  slower re-run on wall clock, so the server's cap can fire on a prefix that fitted once: not a
  malformed answer); a `timeout` from the replay's own watchdog → the same cause, naming the
  method the stop landed on; a lost ack → R194's rules on the replay as on any group call, and a
  second loss → `result-lost`; a lease answer → classified as today; malformed → the existing
  `group-answer-malformed`.
- **The replay's watchdog.** With `--stop-hung-sessions` the replay runs with the stop hook, so a
  prefix method that hangs unmutated ends the CALL (scored as above), never the tier. WITHOUT the
  flag, LethAL may not end sessions, so the replay enforces NO per-method budget: only the hard
  cap (ceiling + grace) bounds it, an abort there is `in-flight-unknown` reconciled as any
  unreadable answer (the session finishes on its own, the op tombstones, one retry of the replay,
  then `result-lost`), and a genuinely hanging unmutated prefix quarantines exactly as a hanging
  baseline test does today.
- The replay does NOT try to reproduce the mutated run's cache contents: same initial state (a
  fresh session, the same database per E12), same stimuli in the same order, minus the mutation.
  A difference that arises because the mutant populated the cache differently in an earlier prefix
  method is a causal, sequence-level kill, and is what this confirmation is for.
- The cold single-test confirmation is NOT run in addition for a warm `fail`: the replay subsumes it.

Cost: one extra group call per warm kill, k methods long. Run 3 had 28 warm kills of 448.

**`killPosition`** on every `killed` and `timeout-killed`: the 1-based position of the killer in
the call that produced the failure; 1 on the single-method path and for a position-1 group kill;
never inferred from which confirmation ran. It is a fact about R197's ORDER, not about session
state: the tables fixture, which has no session-scoped state, already kills 13 of 299 mutants at
positions 2 to 5 (read from its store, run 334), because the killer is not always first in the
ledger's order. What tells a reader the kill was warm is `killPosition > 1` plus the caveat.

## 3. What changes on the wire, the client and the record

- **Control app.** `RunMutantMany` accepts `MutantId = ''` exactly as `RunMutant` does (phase 1
  claims with a blank mutant, nothing is activated; `IsActive` on a blank cached id is false); no
  signature change. `BcDevMcpBackend.runMany` gains `confirmation: true`, which permits the blank
  mutant it refuses otherwise, and `enforceBudgets: boolean`, which the transport's watchdog
  honours (false: hard cap only).
- **Generator (`coveringRuns`).** Each step carries `groupPosition` (1-based within its call) and
  `chunkPrefix` (the refs 1..position of that call).
- **Loop body.** The `fail` and `timeout` branches: `groupPosition > 1` → the warm confirmation
  above through `runFencedMany`; else today's paths. Both record `killPosition`.
- **Record, the full R86 ripple:** `MutantRow.killPosition?` and a migrated `kill_position`
  column (`store.ts`); `record()`'s parameter; `mutant-scored` AND `mutant-carried` events
  (`events.ts`); both fold sites (`report-fold.ts`); `MutantOutcome.killPosition?` and the report
  mutant entry (`report.ts`); `CarriedVerdict.killPosition?` and both carried-replay call sites
  (`resume.ts`, `orchestrator.ts`); `explain`'s projection (a path pin refuses unknown fields) and
  its test; the schema (optional, R157's rule) and the `report-equality` snapshot; the
  mutation-elements export leaves it out (no field for it). Three NEW `MutantErrorCause` values
  (`warm-prefix-unstable`, `warm-timeout-unconfirmed`, `warm-confirmation-incomplete`) with
  interpretations, `explain` prescriptions and the enum ripple. A NEW `Caveat`
  **`"session-warm"`** on every report with `groupedCalls > 0`, whose interpretation states the
  ruling in §1, that a cold-only kill is a survivor here, and that a warm kill's `killPosition` is
  greater than 1; `CAVEAT_INTERPRETATIONS`, `interpretation.test.ts` (17 → 18) and
  `report.test.ts` counts follow. **Row parity, stated:** a warm kill writes k confirmation rows
  (`mutantCode: null`, `op_kind: many`) where a cold kill writes one; `hang.itest.ts` reads
  `op_kind` and must expect it.
- **`groupedCalls`** counts every `RunMutantMany` call, replays included; the gates pin it as
  `scored + warmKills` with `warmKills` a NUMBER per gate (§6).
- **`--no-group-runs`** stays as the diagnostic mode: cold-per-test verdicts, the old cost.

## 4. The per-method cost (R198 follow-up, control app only)

Run 3 spent ~330 ms per method inside the loop on hosted SQL where a container spends 55 ms. The
loop rebuilds a suite per method: delete the suite and its lines, create, `SelectTestMethodsByRange`
(one line insert per method of the codeunit, 20 to 110 here), `Validate(Run,false)+Modify` on every
line, one `Run = true`, then `RunAllTests` (whose runner does `ModifyAll(Result)` and
`ModifyAll("Error Message Preview")` over EVERY line of the suite, then a Commit, then the result
writes and a Commit), then `TestResultsToJSON` (an `AllObj` query, an installed-app query, a scan
of all function lines, serialize, and the client parses it back). Changes, in order of saving,
keeping one `CODEUNIT.Run` of the test codeunit per method under the stock runner and per-method
results, and keeping BOTH named invariants, which the rebuilt loop must implement itself since it
no longer delegates to `LC Run Method`:

- **`PROGRESS_BETWEEN_FIRST`**: `ProgressBegin` (the `running` write, its own Commit) immediately
  before the run, and `ProgressBetween` as the FIRST statement after `RunTests` returns, BEFORE
  the function line is re-read, before any `CalcFields` on the error BLOBs, before the JSON is
  built. R204's after-408 narrowing reads `lastCompletedIndex`, and anything placed between the
  run's return and that write widens its false-kill branch. The source test that pins the
  invariant on `LC Run Method` is re-pointed to pin BOTH codeunits.
- **`LOOP_READS_LEASE_ONLY`**: the marker re-read after each `between` commit, a plain `Get`,
  unchanged.

1. **Build the suite once per call.** At the start of every call, delete the suite name if it
   exists (the same delete `RunOneMethod` does; `NextSuiteName` restarts per session, so the name
   recurs across calls and each call cleans the last one's rows), `CreateTestSuite`, then
   `SelectTestMethodsByRange` once per distinct codeunit in the request, validate every requested
   `(codeunitId, method)` resolves to exactly one function line, set every function line
   `Run = false` once, and keep a map method → (header line no, function line no). Per method:
   previous function line `Run = false`, current `Run = true`: two updates. A requested method
   with no line, or more than one, is answered as an ENTRY carrying `codeunitResults` with the
   `error` text `RunOneMethod` uses ("expected exactly one method X, found N") and NO
   `testResults`, so the client's per-entry line-count guard aborts the session with the server's
   words exactly as it does today (R139/R56's channel), never a per-mutant `runError`.
2. **Run through `Test Suite Mgt.RunTests(Line, ALTestSuite)` on a record filtered to exactly the
   codeunit header line and the current function line** (`SetFilter("Line No.", '%1|%2')`), not
   `RunAllTests`, which `Reset`s to the whole suite. Traced in the review against
   `scratchpad/bcapps/`: runner 130450 copies that record in `OnRun` BEFORE `TestRunnerMgt.RunTests`
   mutates its own copy, so `PlatformBeforeTestRun` receives the caller's `header|function` filter
   as `LineNoTestFilter` and `GetTestFunction` refuses every function outside it before `Run` is
   read; the two `ModifyAll`s touch the two filtered rows; the runner's codeunit loop finds one
   header; `GetLineNoFilterForTestCodeunit` widens only the module-level `CurrentTestFilter`, which
   does not reach the admission check. Every other function line's `Run` stays false as a second
   guard. A requested method that silently does not run leaves `Result = 0`, which the client's
   result-enum guard refuses loudly.
3. **Read the result off the function line, AFTER `ProgressBetween`:** `Result`, `Start Time`,
   `Finish Time`, and on failure `Test Suite Mgt.GetFullErrorMessage` / `GetErrorCallStack`; build
   the per-method `codeunitResults` JSON in the SAME shape `TestResultsToJSON` produces (`name`,
   `codeUnit`, `result`, `testResults[{method,result,message,stackTrace,startTime,finishTime}]`),
   with the stack trace's `\`→`;` and `"` stripping copied from it, so the client's `mapRanResult`
   and R121's screen see byte-identical text.
4. `ProgressBegin` inserts the first row fully populated (one write saved per call). The two
   progress commits and Microsoft's two runner commits stay. `RunTestsWithoutLoggingResults` is
   not used (no selection, no result).

`LC Run Method` (the single-method path, the baseline, the cold confirmation) is unchanged.

Expected: 140 to 200 ms per method on the sandbox (sol's estimate). Pre-committed for run 4:
survivors' total below 2,400 s (run 3: 3,165 s) on the same 237 survivors.

## 5. Where this can produce a wrong verdict, and why it does not

- **A warm failure that is the suite's own order sensitivity.** The replay reproduces it without
  the mutant and records `warm-prefix-unstable`.
- **A warm TIMEOUT that is the warm session's own slowness against a cold budget** (review F1).
  The replay must complete method k unmutated inside its budget, or `warm-timeout-unconfirmed`.
- **A replay that runs the wrong prefix.** From the step's own `chunkPrefix`, asserted complete
  and identity-matched before it counts.
- **A replay whose database differs from the mutated run's.** E12: committed writes roll back
  too; the database is the same at every method's start.
- **A replay that a cold-only kill would pass.** A survivor either way under warm semantics; the
  caveat says so.
- **Suite reuse leaking a `Run` flag or running an unrequested method.** Every line starts false,
  exactly one is true per method, the runner's filter admits one function line, the identity check
  refuses a method not asked for at that index, and `Result = 0` is refused.
- **The rebuilt loop widening R204's window.** `PROGRESS_BETWEEN_FIRST` pinned on `LC Run Many`.
- **A replay quarantining a healthy tier.** Never: its stop ends the call; without the flag only
  the hard cap applies and that path reconciles as an unreadable answer.
- **A blank-mutant `RunMutantMany` outside a confirmation.** The backend refuses it without
  `confirmation: true`, which only the two confirmation branches pass, after `activate(null)`.

## 6. Tests that must exist before the gate

- `orchestrator.test.ts`: a fake backend with a SESSION-SCOPED cache (a value that persists across
  methods within one `runMany` call and resets between calls), and a mutant killed only warm: the
  group path kills it with `killPosition > 1` after a replay that passes; the same suite with a
  prefix method that fails unmutated warm records `warm-prefix-unstable` naming THAT method, and
  `permissionsRefused` names that method when its text matches; the sequential path
  (`--no-group-runs`) records `survived`, the stated semantic difference; a position-1 `fail`
  takes the cold confirmation unchanged; a warm `timeout` whose replay completes k inside budget
  is `timeout-killed` with `killPosition`, one whose replay completes k outside budget is
  `warm-timeout-unconfirmed`; a replay answering `cap` is `warm-confirmation-incomplete`; the
  replay runs exactly the chunk's prefix when the killer sits in chunk 2 under
  `--max-methods-per-call 2`; a resumed run carries `killPosition`.
- `run-mutant-transport.test.ts`: a blank-mutant `runMany` round-trips; `enforceBudgets: false`
  never fires a stop or a budget abort and still honours the hard cap.
- Report/schema: `killPosition` optional, `session-warm` present iff `groupedCalls > 0`, the three
  causes in every enum, interpretation counts 18, snapshot updated, schemas regenerated,
  `explain` projection and test.
- Control app: `alc`; a source test pinning `PROGRESS_BETWEEN_FIRST` and `LOOP_READS_LEASE_ONLY`
  on `LC Run Many`'s new body as well as `LC Run Method`; `itest:hang`'s verdicts unchanged, its
  `groupedCalls` pinned as `scored + warmKills` with `warmKills` read from the report, and each
  named `timeout-killed` mutant's `killPosition` pinned to the number its ON-leg store shows on the
  first measured run.
- bcdev: 3/12/4, `killingTest` unchanged, **`warmKills` 0**, `groupedCalls` 15, every kill
  `killPosition = 1` (measured: no kill on this fixture is later than first).
- tables: 299/63/15, `killingTest` unchanged, **`warmKills` 13** and `groupedCalls` 375 (362 + 13),
  and three named mutants' positions pinned from run 334: `M0160` (batch 0, `ProcessedRequiresCategory`) 5,
  `M0164` (`FlaggedFiresModifyTrigger`) 4, `M0156` (`CategoryGuardNeedsCalcFields`) 2, so the field
  measures the order and not which branch ran. The forced-chunk arm keeps R198 §7's two campaigns.
- Run 4 on the sandbox: the 8 R206 mutants confirmed warm and still `killed`; the 20 changed
  killers unchanged from run 3; survivors' total below 2,400 s.

## 7. What refuses this design

- A `killed` or `timeout-killed` at `killPosition > 1` whose replay did not pass every prefix
  method (and, for a timeout, complete method k inside its budget).
- A kill at position 1 confirmed any differently from today.
- A gate whose `warmKills` or any pinned `killPosition` differs from its number.
- Run 4 slower on survivors than run 3.

---

## Findings of the review of revision 1 (2026-09-03), and what revision 2 does with each

| # | class | finding | revision 2 |
|---|---|---|---|
| F1 | 1 | `timeout-killed` at a warm position had no control and a cold budget | §2: the same replay, plus method k inside its budget; `warm-timeout-unconfirmed` |
| F2 | 1/2 | `killPosition = 1` on every gate kill was a non-sequitur (tables kills 13 at 2..5) and would be "fixed" vacuously | §2 states it is an ORDER fact; §6 pins `warmKills` as numbers (0 / 13), `groupedCalls` as `scored + warmKills` (15 / 375), and three named positions |
| F3 | 2 | the replay's stop behaviour unspecified; both existing paths end badly | §2/§3: stop hook on with the flag, no per-method budget without it, every replay end enumerated, none a quarantine |
| F4 | 2 | `unstable` reused for a PREFIX failure; diagnoses named the killer | §2: `warm-prefix-unstable`, diagnoses from entry j |
| F5 | 2 | E1/E7 measured uncommitted writes only | E12 measured: committed writes roll back too; §1, §5 |
| F6 | 3 | a replay `cap` called a server fault | §2: `warm-confirmation-incomplete` |
| F7 | 3 | ripple omissions (carried event, resume, explain, row parity) | §3, in full |
| F8 | 3 | the rebuilt loop's invariants unnamed | §4 names both and the ordering; §6 re-points the source test |
| F9 | 3 | a missing method moved to the per-mutant channel | §4 item 1: an entry with `error` and no `testResults` |
| F10 | 4 | suite lifetime under reuse unstated | §4 item 1: deleted at the start of every call |
