import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dedupeSpecs } from "@lethal/schemata";
import type { CompiledArtifact } from "../src/artifact";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  RunOpts,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import { parseCliConfig, resolveLineRanges } from "../src/cli";
import type { RunEvent, RunEventInput } from "../src/events";
import { parseLineArg, parseUnifiedDiffAdded, spanTouches } from "../src/line-filter";
import { generateMutationSet, operatorTiers, runSession } from "../src/orchestrator";
import { buildReport, renderConsole } from "../src/report";
import { sessionFingerprint } from "../src/resume";
import { ResultsStore } from "../src/store";

/**
 * Issue #19 (R227): a line-scoped mutant filter for PR runs. Two properties are load-bearing:
 *   - it cannot change a VERDICT, so what it keeps is a subset of an unfiltered run's DEPLOYED set;
 *   - it cannot silently select nothing, so an unknown file and an empty result both throw.
 */

const APP_JSON = JSON.stringify({
  id: "0f2b7c5e-4d3a-4917-8a1c-3b4a8d9f1027",
  name: "Line Scope Fixture",
  publisher: "LethAL",
  version: "1.0.0.0",
  idRanges: [{ from: 79000, to: 79199 }],
});

// Line numbers matter here. `IsOver` is lines 3-6 (its `exit` on 5), `IsUnder` lines 8-11 (its
// `exit` on 10).
const TARGET_AL = `codeunit 79000 "Sandbox Logic"
{
    procedure IsOver(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount > Budget);
    end;

    procedure IsUnder(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount < Budget);
    end;
}
`;
const FILE = "SandboxLogic.Codeunit.al";

const TEST_AL = `codeunit 79100 "Sandbox Tests"
{
    Subtype = Test;

    [Test]
    procedure T()
    begin
    end;
}
`;

