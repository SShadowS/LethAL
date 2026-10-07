import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import { FLAT_NAMES_FILENAME, flatNamesFor } from "@lethal/schemata";
import { alRunnerCoverageFrom, buildAlRunnerCoverageIndex } from "../src/al-runner-coverage";
import { AlcCompileError, ArtifactCompiler } from "../src/artifact";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import { readAlSources } from "../src/line-map";
import { runSession } from "../src/orchestrator";
import { serializeKey } from "../src/selection";
import { ResultsStore } from "../src/store";

/**
 * R219: two project `.al` files with the same basename in different directories (Continia Document
 * Capture: `UserControls/Label/ScannerUI.al` and `UserControls/ScannerUI/ScannerUI.al`) used to
 * refuse the whole project, because batches are written flat. Each now gets its own flat name, and
 * everything that names a batch file to a user names the project file.
 */

// The SAME procedure text in both, so only the file and the object can tell their mutants apart.
const helper = (id: number, name: string) => `codeunit ${id} "${name}"
{
    procedure Pick(X: Integer): Integer
    begin
        if X > 1 then
            exit(1);
        exit(0);
    end;
}
`;
const SALES = "Sales/Helper.Codeunit.al";
const PURCHASE = "Purchase/Helper.Codeunit.al";
const TEST_AL = `codeunit 50190 "Helper Tests"
{
    Subtype = Test;

    [Test]
    procedure PickRuns()
    begin
    end;
}
`;

/** Every test passes and covers both `Pick`s, so every mutant survives. Records each deploy. */
class SurviveBackend implements ExecutionBackend {
  readonly deploys: string[] = [];
  private active: string | null = null;
  capabilities(): BackendCapabilities {
    return { coverage: "procedure", deploy: "publish", isolation: "session", authoritative: true };
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "stub" };
  }
  async deploy(dir: string): Promise<null> {
    this.deploys.push(dir);
    return null;
  }
  async compileCheck(): Promise<void> {}
  async activate(id: string | null): Promise<void> {
    this.active = id;
  }
  async run(ref: TestMethodRef): Promise<TestVerdict> {
    return {
      ref,
      outcome: "pass",
      durationMs: 5,
      ...(this.active === null
        ? {
            coverage: {
              granularity: "procedure" as const,
              entries: [
                { objectType: "Codeunit", objectId: 50100, procedure: "Pick" },
                { objectType: "Codeunit", objectId: 50101, procedure: "Pick" },
              ],
            },
          }
        : { attestation: { observedAny: true, identityMismatch: false } }),
    };
  }
}

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

let run: {
  readonly report: Awaited<ReturnType<typeof runSession>>;
  readonly batch: string;
  readonly projectDir: string;
};

beforeAll(async () => {
  await initParser();
  const root = await mkdtemp(join(tmpdir(), "lethal-r219-"));
  roots.push(root);
  const projectDir = join(root, "app");
  const testDir = join(root, "tests");
  await Bun.write(
    join(projectDir, "app.json"),
    JSON.stringify({
      id: "21921921-2192-4192-8192-219219219219",
      name: "R219",
      publisher: "LethAL",
      version: "1.0.0.0",
      idRanges: [{ from: 50100, to: 50199 }],
    }),
  );
  await Bun.write(join(projectDir, SALES), helper(50100, "Sales Helper"));
  await Bun.write(join(projectDir, PURCHASE), helper(50101, "Purchase Helper"));
  await Bun.write(join(testDir, "HelperTests.Codeunit.al"), TEST_AL);
  const backend = new SurviveBackend();
  const report = await runSession({
    backend,
    store: new ResultsStore(":memory:"),
    projectDir,
    testDir,
    instrumentedDir: join(root, "instr"),
    selectorIds: { selectorId: 50197, controlId: 50198, tableId: 50199 },
  });
  const [batch] = backend.deploys;
  if (batch === undefined) throw new Error("nothing was deployed");
  run = { report, batch, projectDir };
});

describe("R219: two same-basename files in different directories", () => {
  const names = flatNamesFor([SALES, PURCHASE]);

  test("both are instrumented, each under its own flat name, with distinct identities", async () => {
    const byFile = (f: string) => run.report.mutants.filter((m) => m.file === f);
    const sales = byFile(SALES);
    const purchase = byFile(PURCHASE);
    expect(sales.length).toBeGreaterThan(0);
    expect(purchase.length).toBe(sales.length);
    const keys = run.report.mutants.map((m) =>
      serializeKey({
        astHash: m.astHash,
        codeunitName: m.codeunitName,
        procedureName: m.procedureName ?? "",
        operatorName: m.operatorName,
        operatorMajor: m.operatorMajor,
        ordinal: m.identityOrdinal ?? 0,
      }),
    );
    expect(new Set(keys).size).toBe(keys.length);
    expect(sales.every((m) => m.codeunitName === "Sales Helper")).toBe(true);
    expect(purchase.every((m) => m.codeunitName === "Purchase Helper")).toBe(true);
    // Each object in its own file: neither overwrote the other.
    expect(await readFile(join(run.batch, names.flatOf(SALES)), "utf8")).toContain(
      'codeunit 50100 "Sales Helper"',
    );
    expect(await readFile(join(run.batch, names.flatOf(PURCHASE)), "utf8")).toContain(
      'codeunit 50101 "Purchase Helper"',
    );
  });

  test("al-runner coverage on a flat name is credited to that file's object", async () => {
    const index = await buildAlRunnerCoverageIndex(run.batch);
    // `if X > 1 then` is line 5 of each file; al-runner names the file it compiled.
    const hit = (file: string) =>
      alRunnerCoverageFrom([{ file: `/bundle/${file}`, line: 5, hits: 1 }], index).entries.map(
        (e) => e.objectId,
      );
    expect(hit(names.flatOf(SALES))).toEqual([50100]);
    expect(hit(names.flatOf(PURCHASE))).toEqual([50101]);
  });

  test("a file quoted from the batch (line map, refusals) is named by its project path", async () => {
    const paths = (await readAlSources(run.batch)).map((s) => s.path);
    expect(paths).toContain(SALES);
    expect(paths).toContain(PURCHASE);
    expect(paths.some((p) => p.includes(names.flatOf(SALES)))).toBe(false);
  });

  test("an alc error in a renamed file names the project file", async () => {
    const flat = names.flatOf(PURCHASE);
    const compiler = new ArtifactCompiler(
      { alcPath: "alc", packageCachePath: "/p", outputDir: join(run.batch, "..", "out") },
      {
        spawn: async () => ({
          exitCode: 1,
          stdout: `${flat}(5,12): error AL0118: The name 'Y' does not exist in the current context.`,
          stderr: "",
        }),
        readArtifact: async () => new Uint8Array(),
        writeArtifact: async () => {},
      },
    );
    const err = await compiler
      .compileProject({ projectDir: run.batch, packageCachePath: "/p", name: "x" })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(AlcCompileError);
    expect((err as Error).message).toContain(`${flat}(5,12): error AL0118`);
    expect((err as Error).message).toContain(`${flat} is ${PURCHASE}`);
    expect((err as Error).message).not.toContain(`${names.flatOf(SALES)} is ${PURCHASE}`);
  });

  test("the batch records the renamed files", async () => {
    expect(JSON.parse(await readFile(join(run.batch, FLAT_NAMES_FILENAME), "utf8"))).toEqual({
      [names.flatOf(SALES)]: SALES,
      [names.flatOf(PURCHASE)]: PURCHASE,
    });
  });
});
