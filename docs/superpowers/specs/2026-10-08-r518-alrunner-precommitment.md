# R-518 pre-commitment r2: itest:alrunner (Part A) and one live evidence run (Part B)

[r2] Rewritten after `/coord/handoff/R-518/review-r1-opus-adversary.md` (I1, I2, I3, I4) and the
coordinator's decisions. r1 proposed a permanent `itest:alrunner` leg over `sandbox-hang`; [r2] (I4)
there is NO permanent leg. R518 closes on the offline tests, the contract-probe fact (Part A) and
one evidence run (Part B).

Written 2026-10-08, before any code change and before any live run. al-runner build:
`2.12.0-main.43f76177` (`/work/tools/al-runner/current`). Commit this as
`docs/superpowers/specs/2026-10-08-r518-alrunner-precommitment.md` BEFORE either run.

## Part A. `itest:alrunner`: the existing figures do not move, and the new contract fact passes

The fix (plan D1) changes one thing: an al-runner ONE-SHOT exit 3 whose envelope proves a test
timeout is read as results. That can change a verdict only on a run where some test hits
al-runner's in-run stop. No existing leg has one:

- Every committed al-runner baseline holds only `killed`, `survived` and `no-coverage`
  (`al-runner`, `.cli-default`, `.layout`, `.multiobject`, `.symbols-lethala`, `.symbols-lethalb`,
  `.wrapped`). No `timeout-killed`, no `error`.
- Both R-517 runs of `itest:alrunner` on 43f76177 (`/coord/handoff/R-517/itest-alrunner-run1.log`,
  `run2.log`) contain no `timeout-killed`, `timeout-unconfirmed`, `TEST-TIMEOUT` or `exceeded`.
- The `--server` and resource legs do not use `OneShotTransport`.
- The canary's probes do not hang (a hang would stay `inconclusive` either way).

Predicted, every leg, per mutant: verdict, killing test, `killPosition`, counts and every other
pinned figure IDENTICAL to the committed baselines and to R-517's run 2. Main fixture 3 / 12 / 4
(one-shot, `--server`, resource legs), symbol sets 5 / 4 / 0 each, layout 7 / 3 / 0, and the
multiobject / wrapped / cli-default legs as committed. Any difference is a BLOCK.

