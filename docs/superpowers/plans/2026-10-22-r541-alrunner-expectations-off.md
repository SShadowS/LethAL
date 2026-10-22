# R-541 plan: turn off al-runner v2's expectations manifest and make sure its rewrites are never scored

Based on `measure.md` (same directory) and the orchestrator's approval of directions 1 to 3. This plan contains no code. It covers the v2 (.NET) backend only.

**v3 is out of scope.** v3 has no manifest; alpha.2 and edge were measured clean. `al-runner-v3-backend.ts`, `al-runner-v3-*.ts` and the v3 `serve` argv are NOT touched (another lane edits them).

New measurements for this plan (f06ee78c), all in `scratch/raw/p2-*`. They use project `scratch/proj2`: codeunit 79811 has an `OnRun` that hits an out-of-scope (OOS) refusal, and 79812 raises an ordinary `Error('Unexpected out-of-scope: invented by the test')`.

## 1. The empty folder

- **Owner and place.** A new module function, `emptyExpectationsDir()`, in `al-runner-transport.ts`. On first use in a process it creates the folder lazily with `mkdtempSync(join(tmpdir(), "lethal-r541-noexpect-"))` (mode 0700, random name). The process then reuses it. It is never a user path and never configurable.
- **Must stay empty.** Each call runs `readdirSync(dir)`, and when the result is not `[]` it throws `AlRunnerExpectationsDirError extends Error` (extending `Error` directly). If the folder is missing, it throws the same error rather than silently recreating it. al-runner itself exits 2 on a missing `--expectations` folder.
- **Cleanup.** `process.on("exit", ...)` calls `rmdirSync(dir)`, which is non-recursive, so it can only remove an empty folder. Failures are ignored, since a left-over empty folder in tmp is harmless.

## 2. Every v2 spawn site

The flag is `--expectations <dir>`. al-runner scans for flags anywhere on the argv (measured: the flag worked before `--auto-provision`, and on `--server`). It goes **right after `--output-json`** (argv positions 2 and 3). That keeps `isPredefinedProbeArgv`'s position arithmetic, which counts from `--test`, valid.

| Site | How the flag gets there |
|---|---|
| `al-runner-transport.ts` `buildAlRunnerArgv` | **Changed here.** A new optional third parameter, `expectationsDir = emptyExpectationsDir()`. |
| `OneShotTransport.run` (backend one-shot, and the canary through it) | via `buildAlRunnerArgv` |
| `al-runner-backend.ts` `provisionArgv` / `provisionOnce` | via `buildAlRunnerArgv` |
| `al-runner-contract.ts`, 4 calls (pass, fail and the others) | via `buildAlRunnerArgv` |
| `al-runner-predefined-probe.ts` `predefinedProbeArgv` | via `buildAlRunnerArgv`. **`isPredefinedProbeArgv` needs a change:** read the folder back out of the argv with a new `expectationsDirOf(argv)` (exactly one `--expectations` at index 2, and its basename starts with `lethal-r541-noexpect-`), then rebuild with that folder. A probe argv recorded in another process has a different random folder. |
| `al-runner-backend.ts` test-exact probe (`[path,"--output-json","--test-exact",NAME,dir]`) | **Own change.** Insert the pair after `--output-json`. Today a user's malformed manifest found from the working directory gives exit 2 there. |
| `al-runner-server.ts` `AlRunnerServer.start`: covers the backend daemon (`al-runner-backend.ts`), `al-runner-frame-probe.ts` `viaServer`, and `scripts/r517-probe` and `r300b-probe` | **Own change.** Append the pair after the subcommand **only when `subcommand === "--server"`**. The `"serve"` argv (v3 backend, v3 contract) stays byte-identical. |
| `itest/cli-default-leg.ts` `expectedOneShotArgvs` | **Needs a change.** Rebuild `provisionArgv` with the folder read from the recorded argv (`expectationsDirOf`). Otherwise the leg sees an argv it does not allow. |

The probes do not care about the flag's effect: their test rows have no OOS signal. Only the argv allow-lists above care about its position and value.

## 3. The new wording (measured)

- An active manifest, even an empty one, rewrites **every** row that carries an OOS signal. Its message becomes `Unexpected out-of-scope: <api> (reason: <reason>). Add an expect-oos entry under tests/expectations/ or implement the surface. (original result: <the row's old message>)`. The row's `expectation` becomes `fail-manifest-drift` (one-shot only) and **its status becomes `fail`**.
- **The OnRun prefix does not wrap the new wording. It ends up inside it:** `... (original result: The test codeunit's OnRun trigger failed, so none of its test methods ran (as in BC): RunnerOutOfScopeException: out-of-scope: ...)`. The OnRun row moves from `error` to `fail`. Its `errorKind` on `--server` stays `setup`; a body refusal stays `runtime`.
- **User text is caught too.** `Error('Unexpected out-of-scope: invented by the test')` is detected as a signal and wrapped: `Unexpected out-of-scope: invented by the test (reason: ). ... (original result: NavNCLDialogException: Unexpected out-of-scope: invented by the test)`. Without a manifest the same row is a plain `fail` (a kill today).
- **The rule, applied in `verdictFromRunnerTest` before today's `RUNNER_REFUSAL` check, for a `fail` or `error` row whose message starts exactly with `Unexpected out-of-scope: `:**
  - Take the original text: from the first ` (original result: ` to the final `)`.
  - If `RUNNER_REFUSAL` matches the original, score `error` / `runner-refused`, the same as R534 today.
  - Otherwise score `error` / `runner-test-error`. **Never a kill.** The only loss: a test whose own error text contains `out-of-scope: ` stops killing. That loses a kill, never invents one, and it behaves the same on one-shot and `--server`.
  - An ordinary message (`NavNCLDialogException: ...`, including one that only *contains* the wording) is unchanged and stays `fail`.
