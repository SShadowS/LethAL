# R-534 plan r2: an al-runner row that is an ANSWER never aborts the session

## Changes from r1
- I1: `timeoutIn: "body" | "onrun"`, set on EVERY al-runner timeout. The confirm uses
  `measuredDurationMs` only on `"body"` and wall time otherwise, so it fails closed. S2's red-check
  changed.
- I2 + open Q3: D3 widened to the TYPE POSITION (`/^[A-Za-z_][\w.]*: out-of-scope: /`, also inside
  the OnRun-failure sentence). Refusals get their OWN cause, `runner-refused`. T5's other direction
  is a near-miss. CHANGELOG narrowed. Follow-up filed for the refusal kinds it does not match.
- I4: new S5 (R488/R491 `completed-accepted` refusals still abort).
- I5: the transport marks rows proven by a TEST-TIMEOUT-ABORT (`abortProven`). One
  `alrunner-timeout-wording-unrecognised` warning per session when such a row is not a timeout.
  Not required for D1. `errorKind` is not decoded.
- M1: `RUNNER_TIMEOUT_MESSAGE` anchored, with a near-miss test. M2: D4's note says "presumably".
  M4: ripple items named. M5: `skipped` rows named in the interpretation.
- I3, M3: see precommitment r2 (no escape hatch, one table, exact N, per-spawn log).
- Open questions answered: D3 stays (widened); no contract fact; two causes.
- F1-F3, M6, and the I2 leftovers listed as roadmap items for the builder to file.

Read `/coord/handoff/R-534/measure.md` first. Every al-runner claim below is measured there on
`2.12.0-main.43f76177`, or read from its source at 43f7617. Review:
`/coord/handoff/R-534/review-plan-opus.md`.

## The ruling for R534

Option **(b)**, which includes **(c)**. Spec §11 (layer-4 design: "Backend `error` outcome: retry
the same test once; a second error aborts the session") was written for a backend that FAILED to
answer. An al-runner row is an answer: al-runner ran the test, reported, and exited. Such a row is
never re-sent and never a §11 abort. It is a `timeout` when it provably is one. Otherwise it is a
per-mutant `error` with its own cause, and the session goes on. §11 keeps aborting for real
transport failures only (listed below).

## Measured shapes (from measure.md)

| Shape | One-shot exit / row | `--server` row | LethAL today |
|---|---|---|---|
| OnRun hang | 3, `error`, `The test codeunit's OnRun trigger exceeded the {N}s timeout, so none of its test methods ran.`, TEST-TIMEOUT-ABORT naming the test | `error`, same message, `errorKind: "timeout"` | retried (one-shot runs the hang twice), **session abort** (live) |
| Unexecuted UI handler | 1, `error`, `The following UI handlers were not executed: <h>` | same, `errorKind: "runtime"` | **session abort** (live) |
| OnRun throws | 1, `error`, `The test codeunit's OnRun trigger failed, so none of its test methods ran (as in BC): <Type>: <msg>` | same, `errorKind: "setup"` | retried, then abort |
| Out-of-scope refusal in a test BODY | 1, **`fail`**, `<Type>: out-of-scope: <api> — ...` (measured with `RunnerOutOfScopeException`; the source also throws `NavNCLDialogException` and `InvalidOperationException` with that message) | same, `errorKind: "runtime"` | **a kill** (live: Scope M0002) |
| `--server`, tests after a hung one | - | no row | `pre-dispatch-rejected`, retried from cache, abort |

`errorKind` is on `--server` only. So the shared signal is the message, matched with anchors, in
the one shared decode `verdictFromRunnerTest` (two decodes drift, R94).

## Design

### D1. A timeout row records WHERE it fired; an OnRun timeout is confirmed on wall time

`al-runner-backend.ts`:
- [r2 M1] Anchor `RUNNER_TIMEOUT_MESSAGE` to the measured forms:
  `/^(?:Test exceeded \d+s timeout\.|TIMEOUT after \d+s\.?)$/`. Today it is unanchored.
  `RaiseAfterTestMethodRun` (TestExecutor.cs ~1855) builds `... (test result before it: <msg>)`,
  so user text containing "Test exceeded 5s timeout" could be read as a timeout. (The R123 contract
  fact imports this regex. Its measured `Test exceeded 2s timeout.` still matches.)
- New exported `RUNNER_ONRUN_TIMEOUT_MESSAGE =
  /^The test codeunit's OnRun trigger exceeded the (\d+)s timeout, so none of its test methods ran\.$/`.
- `parseReportedStopMs(message)` parses both anchored forms (N > 0, N x 1000).
- `isTimeoutRow` is true for both, so `ensureServerSuite`'s `hungTest` names an OnRun hang.
- `verdictFromRunnerTest`: a non-`pass`/`fail` row that matches either regex is
  `outcome: "timeout"` with `reportedStopMs`, plus [r2 I1] `timeoutIn: "body"` (the
  `Test exceeded` / `TIMEOUT after` form) or `timeoutIn: "onrun"`. Every al-runner timeout verdict
  carries one of the two.

`backend.ts`: `TestVerdict.timeoutIn?: "body" | "onrun"`. Doc: "where the runner's stop fired.
`body`: the test's own figure (`measuredDurationMs`) is on the stop's clock. `onrun`: no pass row
reports the OnRun's time (measured: 66 ms body beside a 4 s OnRun). Absent (bcdev, whose measured
figure IS its wall time): the confirm uses the wall time." Internal only; not in the report.

