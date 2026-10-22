// R654 S3: the .NET al-runner (v2) is retired. Each refusal is named `al-runner-v2-retired`, and
// each is pinned both ways: the v2 input is refused by that name, and the v3 or bcdev input is not.
// Pre-committed texts: /coord/handoff/R-654/s3-precommitment.md §3.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDENTITY_SCHEME } from "@lethal/schemata";
import { freezeStageTo } from "../src/campaign-freeze";
import { parseCliConfig } from "../src/cli";
import { assertExplainableReport } from "../src/explain";
import { ResultsStore, backendBuildRefusal } from "../src/store";
import { AlRunnerV2RetiredError } from "../src/v2-retired";

const FLAG_TEXT =
  "al-runner-v2-retired: the .NET al-runner backend was retired (R654); use --backend al-runner-v3";
const runText = (id: number) =>
  `al-runner-v2-retired: run ${id} ran on the retired .NET al-runner (R654); nothing of it is lent`;

describe("R654 F1: --backend al-runner is refused by name", () => {
  const run = (backend: string) =>
    parseCliConfig(["run", "--project", "proj", "--tests", "t", "--backend", backend]);
  const dry = (backend: string) =>
    parseCliConfig(["run", "--project", "proj", "--dry-run", "--backend", backend]);

  test("run and dry-run refuse al-runner as retired, not as unknown", () => {
    for (const parse of [run, dry]) {
      let err: unknown;
      try {
        parse("al-runner");
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(AlRunnerV2RetiredError);
      expect((err as Error).message).toBe(FLAG_TEXT);
    }
  });

  test("al-runner-v3 and bcdev still parse; a typo is still unknown", () => {
    expect(run("al-runner-v3")).toMatchObject({ mode: "run" });
    expect(run("bcdev")).toMatchObject({ mode: "run" });
    expect(dry("al-runner-v3")).toMatchObject({ mode: "dry-run" });
    expect(() => run("nope")).toThrow('unknown --backend "nope"');
    expect(() => run("nope")).not.toThrow(AlRunnerV2RetiredError);
  });
});

describe("R654 F3: a stored v2 run lends nothing, by name", () => {
  const row = (backend: string) => ({ id: 7, backend, runnerBuild: null });

  test("backendBuildRefusal names a v2 run retired, against every session and none", () => {
    for (const session of [
      { backend: "bcdev", runnerBuild: undefined },
      { backend: "al-runner-v3", runnerBuild: "B1" },
      undefined,
    ]) {
      expect(backendBuildRefusal(row("al-runner"), session)).toBe(runText(7));
    }
  });

  test("a bcdev run still lends to a bcdev session, and to no named session", () => {
    expect(backendBuildRefusal(row("bcdev"), { backend: "bcdev", runnerBuild: undefined })).toBe(
      undefined,
    );
    expect(backendBuildRefusal(row("bcdev"), undefined)).toBe(undefined);
  });

  test("history (priorSurvivorKeys): a v2 survivor is refused by name, a bcdev one lends", () => {
    const store = new ResultsStore(":memory:");
    const finished = (backend: string) => {
      const id = store.createRun({
        testScope: [],
        projectPath: "P",
        backend,
        appVersion: "1.0.0.0",
        identityScheme: IDENTITY_SCHEME,
        buildSymbols: [],
        coverageMode: "none",
        testAppHash: "T",
        testAppProven: true,
        testAppDeps: "D",
        carryHidden: { tuples: [], files: [] },
        twinTuples: [],
      });
      store.recordMutant(id, {
        mutantCode: "M0001",
        astHash: "abc123",
        codeunitName: "Sample",
        procedureName: "Post",
        operatorName: "conditional-boundary",
        operatorMajor: 1,
        file: "Sample.Codeunit.al",
        line: 12,
        verdict: "survived",
        durationMs: 40,
        batchIndex: 0,
      });
      store.finishRun(id, { batchCount: 1, baselineGreen: true });
      return id;
    };
    const ask = () => {
      const refused: string[] = [];
      const prior = store.priorSurvivorKeys("P", "none", { hash: "T", deps: "D" }, [], [], [], {
        session: { backend: "bcdev", runnerBuild: undefined },
        backendBuildRefused: (i) => refused.push(i.why),
      });
      return { keys: prior.keys.size, refused };
    };
    const v2 = finished("al-runner");
    expect(ask()).toEqual({ keys: 0, refused: [runText(v2)] });
    finished("bcdev");
    expect(ask()).toEqual({ keys: 1, refused: [] });
    store.close();
  });
});

describe("R654 F3: a v2 SessionReport is refused by name by its readers", () => {
  const giftCard = JSON.parse(
    readFileSync(
      join(
        import.meta.dir,
        "..",
        "..",
        "..",
        "docs",
        "campaign",
        "2026-08-16-gift-card",
        "rehearsal.report.json",
      ),
      "utf8",
    ),
  ) as Record<string, unknown>;

  test("explain refuses a schema-3 report with backend al-runner, and reads the bcdev one", () => {
    expect(giftCard.schemaVersion).toBe(3);
    expect(giftCard.backend).toBe("bcdev");
    expect(() => assertExplainableReport({ ...giftCard, backend: "al-runner" })).toThrow(
      new AlRunnerV2RetiredError(
        "al-runner-v2-retired: the report is a report of the retired .NET al-runner (R654); it is not read",
      ),
    );
    expect(() => assertExplainableReport(giftCard)).not.toThrow();
  });

  test("campaign freeze refuses a v2 report by name, before any other check", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-r654-freeze-"));
    try {
      const path = join(dir, "r.json");
      await writeFile(path, JSON.stringify({ backend: "al-runner", coverageMode: "al-runner" }));
      await expect(freezeStageTo(path, "s", 0, dir)).rejects.toThrow(
        `al-runner-v2-retired: ${path} is a report of the retired .NET al-runner (R654); it is not read`,
      );
      await writeFile(path, JSON.stringify({ backend: "bcdev", coverageMode: "none" }));
      await expect(freezeStageTo(path, "s", 0, dir)).rejects.not.toThrow(/al-runner-v2-retired/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
