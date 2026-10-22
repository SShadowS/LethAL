# R-649 pre-commitment: BC's own Sleep under LethAL's baseline call, and what it means for X (d)

Lane bugs committed this file to master on 2026-10-22, before any run against a server.

**What it covers.** The probe is committed on `lethal/r649`, head `d7b0f413`:
- the apps `scripts/r649-bc-probe/target` and `scripts/r649-bc-probe/tests`;
- the driver `scripts/r649-bc-probe/drive.ts`;
- the README `docs/measurements/r649/README.md`, which also holds the id check.

It follows R639's probe (`scripts/r639-bc-probe/`, `docs/measurements/r639/`).

**Background:**
- R649 (`docs/roadmap/R649.md`);
- r10 §(c) (`docs/superpowers/specs/2026-10-22-r586-alrunner-v3-precommitment-r10-legt-order.md`);
- plan §6 (`docs/superpowers/plans/2026-10-21-r586-alrunner-v3-backend.md`).

**Orchestrator ruling:** measure a Sleep shorter than the timeout as well, so that X (d) can be re-cast on either side
of the 120 s line. Case 2 below does this.

## 1. What it changes

**It changes no product code.** It adds only:
- two throwaway AL apps;
- a driver script, listed in `scripts/typecheck-excluded.json`;
- a measurement folder.

No verdict rule, gate, baseline or pre-commitment moves. Re-casting X (d) needs its own delta on the R-586 gate. That
delta is written from this probe's readings, AFTER this run (step 2 of R649).

## 2. The server, the lease and the cost

- **The server:** whichever of `bc1`, `bc2` or `bc3` is free. The driver takes `--server bcN`, and each server has its
  own build of the apps (§3).
- **The lease, before the run:**
  - First count the heavy jobs and get the server's go. Then run `kraken coord lease bcN bugs`.
  - The driver refuses (exit 2) unless `kraken coord holder bcN` names lane bugs. It makes no server call before that
    check.
- **The lease, after the run:** release it as soon as the driver exits, then fill `lease.releasedAt` in the JSON.
- **The cost:** about 25 minutes on the lease.
  - Each 600 s case can take up to 720 s, the driver's follow-up cap.
  - The two short cases take seconds.
  - Publish and removal take about a minute.
- **The login** is read inside the driver from the secret file, and is never printed.

## 3. The apps (compiled offline 2026-10-22, before any lease)

The compiler is alc 18.0.43.1464 (`$LETHAL_ALC_DIR`). Each server's build compiles against two things:
- that server's `/coord/cache/bc-symbols/<server>/28.0.54946.56477-6725e7bb/Microsoft_System.app`;
- LethAL Control 1.0.0.23 (`CONTROL_APP`, sha256 `c2a95948…`).

The output goes to the gitignored `scripts/r649-bc-probe/build/<server>/`. On all three servers both apps compiled
with exit 0 and no diagnostics.

The three caches hold the same System version, but their files differ by sha256 (`83ad95e3…`, `a1af5390…`,
`06bc9d5e…`). So each server gets its own build, and the driver records the sha256 of the files it publishes.

**The target, "LethAL R649 BC Sleep Probe"** (`7937c2a9-5c42-4e98-bd9b-9de8151b55fe`), ids 92920-92929:
- 92920 is an Install codeunit. It registers artifact `588155e99f794541ac96f1d42821b803`, because RunMutant refuses a
  target that has no registered artifact.
- 92921 "R649 Probe Sleeper" is the v3 gate's 50605 "Probe Sleeper", word for word:
  `Sleep(600000); Waited := 1; exit(X * 2);`.

**The tests, "LethAL R649 BC Sleep Probe Tests"** (`44c7bc28-455d-4ac9-bb27-3c20754c9c23`), ids 92930-92939. Each
codeunit holds one case, and each has `TestPermissions = Disabled`.

**The id check:**
- No committed `app.json` range overlaps 92920-92939. R639 holds 92900-92919, and R389 holds 91500-91579.
- No `929[2-9]x` id appears in the repo, or under `/coord/handoff/*/probe`.
- The driver also reads both app ids as absent before it publishes.

## 4. The cases, in this order

The driver runs the cases in this order. The long cases run last, because a case left without an answer stops the
cases after it.

| # | Codeunit | Test | Body | Answers |
|---|---|---|---|---|
| 1 | 92930 | `Sleep100` | `Sleep(100)`; `Error('MEASURED elapsed …')` if BC's own clock shows under 100 ms | Q3, the control, and the call's fixed cost |
| 2 | 92931 | `Sleep5000` | `Sleep(5000)`; the same check at 5000 ms | Q2 |
| 3 | 92932 | `LongSleepThenAssert` | 50660's test of that name: `Sleep(600000)`, then `Error('after sleep %1')` if under 600000 ms | Q1 |
| 4 | 92933 | `SleeperDoubles` | 50660's test of that name, word for word, calling 92921 | Q4: the exact X (d) shape |

