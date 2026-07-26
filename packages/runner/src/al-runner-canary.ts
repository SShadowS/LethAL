import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OneShotTransport } from "./al-runner-transport";
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
 * Two independent probes, run ONCE per `--backend al-runner` session (never per mutant — the
 * ~2.5s cost of two al-runner invocations is immaterial against a real mutation run, though it
 * would not be against a single-mutant smoke test):
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
 *
 * Both probes are written as a plain (unguarded) `Error()` failure/success rather than as an
 * `asserterror` assertion themselves — deliberately, since the R7 defect would otherwise
 * contaminate the R8 probe's own signal. An unguarded `Error()` is already proven to fail a
 * test correctly on al-runner (`OverBudgetDetected`'s kills in fixtures/README.md's expected
 * verdict table), so its pass/fail outcome here is a clean read on its own trigger semantics.
 */

export type CanaryVerdict = "defect-confirmed" | "defect-not-reproduced" | "inconclusive";

export interface AlRunnerCanaryResult {
  readonly asserterror: CanaryVerdict;
  readonly tableGlobalVar: CanaryVerdict;
  /** Present only when the corresponding verdict carries a diagnostic worth surfacing. */
  readonly asserterrorDetail?: string;
  readonly tableGlobalVarDetail?: string;
}

const ASSERTERROR_METHOD = "AsserterrorNeverRaises";
const TABLE_GLOBAL_VAR_METHOD = "GlobalVarSurvivesValidate";

// Fixed, arbitrary GUIDs for the two throwaway canary "apps" — never published anywhere, never
// touching a real project's id space, so there is no reason for these to be random per run.
const CANARY_DATA_APP_ID = "d4c9a2e1-6b3f-4a7d-9c1e-8f2b5a6d3c47";
const CANARY_TESTS_APP_ID = "f7e1b3a0-2c4d-4e8f-9a1b-3d5c7e9f1a2b";
// Object ids are local to this throwaway pair of apps and never coexist with a real project's
// compilation, so they don't need to dodge DEFAULT_SELECTOR_IDS (79197-79199) — chosen well
// clear of it purely for readability.
const CANARY_TABLE_ID = 50000;
const CANARY_TESTS_CODEUNIT_ID = 50001;

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
      idTo: CANARY_TESTS_CODEUNIT_ID,
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
  const res = await transport.send({
    sourceDir,
    testDir,
    method,
    testTimeoutSeconds: CANARY_TEST_TIMEOUT_SECONDS,
    deadlineMs: CANARY_DEADLINE_MS,
  });
  if (res.kind === "deadline") return { kind: "inconclusive", note: "canary probe timed out" };
  if (res.kind === "skip")
    return { kind: "inconclusive", note: `al-runner reported a limitation: ${res.detail}` };
  if (res.kind === "error") return { kind: "inconclusive", note: res.detail };
  const t = res.tests.find((x) => x.name === method);
  if (t === undefined) {
    return { kind: "inconclusive", note: "al-runner output did not include the canary test" };
  }
  // Mirrors AlRunnerBackend.run()'s own reading: al-runner reports exactly "pass"/"fail" per
  // test, so anything other than "pass" is a fail for this probe's purposes too.
  return t.status === "pass"
    ? { kind: "pass" }
    : { kind: "fail", ...(t.message !== undefined ? { note: t.message } : {}) };
}

/**
 * Runs both probes against `alRunnerPath` in a fresh scratch directory, always cleaned up
 * (success, defect, or infrastructure failure alike — a canary that leaked scratch dirs on
 * every session would be its own small bug).
 */
export async function runAlRunnerCanary(
  alRunnerPath: string,
  spawn: SpawnFn = defaultSpawn,
): Promise<AlRunnerCanaryResult> {
  const root = await mkdtemp(join(tmpdir(), "lethal-alrunner-canary-"));
  try {
    const { dataDir, testDir } = await writeCanaryProject(root);
    const transport = new OneShotTransport(alRunnerPath, spawn);
    try {
      const asserterrorProbe = await probe(transport, dataDir, testDir, ASSERTERROR_METHOD);
      const tableProbe = await probe(transport, dataDir, testDir, TABLE_GLOBAL_VAR_METHOD);
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
      return {
        asserterror,
        tableGlobalVar,
        ...(asserterrorProbe.note !== undefined
          ? { asserterrorDetail: asserterrorProbe.note }
          : {}),
        ...(tableProbe.note !== undefined ? { tableGlobalVarDetail: tableProbe.note } : {}),
      };
    } finally {
      await transport.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
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

  return lines;
}
