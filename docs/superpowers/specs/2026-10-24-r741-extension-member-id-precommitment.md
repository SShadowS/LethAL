# R-741 pre-commitment (2026-10-24): which object id BC names for a stale member the target added through an extension

Committed before any server call. Probe: `scripts/r741-probe/` (lethal/r741 6f2a88b6; README there), built offline.
Opus plan review: BLOCK on 3 items, all applied (the run's symbol cache, the evidence per kind, the readings for every
other outcome). Server: bc2
(BC 28.4 W1), under lethal-preproc's lease, after `bc-linux-setup.ts --server bc2` (its own lease). **Do not rebuild
after this commit.**

| build | what | sha256 |
|---|---|---|
| B | R741 Probe Base (35e61124-0818-4a55-bb52-a59e866d2f43) 1.0.0.1: table 93850 `R741 Base`, page 93851 `R741 Base Card` | 806c6789867f899f6b97d9022952cc2743203695fb266d2b15a3f89adff048e6 |
| T1 | R741 Probe Target (7eafd7d0-28ea-4943-862f-61dc273065b9) 1.0.0.1, depends on B: tableextension 93860 (`Answer`, `Other(X)`), pageextension 93861 (`PageAnswer`, `PageOther(X)`) | 9fbd38a6ad6840f794b775fd87ebd8f10631a24c5126f710f87a0e87a6a88a89 |
| TS | the run's SOURCE (`target/`), the same app WITHOUT `Answer` and `PageAnswer` (built only to prove it compiles; LethAL builds it again) | fa4148b452223c4b86ca7d832d6da2c016ca36d14957a915dd71a34c28e5b1a1 |
| Q | R741 Probe Tests (ef054a8e-e34c-4102-a551-200b153aaea5) 1.0.0.1, against B and T1: TestTableAnswer, TestTableOther, TestPageAnswer, TestPageOther, TestFails | 9162cf3903281882028bce60bc7124b18247d9adff87762fd0f252903f728474 |

Offline listing of the run's source (`run --dry-run`): 5 mutants, all in `Other` (3, covered by TestTableOther) and
`PageOther` (2, covered by TestPageOther). The removed members carry none, so this run measures only the refusal and the
id BC names, not a coverage loss. Second id set, for a re-run after an addendum only: B
28c577b9-5e6a-4735-add0-bd6c3f451ea6, P 15fda437-a323-4426-8a43-1e24acfb18b2, Q 87ce8474-9f15-4641-bbed-b8d6ae3c0103.

## Steps (`drive.ts --all`, once)
1. Publish B, T1, then Q directly; read all three back, installed at 1.0.0.1.
2. Guard: all three installed at 1.0.0.1. The target depends on B, and the shared symbol cache holds only Microsoft's
   packages, so drive.ts first builds `.kraken-local/r741-probe/pkgcache/` (the shared cache's `.app` files copied,
   plus B) and writes `.kraken-local/r741-probe/run.config.json`: `fixtures/sandbox-app/lethal.config.bc2.json`
   parsed in-process with only `bcdev.packageCachePath` changed (gitignored, mode 600, never printed, removed by
   cleanup). `--build` already compiled the run's source against that same set of packages (System plus B). Then run
   `lethal run --project scripts/r741-probe/target --tests scripts/r741-probe/tests --backend bcdev --config
   .kraken-local/r741-probe/run.config.json --selector-id 93867 --control-id 93868 --table-id 93869 --db <fresh> --out
   report.json --progress-out events.ndjson`, with full stdout, stderr and the exit code.
3. Read the B, P and Q rows.

Then cleanup: Q, then P, then B (every row); read back absent; check bc2 for quarantine.

## Predictions
- **E1:** step 1 is accepted; B, P and Q are installed at 1.0.0.1.
- **E2:** the run's own altool publish of the instrumented target (without `Answer` and `PageAnswer`) is ACCEPTED and Q
  stays installed, as R738 run 1.
