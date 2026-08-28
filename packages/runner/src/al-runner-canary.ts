import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OneShotTransport, qualifiedTestName } from "./al-runner-transport";
import type { SpawnFn } from "./publisher";
import { defaultSpawn } from "./publisher";

/**
 * ROADMAP R7 + R8 — a startup canary that PROVES, against the actual configured al-runner
 * binary, whether two measured defects (fixtures/README.md §Tier-2 Phase 0) are present on
 * THIS machine's build, instead of repeating a static claim frozen at the moment it was first
 * measured (2026-07-25, v1.0.31-era). A third-party binary can be upgraded or patched; a canary
 * that re-measures every session tells the truth about the build actually in use rather than
 * about whatever build happened to be installed the day someone wrote a code comment.
 *
 * That is no longer hypothetical: both defects are FIXED on al-runner v2.0.0.0 (R99, measured
 * 2026-08-07), so on a current install this canary is expected to report `defect-not-reproduced`
 * twice. It stays exactly because the binary is not pinned — a machine with an older al-runner
 * on its PATH still gets told, and `alRunnerCanaryWarnings` says which of the two happened.
 *
 * Three independent probes, run ONCE per `--backend al-runner` session (never per mutant — the
 * ~4s cost of three al-runner invocations is immaterial against a real mutation run, though it
 * would not be against a single-mutant smoke test).
 *
 * **The third probe's polarity is INVERTED relative to the first two, and misreading it is the
 * hazard.** R7 and R8 are historical DEFECTS: `defect-not-reproduced` is the expected result and
 * `defect-confirmed` means an old build. R183's probe pins a gap that is PRESENT on the newest
 * build, so `defect-confirmed` is the status quo there and `defect-not-reproduced` is the line that
 * should make someone look, because it would mean the gap has closed.
 *
 * It exists because the claim it replaces went stale silently: `AlRunnerBackend.capabilities()`
 * asserted "`Commit()` and `Rollback()` are no-ops", quoted from upstream docs. A live differential
 * measured that as too broad — and then this probe measured the first correction ("error-rollback is
 * modelled") as too broad in the other direction. The accurate statement is per-mechanism, and it is
 * in `AlRunnerCanaryResult.transactionRollback`.
 *
 * The probes:
 *
 * - `asserterror` (R7): `asserterror I := 1;` is a statement that CANNOT raise. A correct AL
 *   interpreter therefore fails this test (asserterror expected an error and none came). The
 *   measured defect is that al-runner reports it `pass` instead — so any mutant killable only
 *   by an asserterror assertion is reported SURVIVED there while bcdev kills it.
 * - table global var (R8): `Rec.Validate("No.", 'X')` runs an OnValidate trigger that
 *   increments a table-object GLOBAL (`Touched`, not a field, so it is never persisted to the
 *   database); `Rec.TouchCount()` on the SAME record variable reads it back afterward. A
 *   correct interpreter returns 1 — real AL table-object globals are scoped to the `Record`
 *   variable, not shared across separate variables of the same table, and this probe never
 *   creates a second one. Diagnosed directly (three throwaway probes against this exact
 *   pattern, 2026-07-26): the write is real and visible from a NESTED call to `TouchCount()`
 *   made from inside the trigger's own execution frame, and the field write (`"No."` itself)
 *   demonstrably survives the same call boundary — only the non-field global does not survive
 *   the return from `Validate()` back into a later, separate top-level dispatch on the same
 *   variable. So the defect is scoped precisely to table-object globals crossing that one
 *   boundary, not a general "record instance not shared" failure.
 * - transaction rollback (R183): a codeunit invoked through `Codeunit.Run` inserts a row and then
 *   raises. `Codeunit.Run` returning FALSE is the error being caught; the question is whether the
 *   row is still there afterwards. A runtime modelling BC's write transaction discards it. This
 *   pins the CORRECTED justification for `authoritative: false` — see `AlRunnerCanaryResult`.
 *
 * All three probes are written as a plain (unguarded) `Error()` failure/success rather than as an
 * `asserterror` assertion themselves — deliberately, since the R7 defect would otherwise
 * contaminate the R8 probe's own signal. An unguarded `Error()` is already proven to fail a
 * test correctly on al-runner (`OverBudgetDetected`'s kills in fixtures/README.md's expected
 * verdict table), so its pass/fail outcome here is a clean read on its own trigger semantics.
 */

