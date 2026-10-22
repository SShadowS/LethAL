import { beforeAll, describe, expect, test } from "bun:test";
import { initParser } from "@lethal/engine";
import { assignMutantIds, dedupeSpecs } from "@lethal/schemata";
import {
  NAMES_PROJECT_DIR,
  NAMES_TABLE,
  NAMES_TESTS_CODEUNIT_ID,
  NAMES_TEST_DIR,
  type NamesLegObservations,
  assertNamesRun,
  expectedNamesRows,
} from "../itest/names-fixture";
import { discoverTests } from "../src/discovery";
import { generateMutationSet, operatorTiers, planArtifacts } from "../src/orchestrator";
import type { SessionReport } from "../src/report";

/**
 * R557, offline guard for `fixtures/sandbox-names` and the names legs' checker. The table is
 * pre-committed in docs/superpowers/specs/2026-10-09-r557-names-precommitment.md; this pins that it
 * still describes the fixture (36 mutants in one batch, in table order; twelve tests, in order, each
 * named as in the table and sent under the name the table predicts), so a fixture edit fails here
 * in seconds rather than in a live gate.
 */
beforeAll(async () => {
  await initParser();
});

describe("sandbox-names: the pre-committed table describes the fixture (R557)", () => {
  test("36 mutants, M0001-M0036, one batch, each procedure's empty-block, return-value, swap-additive", async () => {
    const { files } = await generateMutationSet(NAMES_PROJECT_DIR, {});
    expect(planArtifacts(files, {})).toHaveLength(1);
    const deduped = new Map(
      files.map((f) => [f.path, dedupeSpecs(f.specs, (n) => operatorTiers.get(n))]),
    );
    const ided = [...assignMutantIds(deduped).values()].flat();
    const source = files[0]?.source ?? "";
    const got = ided.map((x) => {
      const line = source.slice(0, x.spec.before.startIndex).split("\n").length;
      // Procedure k (0-based) starts on line 3 + 5k (`NamesCalc.Codeunit.al`).
      return {
        code: x.mutantId,
        procedureName: NAMES_TABLE[Math.floor((line - 3) / 5)]?.procedure,
        operatorName: x.spec.operatorName,
      };
    });
    expect(got).toEqual(
      expectedNamesRows("exact").map((r) => ({
        code: r.code,
        procedureName: r.procedureName,
        operatorName: r.operatorName,
      })),
    );
  });

  // R654 S3: the check that each test is SENT under the row name went with the .NET al-runner's
  // `qualifiedTestName`; the rows stay as the table's data.
  test("the twelve tests are discovered in table order", async () => {
    const tests = await discoverTests(NAMES_TEST_DIR);
    expect(tests.map((t) => [t.codeunitId, t.codeunitName, t.method])).toEqual(
      NAMES_TABLE.map((r) => [NAMES_TESTS_CODEUNIT_ID, "Names Tests", r.killer]),
    );
    // Ten renamed, two controls (pre-commitment section B).
    expect(NAMES_TABLE.filter((r) => r.row !== `Codeunit78850.${r.killer}`)).toHaveLength(10);
  });
});

describe("assertNamesRun: the names legs' checker (R557)", () => {
  /** A report shaped as table A predicts, or as master's section B (`bug`). */
  function report(coverage: "exact" | "all", bug = false): SessionReport {
    const rows = expectedNamesRows(coverage);
    const renamedOnly = (code: string) => Number(code.slice(1)) <= 30;
    const mutants = rows.map((r) => {
      const failing = bug && renamedOnly(r.code);
      const text = NAMES_TABLE.find((t) => t.procedure === r.procedureName)?.killText ?? "";
      return {
        mutantCode: r.code,
        file: r.file,
        procedureName: r.procedureName,
        operatorName: r.operatorName,
        verdict: failing ? (coverage === "exact" ? "no-coverage" : "survived") : "killed",
        ...(failing ? {} : { killingTest: r.killingTest, killingTestFailure: text }),
        coveringTests: failing ? [] : r.coveringTests,
      };
    });
    return {
      batches: 1,
      baselineGreen: !bug,
      validity: { caveats: bug ? ["baseline-red"] : [] },
      counts: { killed: 0, survived: 0, noCoverage: 0 },
      mutants,
    } as unknown as SessionReport;
  }

  test("killingTest is the bare AL method, exactly as table A of the pre-commitment writes it", () => {
    // A report names the killer by method only (coveringTests are suite-qualified). The first
    // live run caught the checker expecting "Names Tests.Space Step"; this pins table A's literal.
    const rows = expectedNamesRows("exact");
    expect(rows[0]?.killingTest).toBe("Space Step");
    expect(rows[24]?.killingTest).toBe("Blåbær Step");
    expect(rows[0]?.coveringTests).toEqual(["Names Tests.Space Step"]);
  });

  test("table A passes, under coverage al-runner and none", () => {
    expect(() =>
      assertNamesRun(report("exact"), "t", { coverage: "al-runner", transport: "bcdev" }),
    ).not.toThrow();
    expect(() =>
      assertNamesRun(report("all"), "t", { coverage: "none", transport: "bcdev" }),
    ).not.toThrow();
  });

  test("master's section B fails, naming M0001 and the baseline", () => {
    expect(() =>
      assertNamesRun(report("exact", true), "t", { coverage: "al-runner", transport: "bcdev" }),
    ).toThrow(/baseline must be green[\s\S]*M0001: expected/);
  });

  test("r4: every al-runner leg, one-shot and --server, needs exactly one contract line with the name fact matching", () => {
    const none: NamesLegObservations = { warningCodes: [], contractLines: [] };
    const good: NamesLegObservations = {
      ...none,
      nameFact: "matches",
      contractLines: ["x test-name-mangling=matches y"],
    };
    for (const transport of ["one-shot", "server"] as const) {
      const run = (seen: NamesLegObservations) =>
        assertNamesRun(report("exact"), "t", { coverage: "al-runner", transport, seen });
      expect(() => run(none)).toThrow(/test-name-mangling/);
      expect(() => run({ ...good, contractLines: [] })).toThrow(/exactly one contract line/);
      expect(() =>
        run({ ...good, contractLines: [good.contractLines[0] ?? "", "second"] }),
      ).toThrow(/exactly one contract line/);
      expect(() => run({ ...good, contractLines: ["x test-name-mangling=diverged y"] })).toThrow(
        /exactly one contract line/,
      );
      expect(() => run(good)).not.toThrow();
    }
  });

  test("an al-runner-undecided-test-missing warning fails the leg", () => {
    expect(() =>
      assertNamesRun(report("exact"), "t", {
        coverage: "al-runner",
        transport: "server",
        seen: { warningCodes: ["al-runner-undecided-test-missing"], contractLines: [] },
      }),
    ).toThrow(/undecided/);
  });
});
