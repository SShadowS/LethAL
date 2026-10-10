import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeInstrumentedProject } from "@lethal/schemata";
import {
  ARMS_REFUSAL,
  EXPECTED_WRAPPED,
  EXPECTED_WRAPPED_BC,
  KILL_TEXTS,
  PAIR_CODES,
  PAIR_REPLACES,
  WRAPPED_PROJECT_DIR,
  WRAPPED_SELECTOR_IDS,
  WRAPPED_SYMBOLS,
  type WrappedReport,
  assertBcWrappedRun,
  assertWrappedRun,
  twinDifferences,
} from "../itest/wrapped-fixture";
import { alRunnerCoverageFrom, buildAlRunnerCoverageIndex } from "../src/al-runner-coverage";
import { buildLineMap } from "../src/line-map";
import {
  generateMutationSet,
  identityOrdinalsOf,
  operatorTiers,
  planArtifacts,
  prepareBatchProject,
} from "../src/orchestrator";
import { effectiveBuildSymbols } from "../src/preprocessor-symbols";
import { AL_RUNNER_PREDEFINED_SYMBOLS_V2_12_0 } from "../src/preprocessor-symbols";
import { removeScratchDir } from "./helpers/scratch";

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
  afterAll(() => {
    removeScratchDir(root);
  });
  const get = (): Built => {
    if (built === undefined) throw new Error("beforeAll did not build the batch");
    return built;
  };

  it("gives the pre-committed 98 mutants in one batch (R-343, R536, R545, R550)", () => {
    expect(get().rows).toEqual(
      EXPECTED_WRAPPED.map(
        (r) => `${r.code} ${r.file} ${r.line} ${r.operatorName} ${r.procedureName}`,
      ),
    );
  });

  it("admits WrappedTop, WrappedPre, WrappedPairA, WrappedTrigger, WrappedView, WrappedXtra and WrappedYBand; refuses WrappedArms; skips WrappedPairB", async () => {
    const index = await buildAlRunnerCoverageIndex(get().dir, {
      symbols: ["WRAPAPP", ...WRAPPED_SYMBOLS, ...predefined.symbols],
    });
    expect([...index.admittedWrappedFiles].sort()).toEqual([
      "wrappedpaira.codeunit.al",
      "wrappedpre.codeunit.al",
      "wrappedtop.codeunit.al",
      "wrappedtrigger.table.al",
      "wrappedview.page.al",
      "wrappedxtra.pageext.al",
      "wrappedyband.report.al",
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
      // R550: a real kill's text, as the backend reports it (the test's Error, then a call stack).
      ...(KILL_TEXTS[r.code] !== undefined
        ? { killingTestFailure: `${KILL_TEXTS[r.code]}\\nWrapped Tests(CodeUnit 78950).X line 1` }
        : {}),
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

  // R343: strict parity, one red-going case per direction.
  it("refuses a twin row with no wrapped partner (the old twin-only swap-additive)", () => {
    const noWrapped = EXPECTED_WRAPPED.filter((r) => r.code !== "M0010");
    expect(twinDifferences(reportOf(noWrapped))).toEqual([
      "M0017 (src/WrappedPreTwin.Codeunit.al) has no wrapped partner",
    ]);
  });

  it("refuses a wrapped row with no twin", () => {
    const noTwin = EXPECTED_WRAPPED.filter((r) => r.code !== "M0032");
    expect(twinDifferences(reportOf(noTwin))).toEqual([
      "M0024 (src/WrappedTop.Codeunit.al) has no twin mutant at Grow|9|lethal.swap-additive",
    ]);
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

/** A bcdev report whose rows are exactly `rows`: no refusal notes. */
function bcReportOf(rows: typeof EXPECTED_WRAPPED): WrappedReport {
  const r = reportOf(rows);
  return {
    ...r,
    mutants: r.mutants.map((m) => {
      const { failureNote: _f, ...rest } = m;
      return rest;
    }),
  };
}

describe("R497: sandbox-wrapped on bcdev (the itest:bcdev-wrapped table, offline)", () => {
  it("a bcdev build gives the pre-committed 98 mutants, and its line map refuses none of them", async () => {
    const root = await mkdtemp(join(tmpdir(), "lethal-r497-fixture-"));
    try {
      const set = await generateMutationSet(WRAPPED_PROJECT_DIR, {
        preprocessorSymbols: WRAPPED_SYMBOLS,
        backend: { kind: "bcdev" },
      });
      const [batch, ...more] = planArtifacts(set.files, {});
      if (batch === undefined || more.length > 0) throw new Error("expected exactly one batch");
      const dir = join(root, "batch-0");
      await writeInstrumentedProject({
        targetDir: dir,
        files: batch,
        identityOrdinals: identityOrdinalsOf(set),
        selectorIds: WRAPPED_SELECTOR_IDS,
        artifactId: "0123456789abcdef0123456789abcdef",
        targetAppId: "4b0f3c1e-8d27-4a52-9e61-3c5d7a9b2f10",
        operatorTiers,
      });
      const written = JSON.parse(await readFile(join(dir, "mutant-manifest.json"), "utf8")) as {
        mutants: { mutantId: string; file: string; startLine: number; operatorName: string }[];
      };
      expect(
        written.mutants.map((m) => `${m.mutantId} ${m.file} ${m.startLine} ${m.operatorName}`),
      ).toEqual(EXPECTED_WRAPPED_BC.map((r) => `${r.code} ${r.file} ${r.line} ${r.operatorName}`));
      // The deployed batch's line map under the bcdev build's symbols: every fixture object is
      // mapped, none refused (A1: WrappedPairB's compiled-out 78905 does not refuse WrappedPairA;
      // R536: the wrapped table and page and their twins; R545: the page extension and its twin;
      // R550: the report and its twin, and the plain table they read).
      const symbols = await effectiveBuildSymbols(WRAPPED_PROJECT_DIR, WRAPPED_SYMBOLS, undefined, {
        kind: "bcdev",
      });
      const declared = new Set([
        ...[78901, 78902, 78903, 78904, 78905, 78906].map((id) => `codeunit:${id}`),
        "table:78907",
        "table:78908",
        "page:78909",
        "page:78910",
        "pageextension:78911",
        "pageextension:78912",
        "report:78913",
        "report:78914",
        // Not "table:78915" (the plain, code-free table the reports read): it carries no site, so
        // it is not in the batch this test writes. A real batch copies it verbatim
        // (`prepareBatchProject`), and the live gate refuses any table refusal by pattern.
      ]);
      const map = await buildLineMap(dir, declared, symbols);
      expect([...map.refusedByKey().keys()].filter((k) => declared.has(k))).toEqual([]);
      // R536: and the new kinds are really mapped (not merely unrefused): each procedure's own
      // line in the instrumented text names it, in the wrapped file and in its twin.
      const lineOf = async (file: string, text: string) =>
        (await readFile(join(dir, file), "utf8")).split("\n").findIndex((l) => l.includes(text)) +
        1;
      for (const [file, type, id, name] of [
        ["WrappedTrigger.Table.al", "Table", 78907, "Doubled"],
        ["WrappedTriggerTwin.Table.al", "Table", 78908, "Doubled"],
        ["WrappedView.Page.al", "Page", 78909, "Label"],
        ["WrappedViewTwin.Page.al", "Page", 78910, "Label"],
        ["WrappedXtra.PageExt.al", "PageExtension", 78911, "Scaled"],
        ["WrappedXtraTwin.PageExt.al", "PageExtension", 78912, "Scaled"],
        ["WrappedYBand.Report.al", "Report", 78913, "Band"],
        ["WrappedYBandTwin.Report.al", "Report", 78914, "Band"],
        ["WrappedYBand.Report.al", "Report", 78913, "GetTotal"],
        ["WrappedYBandTwin.Report.al", "Report", 78914, "GetTotal"],
      ] as const) {
        const at = await lineOf(file, `procedure ${name}(`);
        expect(at).toBeGreaterThan(0);
        expect(map.lookup(type, id, at)).toBe(name);
        // The placement the live table rests on (as `Twice` inside `Grow`): the procedure's
        // ORIGINAL-text lines lie inside the instrumented trigger above it, which names nobody, so a
        // backend reading original lines against the instrumented text would turn the procedure's
        // rows no-coverage. Moving the procedure above its trigger would lose this; this fails then.
        const original = (await readFile(join(WRAPPED_PROJECT_DIR, "src", file), "utf8")).split(
          "\n",
        );
        const origAt = original.findIndex((l) => l.includes(`procedure ${name}(`)) + 1;
        expect(origAt).toBeGreaterThan(0);
        expect(at).toBeGreaterThan(origAt + 3);
        for (const line of [origAt, origAt + 1, origAt + 2])
          expect(map.lookup(type, id, line)).toBeUndefined();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("the checker passes the table, and refuses a WrappedArms refusal or a 78905 refusal", () => {
    expect(() => assertBcWrappedRun(bcReportOf(EXPECTED_WRAPPED_BC), "t", [])).not.toThrow();
    // Direction 1: al-runner's table (WrappedArms refused) is NOT the bcdev table.
    expect(() => assertBcWrappedRun(reportOf(EXPECTED_WRAPPED), "t", [])).toThrow("M0001");
    // Direction 2: a refusal naming the fixture's compiled-out pair key fails the leg.
    expect(() =>
      assertBcWrappedRun(bcReportOf(EXPECTED_WRAPPED_BC), "t", [
        "[lethal] coverage refused for Codeunit:78905 (WrappedPairB.Codeunit.al): ...",
      ]),
    ).toThrow("refusal");
  });

  // R550 (plan review I3): a report-arm kill whose failure is NOT the test's own Error (here a
  // duplicate key, as a left-over seed would give) matches the verdict table, so only the pinned
  // text catches it; and a report refusal warning is caught by the pattern.
  it("the checker refuses a report kill for another reason, and a report refusal warning", () => {
    const duplicateKey = (r: WrappedReport): WrappedReport => ({
      ...r,
      mutants: r.mutants.map((m) =>
        m.mutantCode === "M0071"
          ? { ...m, killingTestFailure: "The record in table Wrapped Band Row already exists." }
          : m,
      ),
    });
    const report = bcReportOf(EXPECTED_WRAPPED_BC);
    expect(() => assertBcWrappedRun(duplicateKey(report), "t", [])).toThrow(
      "M0071: killingTestFailure",
    );
    expect(() => assertWrappedRun(duplicateKey(reportOf(EXPECTED_WRAPPED)), "t", [])).toThrow(
      "M0071: killingTestFailure",
    );
    expect(() =>
      assertBcWrappedRun(report, "t", [
        "[lethal] coverage refused for Report:78913 (WrappedYBand.Report.al): ...",
      ]),
    ).toThrow("refusal");
  });
});
