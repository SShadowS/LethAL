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
