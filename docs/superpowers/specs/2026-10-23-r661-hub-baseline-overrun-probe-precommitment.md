# R-661 pre-commitment: what does a hub-mode baseline overrun leave on BC?

Committed by lethal-bugs on 2026-10-23, before any lease or server call for R-661.

**What it covers.** The probe on `lethal/r661`, head `5b9190b1f126ff221fa402ab55b5dd57de08c508` (probe tree
`562db036586c2a3075053056b7c5723888c8099c`):
- the app `scripts/r661-hub-probe/app` (one read-only web service);
- the driver `scripts/r661-hub-probe/drive.ts` (listed in `scripts/typecheck-excluded.json`, like R658's);
- the lease wrapper `scripts/r661-hub-probe/run-probe.sh`.

**Background:** R661 (`docs/roadmap/R661.md`); R658 (`docs/roadmap/R658.md`, `docs/measurements/r658/`).

## 1. The question

R658 stops every unmutated run that goes through LethAL Control. A bcdev baseline in a hub coverage mode does not:
`BcDevMcpBackend.run` sends `coverage` `procedure` or `line` to bc-dev-mcp's TestRunnerHub (`runOnHub`), a SignalR
connection to BC's own test runner. When the budget runs out, LethAL stops waiting; the hub call is not cancelled.

1. Once LethAL gives up, does BC's test session keep running? And once LethAL closes the hub connection?
2. Does a hub run touch LethAL Control's op marker or control-app lease?

**Two code facts, read before the run (no server needed):**
- **F1: `line` cannot be reached on bcdev.** `capabilities().coverage` is `cfg.coverageMode`, typed
  `"procedure" | "none" | "fenced"` in `BcDevConfig` and in the config file's `bcdev.coverageMode` (`cli.ts`). Only
  `run`'s routing predicate and `runner-disagreement.ts` still name `line`. The probe measures it anyway, by calling
  `run` with `coverage: "line"` directly, because the brief asks for it.
- **F2: a hub baseline overrun already fails safe.** `runOnHub` answers `deadline-exceeded` with
  `operation: "in-flight-unknown"`. `runBaselineTest` (`orchestrator.ts`) then latches unsafe, writes a tier
  quarantine, and stops the session (unit test: the "baseline test in-flight-unknown" quarantine in
  `orchestrator.test.ts`). So the next session on that server is refused until the quarantine is cleared. The note
  says nothing about the hub, or why the run could not be stopped.

**It changes no product code.** It adds one throwaway app, a driver, a wrapper, and (from the run)
`docs/measurements/r661/`.

## 2. The server, the lease and the cost

- **bc3 only.** The driver refuses (exit 2) unless `--server bc3` and `kraken coord holder bc3` names lane bugs. It
  makes no server call before that check. bc3 holds the hang fixture (tests app 1.0.0.4) that `itest:hang` passed on
  at 07:23Z today.
- **The lease:** `run-probe.sh` refuses when `/coord/machine/out-of-use/bc3.md` exists, takes
  `kraken coord lease bc3 bugs`, heartbeats every 60 s, runs the driver in the foreground, and releases only on driver
  exit 0, 1 or 2. Any other exit or a signal HOLDS the lease and writes the out-of-use marker.
  - Count the heavy jobs and check bc3 is free BEFORE leasing.
- **The cost:** about 3 minutes on the lease: C a few seconds, each H case 35 s, publish and removal about a minute.
- **The login** is read inside the driver from the secret file and is never printed.

## 3. The app (compiled offline 2026-10-23, before any lease)

- **Compiler:** alc 18.0.43.1464 (`$LETHAL_ALC_DIR`), against
  `/coord/cache/bc-symbols/bc3/28.0.54946.56477-6725e7bb/Microsoft_System.app`. Exit 0, no diagnostics.
- **Output:** the gitignored `scripts/r661-hub-probe/build/bc3/probe.app`, sha256
  `1ed257a92ef88cb09b32e28c792ff2cf6931918d5fbb6c8faa67afcec303ea0d`. The driver records the sha256 of the file it
  publishes.
- **"LethAL R661 Hub Session Probe"** (`b6f3e0a2-5c41-4e7d-9a18-61c2d7f4e905`), ids 92960-92969, no dependency:
  - codeunit 92960 `ListSessions()`: every `Active Session` row the caller can see, as
    `id/clientType/loginDatetime/serverInstanceId;`. It writes nothing.
  - codeunit 92961, an Install codeunit that registers it as the web service `R661ProbeSessions`.
- **The id check:** `git grep` finds no `9296x` object id and neither the GUID nor the service name outside the probe.
  `/coord/handoff/*/probe` holds no `9296x`. The driver reads the app id absent (0 rows) before it publishes, or it
  fails without publishing.
- R53 measured that a web-service session cannot see itself in `Active Session`. The driver reads only other
  sessions, by difference.

## 4. The cases, in this order: C, H-line, H-procedure

All three run `Hang Z Baseline Tests` (codeunit 79451) through a fresh `BcDevMcpBackend` (its own bc-dev-mcp child),
built from `bcdevSection`'s fields, with a 10 000 ms budget, exactly as a baseline calls `run`.

| Role | Test | Body | Coverage |
|---|---|---|---|
| C | `ZPassesAfterTheStoppedTest` | empty: the hub works at all | `procedure` |
| H-line | `SleepsPastTheBaselineBudget` | `DrainQueue(3)`, then `Sleep(25000)` | `line` |
| H-procedure | `SleepsPastTheBaselineBudget` | same | `procedure` |

**Per H case, from dispatch (t = 0):**
- the session list before dispatch;
- reads at +5 s, +12 s, then `backend.close()` at +13 s (the bc-dev-mcp child ends, so the hub connection closes),
  then reads at +16 s, +21 s and +35 s;
- the sessions that "appeared" are those in the +5 s read and not in the read before dispatch. Each later read records
  which of them are still listed.
- The test's own Sleep ends at about +25 s, so +16 s and +21 s fall after the close and before the natural end.

**Before the first case and after the last:** LethAL Control's op marker (`GetOperationStatus`, no lease), and after
the last case one control-app acquire and release.

## 5. The readings

Per case: LethAL's verdict (`outcome`, `operation`, `durationMs`, `failureMessage`); what `runBaselineTest` does with
it (`baselineReading`); the appeared sessions and, per read, which are still listed, with the raw rows; the time of
the close. Then the op marker before and after, the final acquire and release, and the removal steps.

## 6. Predictions (stated before the run)

- **C:** `pass` in under 5 s, `baselineReading` green.
- **H-line and H-procedure:** `deadline-exceeded` with `in-flight-unknown` at about 10 000 ms; `baselineReading`
  quarantine (F2).
- **Sessions:** at least one session appears at +5 s and is still listed at +12 s, while the hub is open.
  - After the close, low confidence: gone by +16 s, because BC ends a test runner session when its hub connection
    closes. The alternative is listed at +16 s and +21 s and gone by +35 s, at its Sleep's end.
- **Op marker:** unchanged; the final acquire is granted. A hub run never touches LethAL Control.

## 7. Decision table

Read the rows in this order; the first row that matches wins. A row is judged over BOTH H cases.

| Row | What is read | R661 outcome |
|---|---|---|
| S | a session that appeared is still listed at +35 s; or the op marker moved; or the final acquire is refused | STOP rule (§8). No outcome until the owner's restart and a re-read. |
| N | no session appears at +5 s in an H case | Liveness is not readable this way. Outcome as row L (the conservative one). |
| L | an appeared session is still listed at +16 s or +21 s in an H case | The session outlives LethAL and the hub. F2's quarantine is what keeps the next session off the server, and it is required. **Outcome: refuse by name.** The hub baseline's quarantine note names the coverage mode, says the hub cannot stop a baseline test, and points to the default `fenced`. A red test per direction: the note in `procedure` mode, and its absence for a `fenced`/`none` baseline. |
| E | every appeared session is gone by +16 s in both H cases | The session ends with the hub connection, which LethAL closes when its session ends. F2's quarantine is conservative but safe, and nothing outlives the session. **Outcome: close by ruling,** docs only: `line` is unreachable (F1), `procedure` is due for deletion and its overrun already quarantines (F2). |

**"Wire an equivalent stop" is not chosen in any row:** `procedure` is due for deletion (`coverageMode`'s doc
comment) and `line` cannot be reached (F1), so a new stop path would serve only a mode on its way out.

## 8. The STOP rule

On row S; on any failure or crash while a session may be live (from an H case's dispatch until its +35 s read
lists none of its sessions); or on a signal: no removal and no further case. The driver exits 5, and the wrapper
keeps the coord lease and writes `/coord/machine/out-of-use/bc3.md`. The release comes after the owner's restart and
a clean `bc-linux-setup.ts --server bc3`.

## 9. What stays on the server

The probe app is uninstalled and unpublished at the end (each HTTP 204, then 0 rows by id). Nothing else is written.
