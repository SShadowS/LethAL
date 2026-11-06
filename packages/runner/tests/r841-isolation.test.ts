import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactCompiler } from "../src/artifact";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  RunOpts,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import { generateMutationSet, runSession } from "../src/orchestrator";
import { ResultsStore } from "../src/store";
import { servesTestApp, testAppJson } from "./helpers/proven-test-app";
import { scratchDirs } from "./helpers/scratch";

const scratch = scratchDirs();

/**
 * R841: an `#if` shape whose SOURCE compiles but whose instrumented ARTIFACT alc refuses. Shape 1:
 * `until A #if X * 2 #endif > 3;` (the guard around `A` leaves `A * 2 > 3` split by the directive).
 * Measured live 2026-11-06 (real alc, builds [] and [LETHALX]): one mutant, `lethal.loop-truncate`,
 * fails with AL0175; the other ten compile and are scored.
 *
 * What runs in unit CI: the REAL generator, instrumenter, `runSession` and bisection; only alc is
 * FAKED (CI has no alc). The fake refuses an artifact exactly when its manifest holds the
 * loop-truncate mutant, which is the measured behaviour. The real-alc reading is in
 * docs/roadmap/R841.md.
 */

const APP_JSON = JSON.stringify({
  id: "fda67638-2fee-4a1c-94bd-bc37c357f0d9",
  name: "R841 Fixture",
  publisher: "LethAL",
  version: "1.0.0.0",
  idRanges: [{ from: 79600, to: 79649 }],
});

const SHAPE_AL = `codeunit 79600 "R402 Shape"
{
    procedure Loop()
    var
        A: Integer;
        B: Integer;
        C: Integer;
        Flag: Boolean;
        T: Text;
        L: List of [Integer];
    begin
repeat
A += 1;
until A
#if LETHALX
* 2
#endif
> 3;
    end;

    local procedure Check(P: Integer; Q: Integer): Boolean
    begin
        exit(P < Q);
    end;

    local procedure Foo(P: Integer)
    begin
    end;
    local procedure Bar()
    begin
    end;
}
`;

const HEALTHY_AL = `codeunit 79601 "R841 Healthy"
{
    procedure Add(P: Integer; Q: Integer): Integer
    begin
        exit(P + Q);
    end;

    procedure IsBig(P: Integer): Boolean
    begin
        exit(P > 10);
    end;
}
`;

const TEST_AL = `codeunit 79650 "R841 Tests"
{
    Subtype = Test;

    [Test]
    procedure ShapeRuns()
    begin
    end;
}
`;

const CAPS: BackendCapabilities = {
  coverage: "procedure",
  deploy: "publish",
  isolation: "session",
  kind: "bcdev",
  authoritative: true,
};

const selectorIds = { selectorId: 79649, controlId: 79648, tableId: 79647 };

async function makeProject() {
  const root = scratch("lethal-r841-");
  const projectDir = join(root, "app");
  const testDir = join(root, "tests");
  await Bun.write(join(projectDir, "src", "Shape.Codeunit.al"), SHAPE_AL);
  await Bun.write(join(projectDir, "src", "Healthy.Codeunit.al"), HEALTHY_AL);
  await Bun.write(join(projectDir, "app.json"), APP_JSON);
  await Bun.write(join(testDir, "Tests.Codeunit.al"), TEST_AL);
  await Bun.write(join(testDir, "app.json"), testAppJson());
  return { root, projectDir, testDir, instrumentedDir: join(root, "instr") };
}

interface Manifest {
  mutants: Array<{ operatorName: string; mutantId: string }>;
}
type Rule = (m: Manifest) => boolean;

const AL0175 =
  "Shape.Codeunit.al(1,1): error AL0175: Operator '>' cannot be applied to operands of type 'Boolean' and 'Integer'.";

/** A backend whose alc is fake: `refuses(manifest)` decides, for an INSTRUMENTED dir only. */
class FakeAlcBackend implements ExecutionBackend {
  deploys = 0;
  checks = 0;
  plainCompiles = 0;
  private activations: Array<string | null> = [];
  private readonly compiler: ArtifactCompiler;
  private readonly testApp = servesTestApp();
  fetchPublishedAppPackage = this.testApp.fetchPublishedAppPackage;
  microsoftMode = this.testApp.microsoftMode;

  constructor(outputDir: string, refuses: Rule) {
    this.compiler = new ArtifactCompiler(
      { alcPath: "/fake/alc", packageCachePath: "/fake/.alpackages", outputDir },
      {
        spawn: async (argv) => {
          const projectDir = argv.find((a) => a.startsWith("/project:"))?.slice(9) ?? "";
          const files = await readdir(projectDir);
          if (files.includes("mutant-manifest.json")) {
            const m = JSON.parse(
              await readFile(join(projectDir, "mutant-manifest.json"), "utf8"),
            ) as Manifest;
            if (refuses(m)) return { exitCode: 1, stdout: AL0175, stderr: "" };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        readArtifact: async () => new Uint8Array([1, 2, 3]),
        writeArtifact: async () => {},
      },
    );
  }
  capabilities(): BackendCapabilities {
    return CAPS;
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "r841" };
  }
  private async compile(dir: string): Promise<void> {
    await this.compiler.compileProject({ projectDir: dir, packageCachePath: "/p", name: "x" });
  }
  async deploy(dir: string) {
    this.deploys++;
    await this.compile(dir);
    return null;
  }
  async compileCheck(dir: string): Promise<void> {
    this.checks++;
    await this.compile(dir);
  }
  async compilePlainCheck(dir: string): Promise<void> {
    this.plainCompiles++;
    await this.compile(dir);
  }
  async activate(id: string | null): Promise<void> {
    this.activations.push(id);
  }
  async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
    const active = this.activations.at(-1) ?? null;
    return {
      ref,
      outcome: "pass",
      durationMs: 5,
      ...(active === null
        ? {
            coverage: {
              granularity: "procedure" as const,
              entries: [
                { objectType: "Codeunit", objectId: 79600, procedure: "Loop" },
                { objectType: "Codeunit", objectId: 79601, procedure: "Add" },
                { objectType: "Codeunit", objectId: 79601, procedure: "IsBig" },
              ],
            },
          }
        : {}),
      ...(opts.coverage === "none"
        ? { attestation: { observedAny: true, identityMismatch: false } }
        : {}),
    };
  }
}