async function withProject<T>(body: (projectDir: string, root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "lethal-lines-"));
  const projectDir = join(root, "app");
  await Bun.write(join(projectDir, FILE), TARGET_AL);
  await Bun.write(join(projectDir, "app.json"), APP_JSON);
  await Bun.write(join(root, "tests", "SandboxTests.Codeunit.al"), TEST_AL);
  try {
    return await body(projectDir, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const tierOf = (n: string) => operatorTiers.get(n);

describe("parsing", () => {
  test("parseLineArg reads a range, a single line, and backslashes", () => {
    expect(parseLineArg("src/A.al:3-9")).toEqual({ file: "src/A.al", start: 3, end: 9 });
    expect(parseLineArg("src\\A.al:4")).toEqual({ file: "src/A.al", start: 4, end: 4 });
    expect(() => parseLineArg("src/A.al")).toThrow("expected <file>");
    expect(() => parseLineArg("src/A.al:9-3")).toThrow("must not exceed");
    expect(() => parseLineArg("src/A.al:0")).toThrow("1-based");
  });

  test("parseUnifiedDiffAdded keeps added ranges, drops pure deletions and deleted files", () => {
    const diff = [
      "diff --git a/src/A.al b/src/A.al",
      "--- a/src/A.al",
      "+++ b/src/A.al",
      "@@ -3,2 +3,3 @@ procedure",
      "@@ -10 +11 @@",
      "@@ -20,4 +21,0 @@",
      "diff --git a/src/Gone.al b/src/Gone.al",
      "--- a/src/Gone.al",
      "+++ /dev/null",
      "@@ -1,5 +0,0 @@",
    ].join("\n");
    expect(parseUnifiedDiffAdded(diff)).toEqual([
      { file: "src/A.al", start: 3, end: 5 },
      { file: "src/A.al", start: 11, end: 11 },
    ]);
  });

  test("spanTouches: any shared line counts, and the file compares case-insensitively", () => {
    const r = [{ file: "src/A.al", start: 5, end: 5 }];
    expect(spanTouches(r, "SRC\\a.al", 4, 11)).toBe(true);
    expect(spanTouches(r, "src/A.al", 6, 11)).toBe(false);
    expect(spanTouches(r, "src/B.al", 5, 5)).toBe(false);
  });

  test("the CLI parses --lines (repeatable) and --changed-since, and leaves both absent", () => {
    const base = ["run", "--project", "p", "--tests", "t", "--backend", "al-runner"];
    const cfg = parseCliConfig([
      ...base,
      "--lines",
      "A.al:1-2",
      "--lines",
      "B.al:7",
      "--changed-since",
      "origin/main",
    ]);
    expect(cfg).toMatchObject({
      lines: [
        { file: "A.al", start: 1, end: 2 },
        { file: "B.al", start: 7, end: 7 },
      ],
      changedSince: "origin/main",
    });
    const bare = parseCliConfig(base);
    expect("lines" in bare).toBe(false);
    expect("changedSince" in bare).toBe(false);
    expect(() => parseCliConfig([...base, "--changed-since", ""])).toThrow("requires a git ref");
  });

  test("resolveLineRanges unions --lines with the diff, keeping only .al files", async () => {
    const seen: string[][] = [];
    const spawn = async (argv: readonly string[]) => {
      seen.push([...argv]);
      return {
        exitCode: 0,
        stderr: "",
        stdout: "+++ b/app.json\n@@ -1 +1 @@\n+++ b/src/X.al\n@@ -4,0 +5,2 @@\n",
      };
    };
    const r = await resolveLineRanges(
      { projectDir: "p", lines: [{ file: "A.al", start: 1, end: 1 }], changedSince: "main" },
      spawn,
    );
    expect(r).toEqual([
      { file: "A.al", start: 1, end: 1 },
      { file: "src/X.al", start: 5, end: 6 },
    ]);
    expect(seen[0]).toContain("main...HEAD");
    expect(seen[0]).toContain("--relative");
    expect(await resolveLineRanges({ projectDir: "p" }, spawn)).toBeUndefined();
  });

  test("a failing git diff throws, naming the ref", async () => {
    const spawn = async () => ({ exitCode: 128, stdout: "", stderr: "bad revision" });
    await expect(
      resolveLineRanges({ projectDir: "p", changedSince: "nope" }, spawn),
    ).rejects.toThrow(/--changed-since nope.*bad revision/);
  });
});

describe("generateMutationSet with a line filter", () => {
  test("keeps only mutants touching the lines, as a subset of the unfiltered DEPLOYED set", async () => {
    await withProject(async (projectDir) => {
      const all = await generateMutationSet(projectDir);
      const scoped = await generateMutationSet(projectDir, {
        lines: [{ file: FILE, start: 5, end: 5 }],
      });
      const deployed = all.files.flatMap((f) => dedupeSpecs(f.specs, tierOf));
      const kept = scoped.files.flatMap((f) => f.specs);
      const key = (s: { operatorName: string; before: { startIndex: number } }) =>
        `${s.operatorName}@${s.before.startIndex}`;
      const deployedKeys = new Set(deployed.map(key));
      expect(kept.length).toBeGreaterThan(0);
      for (const s of kept) expect(deployedKeys.has(key(s))).toBe(true);
      // Every kept mutant touches line 5, and none of IsUnder's (line 10) survived.
      for (const s of kept) {
        expect(s.before.startPosition.row + 1).toBeLessThanOrEqual(5);
        expect(s.before.endPosition.row + 1).toBeGreaterThanOrEqual(5);
      }
      expect(scoped.excludedByLines).toBe(deployed.length - kept.length);
      expect(scoped.excludedByLines).toBeGreaterThan(0);
      expect(all.excludedByLines).toBe(0);
    });
  });

  test("a range naming a file the project does not have is refused", async () => {
    await withProject(async (projectDir) => {
      await expect(
        generateMutationSet(projectDir, { lines: [{ file: "Nope.al", start: 1, end: 1 }] }),
      ).rejects.toThrow(/not \.al files in this project: "Nope\.al"/);
    });
  });

  test("a filter that keeps nothing is refused", async () => {
    await withProject(async (projectDir) => {
      await expect(
        generateMutationSet(projectDir, { lines: [{ file: FILE, start: 1, end: 2 }] }),
      ).rejects.toThrow(/kept no deployable mutation site/);
    });
  });
});

describe("the report and the fingerprint", () => {
  const CAPS = {
    authoritative: true,
    coverage: "procedure",
    deploy: "publish",
    isolation: "session",
  } as const;

  test("buildReport pushes `line-narrowed`, narrows reliability, and renders the ranges", () => {
    const events: RunEvent[] = (
      [
        {
          type: "mutation-set-generated",
          siteCount: 3,
          deployedCount: 3,
          hangCapableCount: 0,
          totalFiles: 1,
          instrumentableFiles: 1,
          notInstrumentedFiles: [],
          declarativeSiteFiles: [],
          excludedByOnly: 0,
          excludedByExclude: 0,
          excludedByOperator: 0,
          excludedByLines: 7,
        },
        { type: "baseline-batch-finished", batchIndex: 0, verdicts: [] },
        { type: "session-finished", elapsedMs: 10 },
      ] as RunEventInput[]
    ).map((e, i) => ({ ...e, seq: i + 1 }) as RunEvent);
    const r = buildReport(
      { caps: CAPS, lines: { ranges: [{ file: FILE, start: 5, end: 5 }] } },
      events,
    );
    expect(r.validity.caveats).toContain("line-narrowed");
    expect(r.validity.reliability).toBe("narrowed");
    expect(r.lines).toEqual({ ranges: [{ file: FILE, start: 5, end: 5 }], excludedSiteCount: 7 });
    expect(renderConsole(r)).toContain(`NARROWED (lines): ${FILE}:5-5`);
    const plain = buildReport({ caps: CAPS }, events);
    expect(plain.validity.caveats).not.toContain("line-narrowed");
    expect(plain.lines).toBeUndefined();
  });

  test("a different line scope is a different fingerprint; no scope keeps the old digest", () => {
    const base = {
      projectDir: "p",
      testDir: "t",
      backend: "bcdev",
      skipKnownSurvivors: false,
      selectorIds: { selectorId: 1, controlId: 2, tableId: 3 },
    };
    const a = sessionFingerprint({ ...base, lines: [{ file: FILE, start: 5, end: 5 }] });
    const b = sessionFingerprint({ ...base, lines: [{ file: FILE, start: 10, end: 10 }] });
    expect(a).not.toBe(b);
    expect(a).not.toBe(sessionFingerprint(base));
  });
});

describe("runSession: the line filter reaches both the mutant set AND the report", () => {
  const RUN_CAPS: BackendCapabilities = {
    coverage: "procedure",
    deploy: "publish",
    isolation: "session",
    authoritative: false,
  };

  class StubBackend implements ExecutionBackend {
    private activations: Array<string | null> = [];
    capabilities(): BackendCapabilities {
      return RUN_CAPS;
    }
    async status(): Promise<BackendStatus> {
      return { ok: true, details: "stub" };
    }
    async deploy(): Promise<CompiledArtifact | null> {
      return null;
    }
    async compileCheck(): Promise<void> {}
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
                  { objectType: "Codeunit", objectId: 79000, procedure: "IsOver" },
                  { objectType: "Codeunit", objectId: 79000, procedure: "IsUnder" },
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

  async function runWith(
    lines: readonly { file: string; start: number; end: number }[] | undefined,
  ) {
    return withProject(async (projectDir, root) => {
      const store = new ResultsStore(":memory:");
      try {
        return await runSession({
          backend: new StubBackend(),
          store,
          projectDir,
          testDir: join(root, "tests"),
          instrumentedDir: join(root, "instr"),
          selectorIds: { selectorId: 50000, controlId: 50001, tableId: 50002 },
          ...(lines !== undefined ? { lines } : {}),
        });
      } finally {
        store.close();
      }
    });
  }

  test("only IsOver's mutants run, and the report records the filter", async () => {
    const unfiltered = await runWith(undefined);
    const scoped = await runWith([{ file: FILE, start: 5, end: 5 }]);
    expect(scoped.mutants.length).toBeGreaterThan(0);
    expect(scoped.mutants.every((m) => m.procedureName === "IsOver")).toBe(true);
    expect(unfiltered.mutants.some((m) => m.procedureName === "IsUnder")).toBe(true);
    expect(scoped.lines?.excludedSiteCount).toBe(unfiltered.mutants.length - scoped.mutants.length);
    expect(scoped.validity.caveats).toContain("line-narrowed");
    expect(unfiltered.validity.caveats).not.toContain("line-narrowed");
  });
});