`orchestrator.ts`, the R516/R517 cold confirm (`confirm.outcome === "pass"`):

```ts
const confirmMs = v.timeoutIn === "body" ? (confirm.measuredDurationMs ?? confirm.durationMs) : confirm.durationMs;
```

[r2 I1] This fails CLOSED: a timeout with no known location is judged on wall time, which can only
over-state it. bcdev does not change: its `measuredDurationMs` equals `durationMs`
(`BcDevBackend.run`). For `onrun`, the unconfirmed note says that al-runner does not report the
OnRun's own time. So the confirm's wall time was judged; it includes the OnRun, and on one-shot
the compile. Nothing else in the rule moves.

**No false kill.** The OnRun runs under the SAME `TestTimeout()` as a test body. So the mutated
OnRun ran longer than N s, which is at least `stopMs`. The unmutated OnRun took at most W, the
confirm's wall time. A kill needs `2W <= stopMs`, so mutated OnRun > 2 x unmutated OnRun. That is
R516/R517's guarantee. Using `measuredDurationMs` would compare the OnRun with the body's ~50 ms;
S2 pins that false kill.

**Cost (lost kills only).** W over-states: on one-shot it includes the compile, on `--server` the
whole suite. When the budget is `2 x baseline wall`, the confirm is a coin flip that may come back
`timeout-unconfirmed`. A real fix needs al-runner to report the OnRun's time (roadmap item 3).

One-shot: R518's `timeoutAbortTests` already accepts the measured exit-3 envelope (T1 uses it
verbatim). Neither al-runner transport has `runMany`, so every timeout is at position 1 and is
confirmed.

### D1b. [r2 I5] Wording drift stays visible

- `al-runner-transport.ts`: when `send` accepts an exit 3 through `timeoutAbortTests`, it marks
  each row that an abort line names with `abortProven: true` (new optional `AlRunnerRawTest` field).
  `timeoutAbortTests` already has the rule that matches a row to a line (check 5); reuse it.
- `verdictFromRunnerTest`: a row with `abortProven` that matches NEITHER timeout regex is still a D2
  `runner-test-error` (fail-closed, never a kill). Its verdict carries `timeoutWordingUnknown: true`.