const hasLoopTruncate: Rule = (m) =>
  m.mutants.some((x) => x.operatorName === "lethal.loop-truncate");

async function drive(refuses: Rule) {
  const dirs = await makeProject();
  const backend = new FakeAlcBackend(dirs.root, refuses);
  const store = new ResultsStore(":memory:");
  const warnings: string[] = [];
  const report = await runSession({
    backend,
    store,
    ...dirs,
    selectorIds,
    emit: [
      (e: { type: string; code?: string }) => {
        if (e.type === "warning" && e.code !== undefined) warnings.push(e.code);
      },
    ],
  } as never);
  store.close();
  const sites = await generateMutationSet(dirs.projectDir, {
    preprocessorSymbols: [],
    emit: () => {},
  });
  const siteCount = sites.files.reduce((n, f) => n + [...f.specs].length, 0);
  return { report, backend, warnings, siteCount };
}

describe("R841 shape 1: the artifact fails alc, the source does not", () => {
  test("one mutant is an error row that names it; the other ten are scored; no row is lost", async () => {
    const { report, backend, warnings, siteCount } = await drive(hasLoopTruncate);
    // The site count is pinned as a number too, so a generator that stopped finding sites cannot
    // make "rows == sites" pass on 0 == 0.
    expect(siteCount).toBe(11);
    expect(report.mutants.length).toBe(siteCount);
    const errors = report.mutants.filter((m) => m.verdict === "error");
    expect(errors.length).toBe(1);
    const [bad] = errors;
    expect(bad?.mutantCode).toBe("M0008");
    expect(bad?.operatorName).toBe("lethal.loop-truncate");
    expect(bad?.line).toBe(14);
    expect(bad?.file).toBe("src/Shape.Codeunit.al");
    expect(bad?.failureNote).toContain(
      `mutant M0008 (${bad?.file}:${bad?.line} lethal.loop-truncate) fails to compile on its own: AL0175`,
    );
    // The other ten are scored: survived or no-coverage, none left as error or missing.
    const rest = report.mutants.filter((m) => m.verdict !== "error");
    expect(rest.length).toBe(10);
    expect(rest.filter((m) => m.verdict === "survived").length).toBe(7);
    expect(rest.filter((m) => m.verdict === "no-coverage").length).toBe(3);
    expect(report.counts.errors).toBe(1);
    // Bisection ran, the unmutated build was checked once, and the clean set was redeployed.
    expect(backend.plainCompiles).toBe(1);
    expect(backend.deploys).toBe(2);
    expect(warnings).toContain("compile-isolation");
    expect(warnings).toContain("compile-isolation-result");
  });
});

describe("R841 limit 2: the artifact fails with ZERO mutants applied", () => {
  const assertLoud = (
    report: Awaited<ReturnType<typeof drive>>["report"],
    siteCount: number,
    why: RegExp,
  ) => {
    // Every site is a row, every row is an error with a note, nothing is scored.
    expect(report.mutants.length).toBe(siteCount);
    expect(report.counts.errors).toBe(siteCount);
    expect(report.counts.killed + report.counts.survived + report.counts.noCoverage).toBe(0);
    for (const m of report.mutants) {
      expect(m.verdict).toBe("error");
      expect(m.failureNote ?? "").toMatch(why);
    }
    // And the report says so by name, with no score to read as a pass.
    expect(report.mutationScore).toBeNull();
    expect(JSON.stringify(report)).toContain("all-errors");
  };

  test("the empty artifact fails (the 'environmental' plan): every mutant is an error row with alc's text", async () => {
    // Refuses every instrumented dir, the empty one included.
    const { report, siteCount, backend } = await drive(() => true);
    expect(siteCount).toBe(11);
    assertLoud(report, siteCount, /AL0175/);
    // Nothing was redeployed: one deploy (the failing one) only.
    expect(backend.deploys).toBe(1);
  });

  test("every mutant is isolated out (empty clean set): every mutant is an error row naming itself", async () => {
    // Fails whenever any mutant is present; the empty artifact compiles.
    const { report, siteCount, backend } = await drive((m) => m.mutants.length > 0);
    expect(siteCount).toBe(11);
    assertLoud(report, siteCount, /fails to compile on its own: AL0175/);
    // No redeploy of an empty clean set.
    expect(backend.deploys).toBe(1);
  });
});
