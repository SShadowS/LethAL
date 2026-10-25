# R-689 pre-commitment (2026-10-25): what BC records for a test codeunit whose OnRun raises during suite discovery

Committed before any server call. Probe: `scripts/r689-probe/` (lethal/r689 9c5f3923; README there), built offline. Opus plan
review: BLOCK on 2 high and 4 medium items; all were applied before this commit.
- **Server:** ONE bc server (bc2 by default), under lethal-preproc's lease. The holder is checked first, and nothing
  runs if the server is held. Setup runs first (`bc-linux-setup.ts`, its own lease).
- **Measurement only:** LethAL Control is not changed.
- **Do not rebuild after this commit** (alc's output is not byte-reproducible).

| build | what | sha256 |
|---|---|---|
| P | R689 Probe Target (b3bda25b-cff0-435a-b6b3-1331dd8f7862) 1.0.0.1: codeunit 93880 `Inc(X)` (3 mutants) | 2b4434d75312f7e5c058ac0ee79df306d04a7d069b95cc9303b89a4a4beb5845 |
| Q | R689 Probe Tests (09518c22-cda3-4945-9d08-1d6c6ce4bc65) 1.0.0.1, against P: codeunit 93890 "R689 Throwing Tests", whose `OnRun` raises `R689 onrun boom 93890`, with one test, TestIncThrowing; codeunit 93891 "R689 Plain Tests", with TestIncPlain | 2585bd233f97e2d20a4fa8aac933190655923a57da9a9632f1886d8253194d67 |
| R | R689 Probe Reader (2565f0ea-4068-4c22-8ddf-a3e6fb3cdfe0) 1.0.0.1, against Microsoft's Test Runner: codeunits 93900 (the OData web service `R689Reader`, registered by install codeunit 93901) and 93902 (discovery inside `Codeunit.Run`) | 50f86eef4a0dee904f6a4c10445c72f3bd14bdcd917d27821c8a367ef4d32a9c |

The reader is a MEASURING tool, not a candidate fix. Its procedures:
- **`Discover(codeunitId)`** reproduces LethAL Control's RunOneMethod discovery in its own suite R689D. It deletes the
  suite, Commits, calls `ClearLastError()`, then runs `CreateTestSuite` and `SelectTestMethodsByRange` inside
  `if Codeunit.Run`, as the control does after phase 1's Commit. It answers:
  - `runOk`;
  - `GetLastErrorText()` and `GetLastErrorCallStack()` right after the run;
  - the `AL Test Suite` record (Tests to Execute, Tests not Executed, Failures, Last Run, Test Runner Id);
  - every line.
- **`ControlSuites(codeunitId)`** reads LethAL Control's suites (`LC*`): each suite's line count and its count for the
  codeunit, then every line it holds for the codeunit.
- **`WebServices()`** lists the Tenant Web Service and Web Service rows on objects 130450-130463 (the Test Runner's
  tables and pages), and every page in `Page Metadata` whose source table is 130450-130463, with its page type. That
  covers API pages from any app, which need no web-service row.
- **`DeleteOwn()`** removes R689D and the reader's own Tenant Web Service row.

Each line carries: suite, line number, `Line Type`, `Test Codeunit`, `Name`, `Function`, `Run`, `Result`, start and
finish time, `Error Message Preview`, `Error Code`, `GetFullErrorMessage` and `GetErrorCallStack`.

Second id set, for a re-run after an addendum only: P f43911b4-e08f-4e5e-9c41-7d39bc745544, Q
22a60588-baef-4df2-9262-4d75609af0e0, R 05925c49-e757-45fa-88e9-b2f336470455.

## Steps (`drive.ts --all`, once)
1. Publish P, Q, then R directly; read all three back, installed at 1.0.0.1. A refused publish fails the step.
2. `R689Reader_Discover`:
   - first for 93891 (the plain codeunit; a non-200 answer fails the step, so it doubles as a check that the service
     answers);
   - then for 93890 (the throwing codeunit).
   Each answer goes whole to a file.
3. Guard: P and Q installed at 1.0.0.1. Then run `lethal run --project scripts/r689-probe/target --tests
   scripts/r689-probe/tests --backend bcdev --config fixtures/sandbox-app/lethal.config.<server>.json --selector-id
   93887 --control-id 93888 --table-id 93889 --db <fresh> --out report.json --progress-out events.ndjson`, keeping the
   full stdout, stderr and exit code. This exercises LethAL Control's own discovery, unchanged. The same config with
   these flags served R-738's and R-741's probes.
4. `R689Reader_ControlSuites` for 93890, then for 93891.
5. `R689Reader_WebServices`.
6. Read the P, Q and R rows.

Then cleanup: `R689Reader_DeleteOwn`, then unpublish R, Q, P (every row); read back absent; check for quarantine.

## Predictions (low confidence on D1 and D1b; the question is open)
- **D1 (what is stored), for 93890:** `runOk` true: discovery does not raise past `Codeunit.Run`.
  - The suite holds ONE line for the codeunit (`Line Type` Codeunit, `Test Codeunit` 93890) and NO Function lines.
  - That line's `Result` is blank, and `Error Message Preview`, `Error Code`, the full message and the call stack are
    all EMPTY.
  - The suite record shows no failure.
  - That is: BC stores no trace of the OnRun error in the Test Runner's tables.
- **D1b (the session's last error), for 93890:** `lastErrorText` holds `R689 onrun boom 93890`. The Test Runner's "get
  methods" run catches the OnRun error, which leaves it as the session's last error.
- **D2, for 93891:** `runOk` true, empty `lastErrorText`, one Codeunit line and one Function line (TestIncPlain), all
  results blank, no error.
- **D3:** step 3 exits 1 and refuses before any mutant, naming TestIncThrowing as found 0. The error is R686's
  `TestCodeunitDiscoveryError` if the run proves the published package compiles, else `StaleTestAppError`. Either
  refusal is accepted: the name is not the question.
- **D4:** step 4 for 93890: an LC suite holding the same shape as D1. A Codeunit line with empty error fields, and no
  Function line.
- **D5:** step 5 lists NO published web service on 130450-130463. The only pages on those tables are the Test Runner's
  own (130450 "AL Test Suites", 130451 "AL Test Tool", 130455 "Command Line Test Tool"), and none of them is an API
  page. So without a change to LethAL Control, no OData or API read path exists. The one known path, client services
  opening page 130455 (BcContainerHelper's way), needs the UI client stack and is out of scope here.

## Readings, decided now
D1 (the reader's own discovery, in the control's shape) is the deciding reading. D4 corroborates it.
- **D1 holds and D1b holds** (nothing stored, but the last error has the text): the control change is small. On found
  0, `ClearLastError()` before `SelectTestMethodsByRange`, then add `GetLastErrorText()` (and the first frame of
  `GetLastErrorCallStack()`) to the found-0 answer, under a version bump. LethAL quotes it in
  `TestCodeunitDiscoveryError`.
- **D1 holds and D1b fails** (nothing stored, no last error): BC keeps no trace. The control change must CAPTURE the
  error: on found 0, run the codeunit under a catchable boundary and return the last error. The report weighs its cost
  and side effects (it runs the codeunit's OnRun a second time).
- **D1 fails because the codeunit line carries the OnRun text** (in the preview, the full message or the stack): BC
  stores it. The control change: `RunOneMethod` and `RunMany` add that line's error to the found-0 answer.
- **D1 fails because `runOk` is false**, with the last error quoting `R689 onrun boom`: discovery raises. Under the
  control that raise would come back as a `runError`, not "found 0". That contradicts R-537's measurement, which is a
  finding in itself. Compare it with D3.
- **Step 2's 93890 call answers non-200:** if BC's text quotes `R689 onrun boom`, read it as "discovery raises" (as
  above). Otherwise it is a void run.
- **D4 holds no 93890 line in any LC suite:** a later call in a session that reused the same LC name overwrote it
  (each session's counter restarts). D4 is void and D1 decides. D4 holding a 93890 line that DIFFERS from D1 is a
  finding.
- **D5 fails** (a published service, or another page or an API page on these tables): name it, and whether it carries
  the error. That is a possible no-control-change read path, to propose instead.
- **Void run:** a failure for a cause unrelated to P, Q or R (setup, config, lease, an id clash, the reader not
  answering). Write an addendum and re-run with set 2.
- R689 stays OPEN after this ("measured; build after the talk").

## Leftovers
The server keeps installed-version records for P (LethAL's minted version), Q and R (1.0.0.1), and LethAL Control's LC
suite rows, until a restart (R605). `DeleteOwn` removes R689D and the reader's Tenant Web Service row. If step 1's
absent-check refuses, `--all` still runs cleanup, which removes only this probe's own app ids.