export type CanaryVerdict = "defect-confirmed" | "defect-not-reproduced" | "inconclusive";

export interface AlRunnerCanaryResult {
  readonly asserterror: CanaryVerdict;
  readonly tableGlobalVar: CanaryVerdict;
  /**
   * R183 — does an error caught by **`Codeunit.Run`** discard the writes made before it?
   *
   * **Read the mechanism, not just the word "rollback": al-runner 2.7.0.0 rolls back for one and
   * not the other, and that is the whole finding.** Measured 2026-08-28 with a three-test probe:
   *
   * | error caught by | writes rolled back on al-runner 2.7.0.0 |
   * | --- | --- |
   * | `asserterror` | YES, with or without a preceding `Commit()` |
   * | `Codeunit.Run` | **NO** |
   *
   * On BC both roll back. So the residual is precisely the `Codeunit.Run` transaction boundary,
   * which is also exactly what LethAL's live differential found: `remove-commit` at
   * `Data Commit Ops.CommitThenFail` (an `asserterror` shape) agrees with bcdev, while
   * `Data Commit Ops.CommitThenRunValueForm` (a `Codeunit.Run` shape) is killed on bcdev and
   * survives here. One mechanism, two symptoms.
   *
   * This probe measures the `Codeunit.Run` case, so **`defect-confirmed` is the CURRENT, correct
   * answer on 2.7.0.0** — unlike R7 and R8, where `defect-confirmed` means an old build.
   * `defect-not-reproduced` here would be an IMPROVEMENT worth acting on, because it would mean the
   * residual named in `AlRunnerBackend.capabilities()` has closed and that comment needs revisiting.
   *
   * It exists because the claim it replaces went stale silently: `capabilities()` asserted
   * "`Commit()` and `Rollback()` are no-ops", quoted from upstream docs, and that is too broad —
   * `asserterror` demonstrably rolls back. A comment nobody re-measures is how the R7 justification
   * went stale before it, so this is the answer R99 reached for that one: measure every session.
   */
  readonly transactionRollback: CanaryVerdict;
  /** Present only when the corresponding verdict carries a diagnostic worth surfacing. */
  readonly asserterrorDetail?: string;
  readonly tableGlobalVarDetail?: string;
  readonly transactionRollbackDetail?: string;
}

const ASSERTERROR_METHOD = "AsserterrorNeverRaises";
const TABLE_GLOBAL_VAR_METHOD = "GlobalVarSurvivesValidate";
const TRANSACTION_ROLLBACK_METHOD = "ErrorDiscardsUncommittedWrite";

// Fixed, arbitrary GUIDs for the two throwaway canary "apps" — never published anywhere, never
// touching a real project's id space, so there is no reason for these to be random per run.
const CANARY_DATA_APP_ID = "d4c9a2e1-6b3f-4a7d-9c1e-8f2b5a6d3c47";
const CANARY_TESTS_APP_ID = "f7e1b3a0-2c4d-4e8f-9a1b-3d5c7e9f1a2b";
// Object ids are local to this throwaway pair of apps and never coexist with a real project's
// compilation, so they don't need to dodge DEFAULT_SELECTOR_IDS (79197-79199) — chosen well
// clear of it purely for readability.
const CANARY_TABLE_ID = 50000;
const CANARY_TESTS_CODEUNIT_ID = 50001;
// R183's probe needs a codeunit `Codeunit.Run` can invoke. It lives in the TESTS app, not the data
// app, purely so the data app's single-id range does not have to widen across the tests app's id.
const CANARY_WRITER_CODEUNIT_ID = 50002;

function baseAppJson(overrides: {
  id: string;
  name: string;
  idFrom: number;
  idTo: number;
  dependencies?: readonly { id: string; name: string; publisher: string; version: string }[];
}): string {
  return JSON.stringify(
    {
      id: overrides.id,
      name: overrides.name,
      publisher: "LethAL",
      version: "1.0.0.0",
      brief: "",
      description: "",
      privacyStatement: "",
      EULA: "",
      help: "",
      url: "",
      logo: "",
      dependencies: overrides.dependencies ?? [],
      screenshots: [],
      idRanges: [{ from: overrides.idFrom, to: overrides.idTo }],
      resourceExposurePolicy: {
        allowDebugging: true,
        allowDownloadingSource: true,
        includeSourceInSymbolFile: true,
      },
      runtime: "13.0",
      features: [],
    },
    null,
    2,
  );
}

