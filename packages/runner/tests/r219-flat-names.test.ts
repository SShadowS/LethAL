import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import { FLAT_NAMES_FILENAME, flatNamesFor } from "@lethal/schemata";
import {
  alRunnerCoverageFrom,
  alRunnerCoverageFromServer,
  buildAlRunnerCoverageIndex,
} from "../src/al-runner-coverage";
import { AlcCompileError, ArtifactCompiler } from "../src/artifact";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import { readBatchBundle } from "../src/installed-bundle";
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

  // Sol run 001 (1, 4). MEASURED on al-runner c39ad5de (2026-10-07, probe in the lane scratchpad),
  // both transports: for a duplicate pair written flat, al-runner labels coverage with the path it
  // knows for this app id, either the project SOURCE path (`proj/Sales/Helper.Codeunit.al`) or a
  // batch's own flat path (`batch/Helper.Codeunit.8de4e0ea.al`); lines and scopes are the compiled
  // file's. Both shapes must credit the right file, with complete entries, at emitted lines.
  describe("al-runner coverage of a renamed file, in each measured path shape and transport", () => {
    /**
     * The 1-based line of the emitted `file` holding `needle` in the ORIGINAL arm, the dispatch's
     * final `end else begin` (the statements an unmutated run executes), verified: exactly one
     * such arm, and the line's text is the statement itself.
     */
    const lineOf = async (file: string, needle: string): Promise<number> => {
      const lines = (await readFile(join(run.batch, file), "utf8")).split("\n");
      const arms = lines.flatMap((l, i) => (l.trim() === "end else begin" ? [i] : []));
      expect(arms).toHaveLength(1);
      const start = arms[0] ?? 0;
      const at = lines.findIndex((l, i) => i > start && l.includes(needle));
      expect(lines[at]?.trim()).toBe(needle === "if X > 1 then" ? needle : `${needle};`);
      return at + 1;
    };
    // Asymmetric, as the probe's two tests were: Sales takes the `exit(1)` arm, Purchase `exit(0)`.
    const covered = async (path: string) => {
      const flat = names.flatOf(path);
      return [
        await lineOf(flat, "if X > 1 then"),
        await lineOf(flat, path === SALES ? "exit(1)" : "exit(0)"),
      ];
    };
    const shapes = [
      ["the project source path", (p: string) => `/work/somewhere/app/${p}`],
      ["a batch's own flat path", (p: string) => `/tmp/lethal-x/run-1-batch-0/${names.flatOf(p)}`],
    ] as const;
    for (const [what, label] of shapes) {
      test(`one-shot Cobertura labelled with ${what}`, async () => {
        const index = await buildAlRunnerCoverageIndex(run.batch);
        for (const [path, id] of [
          [SALES, 50100],
          [PURCHASE, 50101],
        ] as const) {
          const lines = await covered(path);
          const map = alRunnerCoverageFrom(
            lines.map((line) => ({ file: label(path), line, hits: 1 })),
            index,
          );
          expect(map.entries).toEqual(
            lines.map((line) => ({
              objectType: "Codeunit",
              objectId: id,
              procedure: "Pick",
              line,
            })),
          );
        }
      });
      test(`--server statements labelled with ${what}`, async () => {
        const index = await buildAlRunnerCoverageIndex(run.batch);
        for (const [path, id] of [
          [SALES, 50100],
          [PURCHASE, 50101],
        ] as const) {
          const lines = await covered(path);
          const map = alRunnerCoverageFromServer(
            {
              test: "Codeunit50190.X",
              coverage: [
                {
                  file: label(path),
                  statements: lines.map((line) => ({ scope: "Pick", line, hits: 1 })),
                },
              ],
            },
            index,
          );
          expect(map.entries).toEqual(
            lines.map((line) => ({
              objectType: "Codeunit",
              objectId: id,
              procedure: "Pick",
              line,
            })),
          );
        }
      });
    }
    test("a bare duplicate basename names neither file: refused by name, on both transports", async () => {
      const index = await buildAlRunnerCoverageIndex(run.batch);
      const why = /names neither by its project folder nor by its batch name/;
      expect(() =>
        alRunnerCoverageFrom([{ file: "/x/Helper.Codeunit.al", line: 5, hits: 1 }], index),
      ).toThrow(why);
      expect(() =>
        alRunnerCoverageFromServer(
          {
            test: "Codeunit50190.X",
            coverage: [{ file: "/x/Helper.Codeunit.al", statements: [{ line: 5, hits: 1 }] }],
          },
          index,
        ),
      ).toThrow(why);
    });
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

  // The verify path's refusals quote the stored bundle's paths, so a renamed file is stored under
  // its project path. Revert: store `e` instead of `display(e)` in `readBatchBundle`.
  test("the installed bundle stores a renamed file under its project path", async () => {
    const appPath = join(run.batch, "..", "r219.app");
    await Bun.write(appPath, "app");
    const bundle = await readBatchBundle(run.batch, appPath, Bun.SHA256.hash("app", "hex"));
    const paths = bundle.files.map((f) => f.path);
    expect(paths).toContain(SALES);
    expect(paths).toContain(PURCHASE);
    expect(paths.some((p) => p.includes(names.flatOf(SALES)))).toBe(false);
  });

  test("the batch records the renamed files", async () => {
    expect(JSON.parse(await readFile(join(run.batch, FLAT_NAMES_FILENAME), "utf8"))).toEqual({
      [names.flatOf(SALES)]: SALES,
      [names.flatOf(PURCHASE)]: PURCHASE,
    });
  });
});
