# R-537 pre-commitment: what BC 28 reports for the R537 and R578 probe tests

Committed by lethal-code on 2026-10-23, before any lease or server call for R-537. Coord task R-537 re-measures five
v2-only roadmap items on the Rust al-runner (v3); this run is the BC side of two of them.

**What it covers.** Everything is under `/coord/handoff/R-537/bc/` (invented AL, not committed; the repo is public):

| file | sha256 |
|---|---|
| `drive.ts` | `d4f57e8577a6492eb9a27de290a5558f1ae9bb3286b12c4aaa84b04226a133ff` |
| `app/src/Target.al` | `44a4c849b7ac46a7c60c1834c73e9c0b9f2a503f11f5c1cf126ec37d42c05642` |
| `app/app.json` | `17ad3ae7d0a4f4b4e66069d71a59ba079520dc1c848f675dc60863aa92ac1c0e` |
| `tests/src/Tests.al` | `ee81765beeedffcb71bb5bdb7441b6e909c011fa1c9dbb2d2e95567dba160301` |
| `tests/app.json` | `f5d9ecc5cf81de3b38cc6cde5864ef081050b060b9b31b4a52434c2c3d996a46` |
| `build/app.app` (alc) | `6ba1fdd4c7f851c7d2a6920da7c219bfd089c3fab2a8ade74986cf889612dfbf` |
| `build/tests.app` (alc) | `1ef95ca6c3d35a943678d8bd9bb60546d5aa6f24803a2ea2608e4ed380f069b4` |

LethAL code: `lethal/r537` at master `bfb07c36`, unchanged.

## 1. The questions

1. **R537 shape 1.** A `[Test]` with `[HandlerFunctions('MsgHandler')]` whose handler never fires (`HandlerUnused`).
   v3 writes `fail`, `The following UI handlers were not executed: MsgHandler`. What does BC report?
2. **R537 shape 2, and R543.** A test codeunit whose `OnRun` trigger raises `Error('boom 537 onrun')`, with two
   empty tests. v3 writes both tests `notRun` (`OnRun failed (runner behaviour not pinned): boom 537 onrun`), which
   LethAL scores `error`. What does BC report?
3. **R578.** `Report.RunModal` of a processing-only report with `UseRequestPage(true)`, handled by a
   `[RequestPageHandler]` that invokes OK (`ReportWithRequestPage`, expects 107). v3 (both builds) fails it at
   `RunModal` with `An error occurred and the transaction is stopped. ...`. What does BC report?

Controls: `HandlerUsed` (the handler fires), `ReportNoRequestPage` (the same report without its request page, expects
7). Both pass on v3.

## 2. How

`bun /coord/handoff/R-537/bc/drive.ts bc2`, from `/work/lethal-wt/r537`:
1. leases **bc2 only** (orchestrator ruling 2026-10-23; the driver refuses any other server), heartbeats every 60 s;
2. reads LethAL Control's `serverGeneration` (read only);
3. refuses if either probe app id is already on bc2 (read by id only, R433), then publishes `R537 Target` and
   `R537 Tests` 1.0.0.0 over the dev endpoint. It never publishes, removes or resets LethAL Control;
4. runs `lethal run --backend bcdev` on the probe with `fixtures/sandbox-app/lethal.config.bc2.json` (default
   coverage mode). The baseline runs every probe test on BC;
5. uninstalls and unpublishes the tests app and every version of the target (LethAL leaves a minted one), reads each
   id back, reads `serverGeneration` again, and releases the lease.

## 3. Predictions