const CANARY_TABLE_AL = `table ${CANARY_TABLE_ID} "Lethal Canary Data"
{
    DataClassification = CustomerContent;
    InherentPermissions = RIMD;

    fields
    {
        field(1; "No."; Code[20])
        {
            trigger OnValidate()
            begin
                Touched := Touched + 1;
            end;
        }
    }

    keys
    {
        key(PK; "No.") { Clustered = true; }
    }

    var
        Touched: Integer;

    procedure TouchCount(): Integer
    begin
        exit(Touched);
    end;
}
`;

const CANARY_TESTS_AL = `codeunit ${CANARY_TESTS_CODEUNIT_ID} "Lethal Canary Tests"
{
    Subtype = Test;

    [Test]
    procedure ${ASSERTERROR_METHOD}()
    var
        I: Integer;
    begin
        // Cannot raise. A correct interpreter fails this test (asserterror expected an error
        // and none came). al-runner's measured defect (R7) reports it "pass" instead.
        asserterror I := 1;
    end;

    [Test]
    procedure ${TABLE_GLOBAL_VAR_METHOD}()
    var
        Rec: Record "Lethal Canary Data";
    begin
        Rec.Validate("No.", 'X');
        // Unguarded Error(), not asserterror — see this module's doc comment for why.
        if Rec.TouchCount() <> 1 then
            Error('canary-mismatch TouchCount=%1', Rec.TouchCount());
    end;

    [Test]
    procedure ${TRANSACTION_ROLLBACK_METHOD}()
    var
        Rec: Record "Lethal Canary Data";
    begin
        // R183. The writer inserts a row and then raises, so a runtime that models BC's write
        // transaction discards the row when the error unwinds. \`Codeunit.Run\` returning FALSE is
        // the error being caught; the row still existing afterwards is the defect.
        if Codeunit.Run(Codeunit::"Lethal Canary Writer") then
            Error('canary-probe-broken: the writer returned true, but it always raises');
        if Rec.Get('ROLLBACK') then
            Error('canary-rollback-not-modelled: the row written before the error survived it');
    end;
}
`;

/**
 * The codeunit `${TRANSACTION_ROLLBACK_METHOD}` runs. NOT \`Subtype = Test\` — it must be an ordinary
 * codeunit, or al-runner would collect its \`OnRun\` as a test and the deliberate \`Error\` would be
 * reported as a failing test of its own.
 */
const CANARY_WRITER_AL = `codeunit ${CANARY_WRITER_CODEUNIT_ID} "Lethal Canary Writer"
{
    trigger OnRun()
    var
        Rec: Record "Lethal Canary Data";
    begin
        Rec.Init();
        // Assigned, not Validated: the field's OnValidate touches the table global this file's
        // OTHER probe measures, and one probe must not disturb the other.
        Rec."No." := 'ROLLBACK';
        Rec.Insert();
        Error('canary-rollback-probe: deliberate failure after an uncommitted write');
    end;
}
`;

async function writeCanaryProject(root: string): Promise<{ dataDir: string; testDir: string }> {
  // al-runner double-loads a directory passed as BOTH sourceDir and testDir (confirmed:
  // passing the same directory twice yields AL0197 "already declared" on every object in it) —
  // these must be two physically distinct directories, never the same one.
  const dataDir = join(root, "data");
  const testDir = join(root, "tests");
  await mkdir(dataDir, { recursive: true });
  await mkdir(testDir, { recursive: true });
  await writeFile(
    join(dataDir, "app.json"),
    baseAppJson({
      id: CANARY_DATA_APP_ID,
      name: "LethAL AlRunner Canary Data",
      idFrom: CANARY_TABLE_ID,
      idTo: CANARY_TABLE_ID,
    }),
    "utf8",
  );
  await writeFile(join(dataDir, "CanaryData.Table.al"), CANARY_TABLE_AL, "utf8");
  await writeFile(
    join(testDir, "app.json"),
    baseAppJson({
      id: CANARY_TESTS_APP_ID,
      name: "LethAL AlRunner Canary Tests",
      idFrom: CANARY_TESTS_CODEUNIT_ID,
      idTo: CANARY_WRITER_CODEUNIT_ID,
      dependencies: [
        {
          id: CANARY_DATA_APP_ID,
          name: "LethAL AlRunner Canary Data",
          publisher: "LethAL",
          version: "1.0.0.0",
        },
      ],
    }),
    "utf8",
  );
  await writeFile(join(testDir, "CanaryTests.Codeunit.al"), CANARY_TESTS_AL, "utf8");
  await writeFile(join(testDir, "CanaryWriter.Codeunit.al"), CANARY_WRITER_AL, "utf8");
  return { dataDir, testDir };
}