- `orchestrator.ts`: on the first such verdict in a session, emit ONE warning,
  `alrunner-timeout-wording-unrecognised`: "al-runner stopped <test> at its timeout but the row's
  message <msg> is neither known timeout wording; such hangs are scored runner-test-error, not
  timeout-killed, until RUNNER_TIMEOUT_MESSAGE / RUNNER_ONRUN_TIMEOUT_MESSAGE learn it (R534)".
  This needs a session-scoped boolean and no new report field (warnings already flow through `emit`).
- D1 does not require the bit (`--server` has no abort line). `errorKind` is not decoded.

### D2. Any other answered non-verdict row: per-mutant `error`, cause `runner-test-error`

`verdictFromRunnerTest`, the branch for rows that are not a timeout, `pass` or `fail` (this includes
`skipped`, M5):
- Note: keep the `AL_RUNNER_UNCLASSIFIED_ERROR` prefix (tests pin it by name). New tail: "... NOT
  scored as a kill. al-runner answered, so it is not re-sent and does not stop the session (R534);
  if this is a timeout whose wording changed again, add it to RUNNER_TIMEOUT_MESSAGE."
- `operation: "completed-accepted"`. It was `pre-dispatch-rejected`, which is wrong: the test ran.
  `runOnce` no longer re-sends it (option (c)).
- New optional `TestVerdict.runnerRow?: "runner-test-error" | "runner-refused"` (a sibling of
  `stopRefusal`); here it is `"runner-test-error"`.

`orchestrator.ts`:
- `coveringRuns`' `single()` lifts `runnerRow` into the step's cause, exactly as it lifts
  `stopRefusal`. `CoveringStep.cause` widens to
  `RunManyCause | "runner-test-error" | "runner-refused"` (`RunManyCause` stays bcdev's group
  causes). The lift keys on `runnerRow` ONLY, never on `operation === "completed-accepted"` (S5 pins
  why).
- `classifyNonVerdictStep` is unchanged. Its `step.cause !== undefined` branch records the cause and
  the row's message and never sets `transportError`.
- Baseline: the row is not retried. It is non-green and excluded, as before.
- If the unmutated confirm returns such a row, the existing `unstable` branch handles it (unchanged).

### D3. [r2 I2] A refusal is not a kill: cause `runner-refused`

`verdictFromRunnerTest`: a `fail` OR `error` row whose message matches

```ts
const RUNNER_REFUSAL = /^(?:The test codeunit's OnRun trigger failed, so none of its test methods ran \(as in BC\): )?[A-Za-z_][\w.]*: out-of-scope: /;
```

is `outcome: "error"`, `operation: "completed-accepted"`, `runnerRow: "runner-refused"`.

- Why the type position: it is what al-runner writes (`{Type.Name}: {Message}`), and every refusal
  message starts with `out-of-scope: ` (`OutOfScopeMessage.Prefix`). That covers the Cecil-injected
  `NavNCLDialogException` and `InvalidOperationException` throws too (e.g. `NclCecilRewrite.Reports.cs`).
- A user `Error('out-of-scope: ...')` would also match and lose a kill. That is the safe direction.
- A user message that merely CONTAINS the phrase (`NavNCLDialogException: expected 3, got out-of-scope: x`)
  does not match.
- This moves a verdict from killed to error, always the safe way.

### D4. `--server`: a test with no row because an earlier test timed out

`runViaServer`, the no-row branch: when `suite.hungTest !== undefined`, return
`operation: "completed-accepted"` and `runnerRow: "runner-test-error"`. [r2 M2] The note says:
"al-runner --server stopped the run at X (timeout); this test has no row, presumably because it
came after X; not measured". With no hung test the branch is unchanged: `pre-dispatch-rejected`,
retried, then §11.

### Causes: two new `MutantErrorCause` values

- `runner-test-error`:
  - Meaning: "al-runner ran the test and answered with a row that is not a verdict about the mutant:
    an OnRun-trigger failure, an unexecuted UI handler, an unsupported test signature, a `skipped`
    row, a timeout in wording this build does not know, or no row because the run stopped at an
    earlier test's timeout. Not measured; never a kill. On bcdev, BC's test runner reports most of
    these as a failed test."
  - Prescription: read the note.