- **P1.** `HandlerUnused` FAILS on BC with a message that starts `The following UI handlers were not executed`
  (BC's own rule, which v3 cites from its corpus).
- **P2.** `HandlerUsed` and `ReportNoRequestPage` pass.
- **P3.** Both `R537 OnRun Tests` tests are reported FAILED on BC, each with `boom 537 onrun` (R537's 2026-10-09
  reading, never measured). Not run, passed, or a missing row would refute it.
- **P4.** `ReportWithRequestPage` PASSES on BC (it gets 107).
- **P5.** `serverGeneration` reads the same before and after, `2b8971cb88584ba486dcf6c453a2d76c` (R-632b's bc2
  baseline). Both probe ids read back absent at the end.

## 4. What each result decides

- **P1 holds:** v3 and BC agree (fail, scored a kill on both). R537 shape 1 is closed by ruling.
- **P3 holds:** v3 differs from BC (not run vs failed). It is a LOST kill, never a false one: LethAL keeps scoring
  v3's `notRun` row `error` (no code change), and the difference is filed upstream. **P3 refuted:** the ruling
  follows what BC reports, and the upstream filing reports that instead.
- **P4 holds:** v3 differs from BC; filed upstream. A test that fails at baseline is never scored, so it is not a
  false kill. **P4 refuted** (BC also fails): R578 is closed as a repro defect.
- **P5 refuted** (generation changed, or an app is left): reported at once to the orchestrator and in the submit
  note. An app that cannot be removed stays until bc2's next restart.
- A result that fits none of the above (for example the bcdev path refuses a test before BC runs it) is reported as
  it is, and the question stays open; it is not read as BC's behaviour.

## Delta 1 (before the second run)

The first run (12:24Z) stopped inside `lethal run` before LethAL made any server call: the default selector id 79199
is outside the target's idRanges. The driver's own steps ran as committed: `serverGeneration` read
`2b8971cb88584ba486dcf6c453a2d76c` before and after, both apps were published, then removed and read back absent,
and the lease was released. The one change is that `drive.ts` now passes `--selector-id 50977 --control-id 50978
--table-id 50979`, inside 50970-50979 (sha256 `799e52672dee1acb217f83e05e660dd2cc07a90f30d90eddb7ef506106b4c566`).
No prediction changes.

## Delta 2 (before the third run)

The second run (12:24:55Z) also stopped inside `lethal run` before LethAL made any server call: R307 refuses a file
that holds a codeunit with a table and a report. The driver's own steps again ran as committed (generation unchanged
before and after, both apps removed and read back absent, lease released). The one change is that `app/src/Target.al`
is split, unchanged, into one file per object, and both apps are rebuilt by alc. `lethal run --dry-run` on the split
target lists 14 sites with no refusal. No prediction changes.

| file | sha256 |
|---|---|
| `app/src/Logic.Codeunit.al` | `b725306c90a2cc09ed0a18178f6e85cc9561b2579a07890045a7c6c4f50f4fc7` |
| `app/src/Entry.Table.al` | `92b3e4ca5cb17f49e78a84001a38997f464f80ad33d95d8cb7df57f57f9591e6` |
| `app/src/Sum.Report.al` | `ac940b5c532f74f01088349858f31a128dd3ff6d19b31704d9b1376cacc70712` |
| `build/app.app` | `b4816b51f4b4a8d89710130bba1a2aabb055741b2bf804c8a2c1c1a0c4dd956b` |
| `build/tests.app` | `6ec1e35d06a5d00acb24e9699e85d50dc5f560b3ea08788a9d10a73f8a085b96` |

## Delta 3 (after the third run, before the fourth)

**Third run (12:25:33Z), as measured.** The baseline ran all six tests on bc2:
- `HandlerUnused` failed with `The following UI handlers were not executed: MsgHandler`: **P1 holds**.
- `HandlerUsed` passed.
- `ReportWithRequestPage` and `ReportNoRequestPage` both failed in `Seed`, with `Sorry, the current permissions
  prevented the action. (TableData 50971 R537 Entry Insert: R537 Tests)`. This is a probe defect: codeunit 50980
  does not declare `TestPermissions = Disabled`. **P4 is not answered**, and P2 is answered only for `HandlerUsed`.
- The two `R537 OnRun Tests` tests got 0 method lines on BC (`expected exactly one method AfterThrowingOnRun,
  found 0`). LethAL classified them `stale-test-app` and stopped the run with `StaleTestAppError` after the baseline.
  **P3 is refuted:** BC reported no failed test.
- `serverGeneration` was unchanged before and after, and both apps read back absent: **P5 holds**.

**The one change for the fourth run:** codeunit 50980 declares `TestPermissions = Disabled`, and the tests app is
rebuilt (`tests/src/Tests.al` `4c3326a8e229e21150fbad806555eede4c2c65d6051273f1e3857baf1fd4c706`, `build/tests.app`
`1c05fd71a8416b32f2b263a2c44f4f727ac2102e971d16485bd2235471d1e76e`). P2 and P4 stand as written. The fourth run
re-measures P1, P3 and P5 as well; a result that differs from the third run is reported, not chosen.

## Delta 4 (the fourth run published nothing)

The fourth run (12:26:35Z) was refused at its first publish, HTTP 422: `Cannot install the extension R537 Target by
LethAL R537 1.0.0.0 because a newer version 1.0.20749.22369 was already installed.` That is the version LethAL minted
in the third run. bc2 keeps that record although both ids read back absent, so it is a leftover on bc2 until its next
restart, and it goes in the submit note. Nothing was published; generation was unchanged; the lease was released.
**The one change:** the target's app.json version is `1.0.20749.22370` (`app/app.json`
`25c08dd96dab9e0acf1a2383ac9015276f6eab9f9f124734659937e182e62669`; `build/app.app`
`81b6899eb77b36cd2a7d3e7da6f2e86e5535553fe719d2e8c16af3c076801f85`; `build/tests.app`
`6ad7bebb1b5c564cb6aab053c61ef0853b42339586dadf92fd5401883c46d79e`). Predictions as in delta 3. If this run is also
refused or defective, I stop and report; there is no sixth run without the orchestrator.