- **Other readers of the marker need no change.** `assertion-screen.ts` already matches `\bout-of-scope:\s` anywhere, and such rows no longer reach it as kills. `report.ts` only holds prose. Update the doc comment in `backend.ts` (`runnerRow`) to name the wrapped form.
- No new `SessionReport` field and no new `runnerRow` value, so no schema ripple.

## 4. The backstop

- Add `expectation?: string | null` to `AlRunnerRawTest`. `parseAlRunnerPayload` already passes the rows through.
- In `verdictFromRunnerTest`, **after** the step-3 check: a `string` `expectation` scores `error` / `runner-test-error`, never `fail` or `pass`. That also covers a `pass-*` row, so the backstop check goes **before** the `pass` return.
- **Order:** wrapped-wording check, then backstop, then `pass`, then the rest as today. The wrapped-wording check has to come first, or an undeclared OOS under our empty manifest would become `runner-test-error` instead of `runner-refused`.
- With our empty manifest, only the OOS-signal rows carry `expectation` (the classifier's no-entry branch; every other outcome returns the raw row). A clean run therefore never fires the backstop on its own. `--server` events have no field, so for them step 1 plus step 3 are the guard.
- v3 rows go through `verdictFromRunnerTest` too (the v3 backend builds `{status,message,durationMs}`, with no `expectation` and never this wording), so v3 is unaffected.

## 5. Tests, written first, each red-checked (revert the fix, see it go red, restore)

1. `buildAlRunnerArgv` puts `--expectations <dir>` at index 2. Red: drop the pair.
2. `AlRunnerServer` with `--server`: the start argv carries the pair (fake spawn). Red: drop it. This is the **only** guard on `--server`, so it is tested in both directions.
3. `AlRunnerServer` with `"serve"`: the start argv does NOT carry it. Red: add it unconditionally.
4. The test-exact probe argv carries it.
5. `isPredefinedProbeArgv` and the cli-default allow-list accept an argv recorded with another `lethal-r541-noexpect-*` folder, and reject a folder with any other basename.
6. `emptyExpectationsDir` throws `AlRunnerExpectationsDirError` on a non-empty folder (a file planted by the test, using a test-owned tmp root and never `/coord`). Red: remove the check.
7. Verdicts, using the measured rows verbatim from `raw/p2-v2-oneshot-empty.out` and `raw/v2-oneshot-suite-manifest.out`:
   - the drift `fail` of a test that really passed is not a kill;
   - `pass-oos`, `pass-known-gap` and `pass-divergence` rows are not a pass;
   - a body `Unexpected out-of-scope:` row becomes `runner-refused`, and so does the OnRun-original form;
   - the user-text wrapped row becomes `runner-test-error`, not a kill;
   - controls: a plain `fail` with `expectation` null stays a kill; a plain `pass` stays a pass; `NavNCLDialogException: Unexpected out-of-scope: x` (no wrapper) stays a kill.
   - Each one is red under its own revert.
8. Existing tests that pin the exact v2 argv will need their expectations updated: `al-runner-transport`, `-backend`, `-server`, `-provision`, `-platform-apps`, `-predefined-probe`, `-frame-probe`, `r551-test-exact-probe`, `cli-al-runner-defaults`, `port-wiring`, `publish-ceiling`, `symbol-fixture`, `layout-oracle`, `cli` (to be confirmed by running them). They should get an explicit folder through the new parameter.

## 6. Gate predictions (pre-commit)

- **`itest:alrunner`** (v2): no fixture has a `tests/expectations` folder above it (checked every ancestor of the r541 tree, plus `/`), no baseline contains `out-of-scope`, and no fixture test reaches a refusal. So the empty manifest changes no row: **all 8 baselines unchanged, per mutant**: 3/12/4, cli-default 3/12/4, LETHALA 5/4, LETHALB 5/4, layout 7/3, multiobject 6/1/5, wrapped 58/37/3, names 36.
  - The one expected risk is the cli-default leg's argv allow-list, which item 5 covers. A red there is a mechanism failure, not a figure change.
  - stderr gains `[expectations] loaded 0 entries from ...`. `compileFindings` ignores lines that are not markers.
- **`itest:alrunner-v3`**: no v3 file changes and the `serve` argv is byte-identical. But `verdictFromRunnerTest` is shared, so run it on the final head anyway: **Leg T 290 / 57 / 59 over 406, unchanged per mutant.**

## 7. Upstream

**Do not file.** The .NET v2 runner is frozen, upstream moved to Rust v3, and v3 has no manifest. `upstream-draft.md` stays only as evidence.

## Roadmap

When this lands, set R541's `status` to `done (<commit>)`. Its text says "v2 only; v3 measured clean on alpha.2 and edge".