- `runner-refused`:
  - Meaning: "the test reached a surface al-runner refuses (`out-of-scope: ...`), so whether the
    mutant changes its outcome on BC is unknown. Not measured; never a kill."
  - Prescription: such a test cannot be measured under al-runner; run it on bcdev.

No existing cause fits: `unstable` means "fails unmutated too"; `group-run-error` means bcdev's
group call raised; `deadline-exceeded` is our own timer.

**Schema impact: yes.** Use R516's commit `a29e3187` as the template. [r2 M4] The items:
- `report.ts`: `MutantErrorCause`, `ERROR_CAUSE_INTERPRETATIONS`, and `errorBreakdown`'s `named` list.
- `explain.ts`: `EXPLAIN_SCHEMA_VERSION` 15 -> 16 and its version-history doc line. Hand-write
  `schemas/explain-v16.schema.json`.
- Run `bun scripts/generate-schemas.ts` for the `report-v3` / `stream-v1` enums.
- `schemas/README.md`: its explain row.
- `docs/using-lethal-from-an-agent.md`: the v15 schema link (~line 275).
- `tests/schemas.test.ts`: the cause enum pins, the explain file map (~1308) and the
  `required(v16) == required(v15)` pin (~1614).
- `interpretation.test.ts` / `report.test.ts`, if they count causes.

There is no new `SessionReport` field, so no sample report needs regenerating. If gift-card's has
to change, stop and report.

### What stays a §11 abort (pinned by S4 and S5)

- One-shot `res.kind === "error"`: spawn failure, no envelope, exit 2/4/6, an exit 3 that is not a
  proven timeout abort, or a compile failure.
- A `--server` start or request failure.
- A missing row with no hang, including a row named `<ctor>` (roadmap item 7).
- R488/R491's `completed-accepted` refusals with no `runnerRow`: a merged or duplicate result is a
  contract violation.

`deadline` keeps its existing `deadline-exceeded` cause, which does not abort.

## Tests (offline, no wall-clock asserts, each direction red-checked with the Edit tool)

Backend (`al-runner-backend.test.ts`, describe `AlRunnerBackend: an answered row never aborts (R534)`):
- **T1 REPRO (red today)**: measure.md A1's envelope verbatim (N = the budget, 20 s), exit 3,
  through `runOnce`. Expect `timeout`, `reportedStopMs: 20000`, `timeoutIn: "onrun"`, ONE spawn.
  Today it is `error` with 2 spawns. Red-check: delete D1's OnRun branch.
- **T1b**: a body timeout row gets `timeoutIn: "body"`. Red-check: omit it (S2's third case shows
  the effect: wall time is used).