- **E3 (the question), low confidence:** TestTableAnswer and TestPageAnswer each fail at the baseline with BC's
  "Function ID <n> was called. The object with ID <id> does not have a member with that ID." first. Predicted ids:
  the BASE objects, **93850** for the table member and **93851** for the page member. (The call compiles against the
  base type, `Record "R741 Base"` and `Page "R741 Base Card"`.)
- **E4, which follows from E3:** the run refuses with R740's `StaleDependencyMemberError`, exit 1, naming both tests
  and the base ids. No report is written and no mutant is scored. TestTableOther and TestPageOther pass, and TestFails
  fails with "genuine failure". No warning is allowed for, since a refusal writes no report. If the run does not
  refuse, any warning is recorded, and R740's `test-digests-unavailable` and `test-app-dependencies-unproven` do not
  void it.

## The evidence
The PRIMARY evidence is the first line of `failureMessage` for TestTableAnswer and TestPageAnswer in the
`baseline-batch-finished` event of `events.ndjson`, which is written before any refusal. It gives each kind's id even
when the run stops at the other kind. The refusal message is the cross-check. R738's check runs before R740's and
holds only the tests naming a target id, so the expected refusal for each combination is:

| table member names | page member names | expected refusal |
|---|---|---|
| 93860 | 93861 | `StaleTargetMemberError`, both tests, "93860, 93861" |
| 93850 | 93851 | `StaleDependencyMemberError`, both tests (E4) |
| 93860 | 93851 | `StaleTargetMemberError`, TestTableAnswer only |
| 93850 | 93861 | `StaleTargetMemberError`, TestPageAnswer only |

A refusal that disagrees with this table, given the events' ids, is a finding in itself.

## Readings, decided now
- **Void run:** a failure for a cause unrelated to B, P or Q (setup, config, lease, a quarantine, an object-id clash)
  before the baseline. Write an addendum and re-run with set 2.
- **E2 fails** (the run's publish is refused): a finding, not a void run. Report; do not re-run.
- **BC names the extension's own id (93860 or 93861):** R738's `StaleTargetMemberError` fires with the right cause and
  remedy, because `objectHeadersOf` reads tableextension and pageextension headers. That kind closes by measurement,
  with no code change. A unit test pinning that an extension's id counts as the target's is added only if none exists.
- **BC names a base id (E3 holds, for either kind):** R740 refuses with a misattributed cause (its remedy, recompiling
  the tests app, still works). Before building, I report to the orchestrator with a proposal. The `extends` clause
  gives the base object's NAME, not its id, so the fix must resolve that name to an id. The options:
  - (A) from the dependency symbols the run already has (each package's `SymbolReference.json`);
  - (B) no resolution: when a non-target id is named and the target declares any extension, R740's message also names
    "a member the target added through an extension" as a possible cause.
- **The two kinds differ:** each kind is read on its own, as above.
- **An id that is none of 93850, 93851, 93860 or 93861** (93870, say, or a system id): its own finding. It is read
  neither as "base" nor as "extension", and R741 does not close on it.
- **TestTableAnswer or TestPageAnswer fails with a DIFFERENT sentence:** no refusal fires, so the test leaves the green
  set silently. That is the R738-class risk itself, and I file it as a silent-drop item.
- **TestTableAnswer or TestPageAnswer PASSES:** the old T1 is still what runs. Check that P's row shows LethAL's
  minted version. Either way the run is void for that kind: write an addendum.
- **TestTableOther or TestPageOther fails:** that kind cannot be read, whatever its Answer test says. Report it.
  (Calling a pageextension procedure from a test is already done live by `fixtures/sandbox-wrapped`'s tests, through
  `Page "Wrapped View"`, and tableextension and pageextension procedures are instrumented live by `itest:tables` and
  `itest:bcdev-wrapped`, so neither is a likely confound.)
- **The control app's "found 0", or Q failing to load:** a finding. Report it; R741 does not close on it.

## Realism
The case is any target that adds procedures to another app's table or page (for example a procedure on `Customer`)
and then removes or re-signs one before the tests app is republished. It is reachable through every run's altool
publish (R738).

## Leftovers
bc2 keeps installed-version records for B and Q (1.0.0.1) and P (LethAL's minted version), and B's table schema, until
a restart (R605).