// Generous relative to the ~1.2-1.5s a cold al-runner invocation measured at (2026-07-26): the
// canary must not itself become the thing that makes a slower machine's session fail to start.
const CANARY_DEADLINE_MS = 30_000;
const CANARY_TEST_TIMEOUT_SECONDS = 10;

type ProbeOutcome =
  | { readonly kind: "pass" | "fail"; readonly note?: string }
  | { readonly kind: "inconclusive"; readonly note: string };

async function probe(
  transport: OneShotTransport,
  sourceDir: string,
  testDir: string,
  method: string,
): Promise<ProbeOutcome> {
  // v2 selects and reports tests by their qualified name — the canary's two probes live in
  // CANARY_TESTS_CODEUNIT_ID, so the same helper the backend uses builds the name here too.
  const wanted = qualifiedTestName(CANARY_TESTS_CODEUNIT_ID, method);
  const res = await transport.send({
    sourceDir,
    testDir,
    qualifiedTest: wanted,
    testTimeoutSeconds: CANARY_TEST_TIMEOUT_SECONDS,
    deadlineMs: CANARY_DEADLINE_MS,
  });
  if (res.kind === "deadline") return { kind: "inconclusive", note: "canary probe timed out" };
  if (res.kind === "error") return { kind: "inconclusive", note: res.detail };
  const t = res.tests.find((x) => x.name === wanted);
  if (t === undefined) {
    return { kind: "inconclusive", note: "al-runner output did not include the canary test" };
  }
  // Unlike AlRunnerBackend.run() (which treats anything other than "pass" as a mutant-kill
  // "fail", because ANY non-pass outcome is equally a legitimate kill there), this canary reads
  // "fail" as evidence toward a SPECIFIC defect verdict — so an unrecognized third status (e.g.
  // a future runner-internal "error") must not silently fall into "fail" and get read as a
  // confirmed defect. Only "pass" and exactly "fail" are conclusive; anything else is
  // inconclusive.
  if (t.status === "pass") return { kind: "pass" };
  if (t.status === "fail")
    return { kind: "fail", ...(t.message !== undefined ? { note: t.message } : {}) };
  return { kind: "inconclusive", note: `al-runner reported unexpected status "${t.status}"` };
}

/**
 * The two filesystem operations that can fail for infrastructure reasons unrelated to al-runner
 * itself (disk full, a locked scratch dir, Windows EBUSY/EPERM on a directory something else
 * still has open) — injectable so a test can force each failure deterministically instead of
 * relying on real filesystem edge cases. `writeCanaryProject`'s own `mkdir`/`writeFile` calls
 * are NOT injected: they write into a directory `mkdtemp` just created, so failing independently
 * of it is far less plausible, and any throw there is still caught by `runAlRunnerCanary`'s own
 * outer `catch` below (see there) — just not independently unit-testable without real fs tricks.
 */
export interface AlRunnerCanaryFsOps {
  readonly mkdtemp: (prefix: string) => Promise<string>;
  readonly rm: (
    path: string,
    opts: { recursive: boolean; force: boolean; maxRetries: number; retryDelay: number },
  ) => Promise<void>;
}

const defaultFsOps: AlRunnerCanaryFsOps = {
  mkdtemp: (prefix) => mkdtemp(prefix),
  rm: (path, opts) => rm(path, opts),
};

