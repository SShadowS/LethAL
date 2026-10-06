import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeInstrumentedProject } from "@lethal/schemata";
import {
  ARMS_REFUSAL,
  EXPECTED_WRAPPED,
  PAIR_CODES,
  PAIR_REPLACES,
  WRAPPED_PROJECT_DIR,
  WRAPPED_SELECTOR_IDS,
  WRAPPED_SYMBOLS,
  type WrappedReport,
  assertWrappedRun,
  twinDifferences,
} from "../itest/wrapped-fixture";
import { alRunnerCoverageFrom, buildAlRunnerCoverageIndex } from "../src/al-runner-coverage";
import {
  generateMutationSet,
  identityOrdinalsOf,
  operatorTiers,
  planArtifacts,
  prepareBatchProject,
} from "../src/orchestrator";
import { AL_RUNNER_PREDEFINED_SYMBOLS_V2_12_0 } from "../src/preprocessor-symbols";

/**
 * R-300b, offline guard for `fixtures/sandbox-wrapped`'s PURPOSE and for the live leg's checker.
 * Pre-committed in docs/superpowers/specs/2026-10-06-r300b-wrapped-leg-precommitment.md.
 *
 * The live leg can catch a frame misread only because `Twice`'s lines in the ORIGINAL text lie
 * inside the instrumented `Grow`; this re-derives that from the code, so an emitter change or a
 * shortened header comment fails here in seconds.
 */

const predefined = { symbols: [...AL_RUNNER_PREDEFINED_SYMBOLS_V2_12_0].sort() };

interface Built {
  readonly rows: readonly string[];
  readonly dir: string;
}

async function build(root: string): Promise<Built> {
  const set = await generateMutationSet(WRAPPED_PROJECT_DIR, {
    preprocessorSymbols: WRAPPED_SYMBOLS,
    backend: { kind: "al-runner", predefined },
  });
  const batches = planArtifacts(set.files, {});
  const [batch, ...more] = batches;
  if (batch === undefined || more.length > 0) throw new Error("expected exactly one batch");
  const manifest = JSON.parse(await readFile(join(WRAPPED_PROJECT_DIR, "app.json"), "utf8"));
  const dir = join(root, "batch-0");
  await writeInstrumentedProject({
    targetDir: dir,
    files: batch,
    identityOrdinals: identityOrdinalsOf(set),
    selectorIds: WRAPPED_SELECTOR_IDS,
    artifactId: "0123456789abcdef0123456789abcdef",
    targetAppId: String(manifest.id),
    operatorTiers,
  });
  await prepareBatchProject(WRAPPED_PROJECT_DIR, dir, manifest, "1.0.1.1");
  const written = JSON.parse(await readFile(join(dir, "mutant-manifest.json"), "utf8")) as {
    mutants: {
      mutantId: string;
      file: string;
      startLine: number;
      operatorName: string;
      procedureName: string;
    }[];
  };
  const rows = written.mutants.map(
    (m) => `${m.mutantId} ${m.file} ${m.startLine} ${m.operatorName} ${m.procedureName}`,
  );
  return { rows, dir };
}