**Each case is one call:** `RunMutantTransport.run`, which sends `LethALControl_RunMutant` with `mutantId ""` and
`timeoutMs` = `BASELINE_TIMEOUT_DEFAULT` (120 000).
- This is the same transport, budget and request that bcdev uses for a baseline test.
- One difference: bcdev's coverage baseline calls `RunMutantWithCoverage`, while this probe calls `RunMutant`, as
  R639's driver did. Coverage collection does not change how a Sleep runs.
- No stop hook is wired. `BcDevMcpBackend.runViaTransport` wires R53's stop only for a MUTANT run (`mutantId` not
  `""`).
- The control-app lease is renewed every 5 s (TTL 15 s) for the whole run, including while a call is open, as the
  orchestrator's heartbeat does.

**When a call ends without BC's answer** (`operation: "in-flight-unknown"`), the driver does not move on. On the same
lease it:
- polls `GetOperationStatus` every 10 s, and records each change of state;
- reads `GetOpAnswer` once the op reads `completed`;
- stops at BC's answer, or 720 s after dispatch.

So one run records both LethAL's row and what BC itself did.

**What it records, per case:**
- LethAL's row: the whole `TestVerdict` minus `ref` and coverage, with `outcome`, `durationMs`, `operation` and
  `failureMessage`.
- The full failure text, its first line, and the callstack (the text after the first newline).
- The driver's own wall time, from dispatch to verdict.
- The status snapshots, each with its time since dispatch.
- BC's own answer, if the follow-up runs: its outcome, `message` and `stackTrace`, the full text and its first line, and
  the raw answer JSON.
- When BC was first seen complete, and when it was last seen open. This brackets BC's finish to within 10 s.

**When it STOPS:**
- either app id is present before publish;
- a publish is refused, or an app does not read back as installed;
- the control-app lease is refused;
- a case has no answer from BC 720 s after dispatch. Then the later cases are not run.

Every STOP still goes through the removal (§6).

## 5. Predictions