- **T2**: the `--server` OnRun timeout row (measure.md B verbatim) gives `timeout` with `onrun`, and
  the daemon is closed (R517's I-1 test is unchanged).
- **T3 REPRO (red today)**: HandlerUnused, `unsupported test signature (1 params)` and a `skipped`
  row, one-shot, through `runOnce`. Expect `error`, `completed-accepted`,
  `runnerRow: "runner-test-error"`, ONE spawn. Red-check: restore `pre-dispatch-rejected` (2 spawns).
- **T4**: these near-misses stay `runner-test-error`, never `timeout`:
  - OnRun wording with `20s` removed, with a trailing word, and with `TIMEOUT`;
  - [r2 M1] body: `An OnAfterTestMethodRun subscriber ... failed: ... (test result before it: Test exceeded 5s timeout.)`;
  - body: `Test exceeded 5s timeout. extra`.

  Red-check: drop each regex's anchors, one at a time.
- **T5** (D3): each of these is `runner-refused`:
  - OosInBody's `fail` row verbatim;
  - an `InvalidOperationException: out-of-scope: NavReport.Run` `fail` row;
  - AfterOosOnRun's `error` row.

  Other direction [r2 I2]: `NavNCLDialogException: expected 3, got out-of-scope: x` stays `fail`.
  Red-checks:
  - drop the rule: the first three go to `fail` or `runner-test-error`;
  - make it a substring match: the near-miss goes to `error`.
- **T6** (D4): a `--server` suite with a hung row and no row for the wanted test gives
  `completed-accepted` and `runner-test-error`, a note that contains "presumably", and one `run()`.
  With NO hung row: `pre-dispatch-rejected`, retried. Red-check both.
- **T7** (D1b): an exit-3 envelope whose abort line names a row with message `Watchdog stop.` gives
  `runner-test-error` and `timeoutWordingUnknown: true`. The same row on exit 1 (no abort line) has
  no flag. Red-check: set the flag whether or not `abortProven` is set.
- The R518 test "an OnRun-trigger exit 3 is accepted as rows but scored a fail-closed error" uses
  an invented message and stays green; it now also carries `timeoutWordingUnknown`. Update its comment.

Orchestrator / session:
- **S1 REPRO (red today)**: new file `packages/runner/tests/r534-runner-rows.test.ts`, harness from
  `r518-oneshot-timeout.test.ts` (real `AlRunnerBackend` + `runSession`; the fake tells mutated
  from unmutated by the active selector file, never by call order).
  - (a) Mutated: the exit-3 OnRun envelope; unmutated: pass. Expect `timeout-killed`,
    `killPosition` 1, one confirm spawn. Today `runSession` rejects with `backend transport error:
    two consecutive run() failures ... spec §11`. Red-check: delete D1's OnRun branch.
  - (b) Mutated: the HandlerUnused row, plus a second mutant that is killed normally. The session
    completes; the first mutant is `error` `runner-test-error` with ONE mutated spawn, the second is
    `killed`. Red-check: drop the lift.
  - (c) [r2 I5] Two mutants with the T7 envelope give exactly ONE
    `alrunner-timeout-wording-unrecognised` warning. Red-check: drop the session boolean (two warnings).
- **S2 (false-kill guard)**: a ClockBackend beside R517's tests in `resume.test.ts`. Mutated
  `{timeout, reportedStopMs: 20000, timeoutIn: "onrun"}`, budget 20000, confirm
  `{pass, durationMs: 15000, measuredDurationMs: 50}`: expect `timeout-unconfirmed`. [r2 I1]
  Red-check: set `timeoutIn: "body"` on the OnRun verdict; it goes `timeout-killed`.
  - Other direction: confirm `durationMs: 5000` gives `timeout-killed`. Red-check: make `onrun`
    always unconfirmed.
  - Third: the same timeout with `timeoutIn` ABSENT is judged on wall time, so `timeout-unconfirmed`
    at 15000. Red-check: restore r1's `=== "onrun"` test.
- **S3**: HandlerUnused at baseline gives one spawn; the test is non-green and excluded; the session
  completes. Red-check: restore `pre-dispatch-rejected` (2 spawns).
- **S4 (control)**: exit 2 with empty stdout on the mutated run, twice: `runSession` rejects with
  the §11 text. Red-check: give one-shot `kind: "error"` a `runnerRow`; no rejection, red.
- **S5 [r2 I4] (control)**: the mutated one-shot returns TWO rows with the requested name (R491):
  `runSession` rejects with the §11 text. Red-check: lift the cause on
  `operation === "completed-accepted"` instead of on `runnerRow`; no rejection, red.
- Ripple tests follow the schema list. Every R516/R517/R518 test stays green untouched, apart from
  the R518 comment.

## Live evidence

Pre-commitment r2 is `/coord/handoff/R-534/precommitment.md`. The coordinator commits it to master
as `docs/superpowers/specs/2026-10-09-r534-alrunner-precommitment.md` before any live run.
- **Part A**: `itest:alrunner`. Every frozen figure and per-mutant verdict unchanged.
- **Part B**: one local evidence run, `scripts/r534-probe/run.ts`, both legs. It is not a gate, but
  a miss keeps R534 at "fixed in <commit>, live gate pending".

## Builder rules (as R-518)

- Use the Edit and Write tools for every file, including red-check reverts and restores. No
  `sed -i`, heredocs, `cat >>`, `cp`, or shell redirects into files. To copy the probe into the
  repo, read each file and Write it.
- Never read `lethal.config*.json`. Typed errors extend `Error` directly (none planned).
- Verify loop: `bun run typecheck`, `rm -rf packages/*/dist`, `bun scripts/verify.ts`;
  `bunx biome check` on touched files only.
- `scripts/r534-probe/` holds:
  - `run.ts`, from the session mode of `/coord/handoff/R-534/probe/probe.ts`, with relative imports;
  - `app/` and `tests/`, from `/coord/handoff/R-534/session/`, with byte-identical AL.

  [r2 M3] `run.ts` logs EVERY spawn with the active selector's mutant id and its `--test`, and every
  timeout row's message and reported stop. It checks the pre-commitment's tables and exits 1 on any
  miss.
- Roadmap:
  - R534's status is `fixed in <commit>, live gate pending` until Part A passes and Part B matches;
    then `done (<commit>)`.
  - Add the ruling ((b) with (c), two causes) to R534's text, and correct its premise: a refusal in
    a body is `fail`, not `error`, and an unexecuted handler is the commonest abort.
  - File the roadmap items below. Re-check the next free id (`ls docs/roadmap/`) before EACH.
  - Run `bun scripts/roadmap-index.ts` and `bun test scripts/line-citations.test.ts`.
- Prose: add the row-shapes table from measure.md to `docs/measurements/README.md` §"al-runner v2".
- CHANGELOG `### Fixed` [r2 I2, narrowed]: "al-runner: a test row al-runner reports as `error` no
  longer aborts the session. A hang in a test codeunit's OnRun trigger is scored `timeout` and
  confirmed unmutated on the confirm's wall time (al-runner does not report the OnRun's own time).
  An unexecuted UI handler, a failing OnRun and similar rows are a per-mutant `error`, cause
  `runner-test-error`, and are not re-sent. A test that fails with al-runner's `out-of-scope: `
  refusal (any exception type) is `error`, cause `runner-refused`, no longer a kill. Spec §11's
  abort is kept for real transport failures (R534)."