[r2] (I4) **The new contract fact must pass in every session.** The R123 contract probe's step 4
times a test out at `HANG_TIMEOUT_SECONDS = 2`. Inside `runSession` it runs only when the session
pinned a platform-app directory and the backend knows its al-runner path (`SessionConfig.alRunnerContractProbe`'s
doc: in practice the ONE-SHOT legs); the CLI also runs it before a session. Plan D1b's new fact
(e.g. `timeout-exit-readable`) must read `matches` on every leg of the gate run that runs the probe. Predicted on 43f76177: the probe's hang run exits 3, `timeoutAbortTests` returns
its row, the message matches `RUNNER_TIMEOUT_MESSAGE`, and `parseReportedStopMs` gives exactly
2000. A `diverged` or `unmeasurable` is a BLOCK. The builder states in the submit note where the gate
log shows the fact (and, if the gate does not print contract facts, adds an assertion or reads it
from each leg's report).

## Part B. One live evidence run of `sandbox-hang` through al-runner one-shot (not a gate)

### How it is run [r2]

- Script: `scripts/r518-probe/run.ts` (written with Write; throwaway, committed beside
  `scripts/r517-probe/`). It reads NO config file. It imports from `../../packages/runner/src`
  (relative, as `scripts/r517-probe/probe.ts` does) and does what one `al-runner.itest.ts` one-shot
  leg does (`runAlRunnerLeg`'s body):
  - `alRunnerPath = process.env.LETHAL_ALRUNNER_PATH` (refuse to start if unset);
  - a scratch root from `mkdtemp(join(tmpdir(), "r518-"))`; a `ResultsStore` on
    `<scratch>/lethal.sqlite`;
  - `new AlRunnerBackend({ alRunnerPath, instrumentedDir: <scratch>/instrumented,
    testDir: fixtures/sandbox-hang-tests, selectorObjectId, coverage: "al-runner" }, countingSpawn)`:
    ONE-SHOT (no `serverMode`), static selector. `selectorObjectId` / `selectorIds`: reuse
    `hang.itest.ts`'s `SELECTOR_IDS` if inside `fixtures/sandbox-hang/app.json`'s `idRanges`, else
    pick a free id in that range and say which;
  - first check `alRunnerCoverageSupport(fixtures/sandbox-hang)` as the itest does; if it says
    unsupported, use `coverage: "none"` and say so;
  - `runSession({ backend, store, projectDir: fixtures/sandbox-hang, testDir:
    fixtures/sandbox-hang-tests, instrumentedDir, selectorIds, mutantTimeoutMs: 20000 })`;
    default baseline timeout; no `--only`;
  - [r2] (I2) `countingSpawn` wraps `defaultSpawn` and counts spawns per `--test` value AND per
    active mutant (read the active selector file in `<instrumentedDir>/active` before each spawn,
    or record the order of `activate` calls by wrapping the backend). This is what shows a hung test
    was sent once, not the store (which holds one row either way);
  - prints the report's per-mutant table (line, operator, verdict, killPosition, killing test,
    cause), every test row with outcome `timeout` (its failure message and `reportedStopMs` if the
    store keeps it, else from a `run()` wrapper), the spawn counts, and writes the report JSON to
    the scratch dir (`--out`-equivalent); then closes the backend and store.
- Command, from the worktree root, one run, foreground, bounded:
  `timeout 1800 bun scripts/r518-probe/run.ts` (with `LETHAL_ALRUNNER_PATH` already set in the
  container). Save the console output into `/coord/handoff/R-518/evidence-run.log` with the Write
  tool (read the output, then Write it; no shell redirect into the handoff).
- No lease: no BC is involved, al-runner is local. No coord lease, no Cronus. Respect the container's
  job limits (it is not a BaseApp job; run it alone anyway).
- Optional live red: the same script on master (before the fix). Predicted: the session REJECTS at
  the first hang with `backend transport error: two consecutive run() failures for mutant <id>
  (test <m>) — aborting session per spec §11`, after two spawns of that hung test. Worth one run if
  time allows (about 2 minutes to the first hang).

### Pre-committed: the five structural hangs

Keys as in `hang.itest.ts` `EXPECTED_ON`, lines of `fixtures/sandbox-hang/src/HangLogic.Codeunit.al`:

| line | operator | verdict | killPosition |
|---|---|---|---|
| 37 | `lethal.void-method-call` | `timeout-killed` | 1 |
| 43 | `lethal.empty-block` | `timeout-killed` | 1 |
| 44 | `lethal.remove-assignment` | `timeout-killed` | 1 |
| 73 | `lethal.remove-assignment` | `timeout-killed` | 1 |
| 145 | `lethal.void-method-call` | `timeout-killed` | 1 |

For each of the five:

- [r2] (I3) its killing test's mutated test row has outcome `timeout`; its failure message matches
  `RUNNER_TIMEOUT_MESSAGE` and `parseReportedStopMs(message) >= 20000` (NOT the exact text
  `Test exceeded 20s timeout.`: the budget is `max(2 x baseline wall clock incl. compile, 20000)`,
  so N can be above 20);
- exactly ONE unmutated cold confirm (one confirm spawn of the killing test with no active mutant
  after the mutated spawn), so 5 cold confirms in all;
- [r2] (I2) exactly ONE mutated spawn of the hung test for that mutant (from `countingSpawn`, never
  from the store);
- [r2] (I3) no check of the form `2 x duration_ms <= BUDGET` on the store row: on al-runner the
  store row is the wall clock, while the orchestrator judges `measuredDurationMs`. The kill itself
  is the evidence the confirm passed the rule.

For the session: it COMPLETES (no rejection, no session abort, [r2] I1); `baselineGreen` true;
`groupedCalls` 0; `warmKills` 0; exactly 5 `timeout-killed`; zero `timeout-unconfirmed`.

Any of these failing blocks R518's close.

### Recorded, not pre-committed: the other 33 rows

The other 33 rows of `EXPECTED_ON` (38 in all) have never run on al-runner. They are recorded as
OBSERVATIONS in the evidence log, beside the bcdev ON table's verdict for each. Coverage grain and
arithmetic may differ on al-runner (line 65's covered-but-unreached survivor and line 62's
`empty-block` survivor are the most exposed). A non-hang difference is a FINDING: the builder files
it as a roadmap item (re-check the next free id first), and it does NOT block R518. An `error`
verdict on any of them is still reported by name with its note, because an `error` there could be
D2's unclassified-row path (plan D2, last point).

## Cost

Part A: the usual `itest:alrunner` run plus one contract fact (no extra spawn; it reads the
existing hang run). Part B: five hangs at about 20 s stop plus compile each (measured: 22 s for
one), five short confirms, plus about 60 single-test one-shot calls at 2 to 6 s each: roughly 6 to
8 minutes, once.