Each prediction is marked **measured** (with its source), **from code** (LethAL's own behaviour, read from the source,
not BC's) or **unknown**. No BC text is predicted.

**Case 1 (100 ms):** the outcome and the wall time are **unknown**. No bc-server reading exists.

**Case 2 (5000 ms):** the outcome and the wall time are **unknown** on the bc servers.
- A prior reading exists only for another server and build. `lease.itest.ts` P9B ran a Sleep of about 23 s inside a
  `[Test]` through RunMutant on Cronus (Windows), and expected it to complete.
- That is not a reading of these servers.

**Cases 3 and 4 (600 s):**
- **Does BC wait the whole 600 s? Unknown.** Plan §6 and r10 assume it does. No BC run of this shape exists (r10 §(c)).
- **LethAL's row, if BC has not answered by 120 s: from code.**
  - Our own timer aborts the call at 120 000 ms.
  - The row reads `outcome: "deadline-exceeded"` and `operation: "in-flight-unknown"`.
  - Its `failureMessage` starts `RunMutant timed out before headers: `, or `after headers: ` if BC sends its headers
    before its body.
  - R236b's one readback then appends `; answer readback: the server holds no committed answer for
    r649-<cu>-<seq>/<seq>`, plus ` (it holds …)` when the server names another op.
  - The wall time is about 120 s, plus at most 15 s for the readback.
  - The abort error's own text is Bun's, and is not predicted.
- **Does LethAL Control's stop fire? From code: no.** No stop is wired for a baseline. Any row other than our timer's
  would come from BC or the control app, and is recorded word for word.
- **What does BC do after our client aborts? Unknown.** It may run on and answer after about 600 s, end the session
  early, or never mark the op complete.

**Removal, all cases:**
- **Measured (R639, bc1):** uninstall returns HTTP 204, unpublish returns HTTP 204, and the read-back shows 0 rows.
- **Unknown:** whether uninstall is refused while a test session is still running.

## 6. Removal and read-back (always)

The removal runs in the driver's `finally`, after every run and after every STOP once a publish may have happened. It
follows R639's path:
1. The tests app first, then the target.
2. For each app: uninstall if installed (HTTP 204), then the bound `Microsoft.NAV.unpublish` (HTTP 204).
3. A read-back by app id, which must show 0 rows.
4. Each step's HTTP status and the read-back go into the JSON (`removal`) and the log.

**If a removal fails**, for example because BC is still running a Sleep:
- Run `bun scripts/r649-bc-probe/drive.ts --server bcN --remove-only` under the same lease, after the op has ended.
- It runs no case. It removes, reads back, and writes its own JSON under `/coord/handoff/R-649/probe/`.
- The lease is not released, and the server is not reported clean, until both ids read back as absent.

**What stays behind, as with R639:** one row in LethAL Control's artifact registry, keyed by target `7937c2a9-…`. No
API removes it. The probe has no table, so it leaves no schema ghost.

**The evidence:**
- `docs/measurements/r649/<server>-probe.json`, committed after the run;
- `/coord/handoff/R-649/probe/drive.log`.

## 7. What each outcome means for re-casting X (d)

X (d) is the only live proof that §6's Sleep rule fires. Its only covering test, `SleeperDoubles`, starts with
`Sleep(600000)`. On edge that test times out at 120 s, so its baseline is not green and every X (d) mutant reads
`no-coverage`. This was measured in R647's post-merge rejudge.

The probe answers two questions:
- does BC record the same "not green at baseline"?
- what Sleep length is green on BC, so that X (d) can be re-cast on it?

"T" below is BC's or LethAL's text as measured. It is quoted word for word in the delta, never paraphrased.

Each row reads: if cases 3 and 4 read the first column, and case 2 reads the second, then X (d) re-casts as the third.

| # | Cases 3/4 read | Case 2 reads | X (d) re-casts as |
|---|---|---|---|
| A | LethAL `deadline-exceeded` at about 120 s (§5's row), and BC's own answer `pass` about 600 s after dispatch | `pass`, wall at least 5 s | **BC agrees with edge.** See the notes on row A |
| B | As A, but BC never answers within 720 s (the op is never seen complete) | `pass`, wall at least 5 s | **The same as A.** LethAL's baseline reading is the same as in A (not green at 120 s, row T). "BC waits the full 600 s" stays unmeasured, and the delta must not claim it |
| C | BC answers `fail` or `error` before 120 s, with text T (for example, BC caps or refuses a long Sleep) | any | **BC itself makes `SleeperDoubles` not green**, with T. See the notes on row C |
| D | BC answers `pass` well under 600 s (for example `LongSleepThenAssert` passes in seconds, or case 2 fails with `MEASURED elapsed …` under 5000) | — | **BC's Sleep does not wait as assumed.** Stop: no X (d) re-cast. See the notes on row D |
| E | BC answers `pass` between 120 s and 600 s | `pass` | BC waits, but not for the whole Sleep. LethAL's row is as in A. **Re-cast as A.** Record BC's measured wait, and leave its cause unexplained |
| F | Case 1 fails, or the control app refuses any case (`status` not `ran`, an `artifact-mismatch`, and so on) | — | **The probe did not measure.** Nothing re-casts. Fix the probe, write a new pre-commitment delta, and run again |

**Notes on row A:**
- Under LethAL's 120 s baseline budget, a `Sleep(600000)` test is not green on BC either. Edge's change moves toward
  BC, and the 600 s probe cannot be green on any build that waits.
- The re-cast is a delta on the R-586 gate. It changes ONLY the literal in 50605, from `Sleep(600000)` to `Sleep(5000)`.
  So every line number, the Sleep index (4 + 5) and r5's per-mutant line predictions stay as they are.
- BC's case 2 reading is the oracle that a 5 s Sleep is green under the budget.
- The delta must also settle two things this probe does not cover:
  - 50660's other `Sleep(600000)` tests. r6 (c)'s "no ProbeSleep test is unsupported" relied on v3's virtual clock
    passing `LongSleepThenAssert`.
  - edge's own limit for a 5 s virtual Sleep.

**Notes on row B:** BC's behaviour after our abort is recorded as its own finding. It is filed if a real project could
hit it, for example a baseline op left running past our abort.

**Notes on row C:**
- X (d)'s baseline is not green on BC, for a reason other than our timer.
- The re-cast uses a Sleep that case 2 shows to be green, as in A, and records T as BC's reading of a 600 s Sleep.
- If T appears on case 3 but not on case 2, the delta states the boundary as measured, and claims no more.

**Notes on row D:**
- Plan §6's premise, "on BC, Sleep waits real time", is then wrong on this build.
- File a roadmap item against §6.
- Report to the orchestrator before any further R-586 work, because the Sleep rule's reason for existing changes.

**In every outcome:**
- X (d) on edge stays `gate-fail` until the delta is committed, and `itest:alrunner-v3` and `--edge-rejudge` have run at
  that commit (R649's "To close").
- `current` stays on alpha.2 until then.
- Case 4 is the exact X (d) shape. When cases 3 and 4 disagree, case 4 decides for X (d), and the disagreement is
  reported as a finding.

## 8. After the run

1. Release the lease, and fill in `lease.releasedAt`.
2. Commit `docs/measurements/r649/<server>-probe.json` and the README's results section, in the plain style of R639's
   README. The file holds no source text: only test names, platform text and callstacks.
3. Send the readings and the matching decision-table row to the orchestrator.
4. File a roadmap item for any new limitation found, for example a baseline op left running past our abort.