- No snapshot should change except the schema pins. If any other moves, stop and report.
- Get an Opus review of the final built diff before submit.

## Roadmap items for the builder to file (not built here)

1. al-runner rows that bcdev would score `fail`: an unexecuted UI handler and a failing OnRun are a
   failed test on BC, but `runner-test-error` here. Needs one BC measurement per shape.
2. `--server`, D4's lost kill: when a covering test has no row because a covering test LethAL orders
   later hung, LethAL could skip ahead to the hung test.
3. Upstream al-runner: report the OnRun's time on a pass row (gives D1 a tight figure), and add
   `errorKind` to the one-shot row.
4. [I2] Refusals D3 does not match: `BcShapeGapException`, `BcAppSymbolReadException`, and a
   refusal trapped by a `[TryFunction]` (`[oos-in-try]`). These can produce a kill or a pass from a
   refusal.
5. [F1] al-runner auto-discovers `tests/expectations`:
   - FailManifestDrift turns a pass into `fail`: a false kill.
   - PassOos turns a failure into `pass`: a lost kill.

   Flag or refuse rows that carry an `expectation`, or turn discovery off.
6. [F2] A `fail` row whose exception type AL cannot raise (`NullReferenceException`,
   `NotImplementedException`) is an al-runner bug, but it is scored as a kill.
7. [F3] A `<ctor>` (or `<OnBeforeCodeunitRun>`) row aborts the session through "no test named ...".
8. [M6] A baseline OnRun hang on `--server` ends the suite, which silently shrinks the green set and
   its coverage. Add one warning that names it.