describe("R-300b: sandbox-wrapped", () => {
  let root = "";
  let built: Built | undefined;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "lethal-r300b-fixture-"));
    built = await build(root);
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const get = (): Built => {
    if (built === undefined) throw new Error("beforeAll did not build the batch");
    return built;
  };

  it("gives the pre-committed 34 mutants in one batch", () => {
    expect(get().rows).toEqual(
      EXPECTED_WRAPPED.map(
        (r) => `${r.code} ${r.file} ${r.line} ${r.operatorName} ${r.procedureName}`,
      ),
    );
  });

  it("admits WrappedTop, WrappedPre and WrappedPairA; refuses WrappedArms; skips WrappedPairB", async () => {
    const index = await buildAlRunnerCoverageIndex(get().dir, {
      symbols: ["WRAPAPP", ...WRAPPED_SYMBOLS, ...predefined.symbols],
    });
    expect([...index.admittedWrappedFiles].sort()).toEqual([
      "wrappedpaira.codeunit.al",
      "wrappedpre.codeunit.al",
      "wrappedtop.codeunit.al",
    ]);
    expect(index.refusedFiles).toEqual(["WrappedArms.Codeunit.al"]);
    expect(index.skippedFiles).toEqual(["wrappedarms.codeunit.al", "wrappedpairb.codeunit.al"]);
  });

  it("a frame misread moves Twice's original-frame lines into the instrumented Grow", async () => {
    const index = await buildAlRunnerCoverageIndex(get().dir, {
      symbols: ["WRAPAPP", ...WRAPPED_SYMBOLS, ...predefined.symbols],
    });
    const owners = (file: string, lines: number[]) =>
      alRunnerCoverageFrom(
        lines.map((line) => ({ file, line, hits: 1 })),
        index,
      ).entries.map((e) => e.procedure);
    // Twice's original lines: WrappedTop 32-36, WrappedPre 35-36 (the table's Twice rows).
    expect(owners("WrappedTop.Codeunit.al", [32, 34, 36])).toEqual(["Grow", "Grow", "Grow"]);
    expect(owners("WrappedPre.Codeunit.al", [35, 36])).toEqual(["Grow", "Grow"]);
  });
});

/** A report whose rows are exactly `rows`. */
function reportOf(rows: typeof EXPECTED_WRAPPED): WrappedReport {
  return {
    baselineGreen: true,
    batches: 1,
    mutants: rows.map((r) => ({
      mutantCode: r.code,
      file: r.file,
      line: r.line,
      operatorName: r.operatorName,
      procedureName: r.procedureName,
      verdict: r.verdict,
      ...(r.killingTest !== undefined ? { killingTest: r.killingTest } : {}),
      coveringTests: r.coveringTests,
      ...(r.file.endsWith("WrappedArms.Codeunit.al") ? { failureNote: ARMS_REFUSAL } : {}),
    })),
  };
}

describe("R-300b: the wrapped leg's checker", () => {
  const replaced = EXPECTED_WRAPPED.map((r) => PAIR_REPLACES.find((p) => p.code === r.code) ?? r);

  it("passes the table under either reading of --define, and says which", () => {
    expect(assertWrappedRun(reportOf(EXPECTED_WRAPPED), "t", [])).toBe("adds");
    expect(assertWrappedRun(reportOf(replaced), "t", [])).toBe("replaces");
  });

  it("refuses a pair that follows neither reading as a whole", () => {
    const mixed = EXPECTED_WRAPPED.map((r) =>
      r.code === PAIR_CODES[0] ? (PAIR_REPLACES[0] ?? r) : r,
    );
    expect(() => assertWrappedRun(reportOf(mixed), "t", [])).toThrow("follows neither reading");
  });

  it("refuses a wrapped row that differs from its twin, and a position-wins or dropped line", () => {
    const moved = EXPECTED_WRAPPED.map((r) =>
      r.code === "M0024" ? { ...r, verdict: "no-coverage" as const, coveringTests: [] } : r,
    ).map((r) => {
      if (r.code !== "M0024") return r;
      const { killingTest: _k, ...rest } = r;
      return rest;
    });
    expect(twinDifferences(reportOf(moved))).toHaveLength(1);
    expect(() =>
      assertWrappedRun(reportOf(EXPECTED_WRAPPED), "t", ["[lethal] ... the position wins (R383)."]),
    ).toThrow("position-wins");
    expect(() =>
      assertWrappedRun(reportOf(EXPECTED_WRAPPED), "t", ["... the line is dropped (R300)."]),
    ).toThrow("dropped lines");
  });

  it("refuses the two-arm control without its refusal sentence", () => {
    const report = reportOf(EXPECTED_WRAPPED);
    const silent = {
      ...report,
      mutants: report.mutants.map((m) => {
        const { failureNote: _f, ...rest } = m;
        return rest;
      }),
    };
    expect(() => assertWrappedRun(silent, "t", [])).toThrow("not refused by name");
  });
});