async function cleanUpQuietly(root: string, fsOps: AlRunnerCanaryFsOps): Promise<void> {
  try {
    // maxRetries/retryDelay mirrors AlRunnerBackend.deploy()'s identical delete
    // (al-runner-backend.ts): on Windows, deleting a directory a warm al-runner process, an
    // indexer, or an AV scanner still holds open is a known EBUSY/EPERM flake that `force`
    // alone does not cover — `force` only suppresses ENOENT (path already gone).
    await fsOps.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (err) {
    // Best-effort: a scratch-dir cleanup failure must never discard the canary's own
    // successfully-computed result (see the doc comment below) or crash the session — it just
    // leaves a stray temp directory behind, reported so an operator can find it.
    console.warn(
      `[lethal] al-runner canary: could not clean up its scratch directory ${root} (harmless; ` +
        `session continues): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Runs both probes against `alRunnerPath` in a fresh scratch directory, always cleaned up
 * (success, defect, or infrastructure failure alike — a canary that leaked scratch dirs on
 * every session would be its own small bug).
 *
 * NEVER throws. `probe()` itself already turns every al-runner-side failure (bad exit code,
 * malformed JSON, a missing test in the payload) into `{ kind: "inconclusive" }` rather than
 * throwing, but the surrounding scratch-directory setup (`mkdtemp`, `writeCanaryProject`) is
 * real filesystem I/O that CAN throw for reasons that have nothing to do with al-runner (disk
 * full, a locked directory, permissions). Before this was guarded, that kind of infrastructure
 * hiccup propagated all the way up through `announceAlRunnerCanary`/`runFromCli` uncaught —
 * `main()` printed a stack trace and exited 1 BEFORE A SINGLE MUTANT RAN, with no `SessionReport`
 * at all. That is exactly the hard-refuse-on-any-hiccup outcome this module's own R7 decision
 * (loud-warn, not hard-refuse — see the top-of-file doc comment) argues against; it would just
 * have arrived by omission instead of by design. So: any throw from the setup/probe path is
 * caught and demoted to `inconclusive` for both defects, with the real error text as the detail,
 * and the mutation session proceeds exactly as it would if the canary had never been asked to
 * run at all.
 */
export async function runAlRunnerCanary(
  alRunnerPath: string,
  spawn: SpawnFn = defaultSpawn,
  fsOps: AlRunnerCanaryFsOps = defaultFsOps,
): Promise<AlRunnerCanaryResult> {
  let root: string | undefined;
  try {
    root = await fsOps.mkdtemp(join(tmpdir(), "lethal-alrunner-canary-"));
    const { dataDir, testDir } = await writeCanaryProject(root);
    const transport = new OneShotTransport(alRunnerPath, spawn);
    try {
      const asserterrorProbe = await probe(transport, dataDir, testDir, ASSERTERROR_METHOD);
      const tableProbe = await probe(transport, dataDir, testDir, TABLE_GLOBAL_VAR_METHOD);
      const rollbackProbe = await probe(transport, dataDir, testDir, TRANSACTION_ROLLBACK_METHOD);
      // asserterror: a correct backend FAILS this probe. "pass" is the defect.
      const asserterror: CanaryVerdict =
        asserterrorProbe.kind === "inconclusive"
          ? "inconclusive"
          : asserterrorProbe.kind === "pass"
            ? "defect-confirmed"
            : "defect-not-reproduced";
      // table global var: a correct backend PASSES this probe. "fail" is the defect.
      const tableGlobalVar: CanaryVerdict =
        tableProbe.kind === "inconclusive"
          ? "inconclusive"
          : tableProbe.kind === "fail"
            ? "defect-confirmed"
            : "defect-not-reproduced";
      // transaction rollback: a correct backend PASSES this probe (the row is gone). "fail" means
      // the row written before the error survived it, which is the absent-transaction defect.
      const transactionRollback: CanaryVerdict =
        rollbackProbe.kind === "inconclusive"
          ? "inconclusive"
          : rollbackProbe.kind === "fail"
            ? "defect-confirmed"
            : "defect-not-reproduced";
      return {
        asserterror,
        tableGlobalVar,
        transactionRollback,
        ...(asserterrorProbe.note !== undefined
          ? { asserterrorDetail: asserterrorProbe.note }
          : {}),
        ...(tableProbe.note !== undefined ? { tableGlobalVarDetail: tableProbe.note } : {}),
        ...(rollbackProbe.note !== undefined
          ? { transactionRollbackDetail: rollbackProbe.note }
          : {}),
      };
    } finally {
      await transport.close();
    }
  } catch (err) {
    const detail = `canary infrastructure failure: ${err instanceof Error ? err.message : String(err)}`;
    return {
      asserterror: "inconclusive",
      tableGlobalVar: "inconclusive",
      transactionRollback: "inconclusive",
      asserterrorDetail: detail,
      tableGlobalVarDetail: detail,
      transactionRollbackDetail: detail,
    };
  } finally {
    if (root !== undefined) await cleanUpQuietly(root, fsOps);
  }
}

/**
 * Turns a canary result into the `console.warn` lines `runFromCli` prints. Pure and
 * independently testable — `runFromCli` itself only needs to call `runAlRunnerCanary` once and
 * print whatever this returns, so the actual decision logic (what each verdict combination
 * should tell the operator) lives here instead of being buried in CLI wiring.
 *
 * Deliberately says something for EVERY verdict, including "defect-not-reproduced": a stale
 * warning that keeps naming a defect a newer al-runner build no longer has is exactly the kind
 * of silent-wrong-information this project refuses to ship, so a fixed build gets told apart
 * from an unconfirmed one rather than both going quiet.
 */
export function alRunnerCanaryWarnings(result: AlRunnerCanaryResult): string[] {
  const lines: string[] = [];

  if (result.asserterror === "defect-confirmed") {
    lines.push(
      "[lethal] al-runner canary CONFIRMED on this run (R7): it reports `pass` for an " +
        "`asserterror` that raised no error. Any mutant killable only by an asserterror " +
        "assertion is reported SURVIVED here — treat al-runner survivors as unconfirmed and " +
        "re-run them under --backend bcdev before acting on them.",
    );
  } else if (result.asserterror === "defect-not-reproduced") {
    lines.push(
      "[lethal] al-runner canary: the previously-measured asserterror defect (R7) did NOT " +
        "reproduce on this build — an asserterror guarding a non-raising statement correctly " +
        "failed.",
    );
  } else {
    lines.push(
      `[lethal] al-runner canary could not determine the asserterror defect's (R7) status on this build (${result.asserterrorDetail ?? "no detail"}) — treating al-runner survivors as unconfirmed out of caution; re-run them under --backend bcdev.`,
    );
  }

  if (result.tableGlobalVar === "defect-confirmed") {
    lines.push(
      "[lethal] al-runner canary CONFIRMED on this run (R8): a table object's own global " +
        "variable (not a field) does not survive from a trigger's write back into a later, " +
        "separate call on the same record variable. Any mutant whose only observable effect " +
        "is table-global state may be misjudged on this backend.",
    );
  } else if (result.tableGlobalVar === "defect-not-reproduced") {
    lines.push(
      "[lethal] al-runner canary: the previously-measured table-global-var defect (R8) did " +
        "NOT reproduce on this build.",
    );
  } else {
    lines.push(
      `[lethal] al-runner canary could not determine the table-global-var defect's (R8) status on this build (${result.tableGlobalVarDetail ?? "no detail"}).`,
    );
  }

  // R183. The polarity is the OPPOSITE of R7 and R8 and saying so here is the point: this probe
  // pins a gap that is PRESENT on the newest build, so `defect-confirmed` is the expected line and
  // `defect-not-reproduced` is the one that should make someone look.
  if (result.transactionRollback === "defect-confirmed") {
    lines.push(
      "[lethal] al-runner canary (R183): a row written inside `Codeunit.Run` SURVIVED the error " +
        "that ended it, so this build does not scope a write transaction around `Codeunit.Run` " +
        "the way BC does. This is the expected, measured state on 2.7.0.0, not a regression. " +
        "`asserterror` does roll back here, so only the `Codeunit.Run` shape is affected — a " +
        "`remove-commit` survivor on such a site is unconfirmed; re-run it under --backend bcdev.",
    );
  } else if (result.transactionRollback === "defect-not-reproduced") {
    lines.push(
      "[lethal] al-runner canary (R183): a row written inside `Codeunit.Run` was discarded by the " +
        "error, which al-runner 2.7.0.0 did NOT do. That is an improvement, and it means the " +
        "residual named in `AlRunnerBackend.capabilities()` may have closed — re-measure it " +
        "against bcdev rather than leaving the comment claiming a gap that is gone.",
    );
  } else {
    lines.push(
      `[lethal] al-runner canary could not determine whether this build scopes a write transaction around \`Codeunit.Run\` (R183) (${result.transactionRollbackDetail ?? "no detail"}) — treat a \`remove-commit\` survivor as unconfirmed and re-run it under --backend bcdev.`,
    );
  }

  return lines;
}
