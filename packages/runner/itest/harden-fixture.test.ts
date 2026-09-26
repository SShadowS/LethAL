import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { tier1Operators } from "@lethal/builtin-tier1";
import { tier2Operators } from "@lethal/builtin-tier2";
import { type MutantManifest, writeInstrumentedProject } from "@lethal/schemata";
import { parseEquivalenceMarks } from "../src/equivalence-marks";
import { generateMutationSet, operatorTiers } from "../src/orchestrator";
import type { MutantOutcome, SessionReport } from "../src/report";
import { identityKeyOf, serializeKey } from "../src/selection";
import {
  ANSWER_KILLERS,
  EXPECTED,
  type ExpectedMutant,
  HardenGateError,
  assertHardenAnswers,
  assertHardenMarks,
  assertHardenVerdicts,
  siteOf,
} from "./harden-expected";

const PROJECT_DIR = resolve(import.meta.dir, "../../../fixtures/sandbox-harden");

/** The deployed (post-dedup) manifest, built the way `runSession`'s `prepareArtifactDir` builds it. */
async function manifest(): Promise<MutantManifest> {
  const set = await generateMutationSet(PROJECT_DIR);
  const appJson = JSON.parse(await readFile(join(PROJECT_DIR, "app.json"), "utf8")) as {
    id: string;
  };
  const dir = await mkdtemp(join(tmpdir(), "lethal-harden-"));
  try {
    await writeInstrumentedProject({
      targetDir: dir,
      files: set.files,
      selectorIds: { selectorId: 79547, controlId: 79548, tableId: 79549 },
      artifactId: "0123456789abcdef0123456789abcdef",
      targetAppId: appJson.id,
      operatorTiers,
    });
    return JSON.parse(await readFile(join(dir, "mutant-manifest.json"), "utf8")) as MutantManifest;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const sorted = (xs: readonly string[]): string[] => [...xs].sort();
const planted = (p: string): ExpectedMutant => {
  const row = EXPECTED.find((r) => r.planted === p);
  if (row === undefined) throw new Error(`no ${p} row`);
  return row;
};

/** A report the three checks must accept: EXPECTED as a live run would report it. */
function reportFrom(rows: readonly ExpectedMutant[]): SessionReport {
  const mutants: MutantOutcome[] = rows.map(
    (r, i) =>
      ({
        mutantCode: `M${String(i + 1).padStart(4, "0")}`,
        file: r.file.replaceAll("/", "\\"),
        line: r.line,
        operatorName: r.operator,
        verdict: r.verdict,
        batchIndex: 0,
        procedureName: r.scope,
        ...(r.killingTest !== undefined ? { killingTest: r.killingTest } : {}),
      }) as unknown as MutantOutcome,
  );
  return withCounts({ mutants } as unknown as SessionReport, planted("S5"));
}

function withCounts(report: SessionReport, s5: ExpectedMutant): SessionReport {
  const s5m = report.mutants.find(
    (m) => siteOf(m.file, m.line, m.operatorName) === siteOf(s5.file, s5.line, s5.operator),
  );
  const count = (v: string): number => report.mutants.filter((m) => m.verdict === v).length;
  return {
    ...report,
    counts: {
      killed: count("killed"),
      survived: count("survived"),
      noCoverage: count("no-coverage"),
      timeoutKilled: 0,
      knownSurvivors: 0,
      unstable: 0,
      errors: 0,
      deadlineExceeded: 0,
    },
    likelyEquivalentSurvivors: {
      count: 1,
      byRisk: [{ risk: "value-rewrite", mutants: [s5m?.mutantCode ?? ""], meaning: "m" }],
    },
    readerMarkedEquivalent: {
      matched: [{ mutantCode: s5m?.mutantCode ?? "", key: "k", reason: "r" }],
      stale: [],
      contradicted: [],
    },
  } as SessionReport;
}

describe("C02-03: sandbox-harden's mutant set is exactly the pre-committed one", () => {
  test("C02-03: the deployed mutant set equals the pre-committed table", async () => {
    const m = await manifest();
    expect(sorted(m.mutants.map((e) => siteOf(e.file, e.startLine, e.operatorName)))).toEqual(
      sorted(EXPECTED.map((r) => siteOf(r.file, r.line, r.operator))),
    );
  });

  test("C02-03: the committed mark names exactly the planted equivalent", async () => {
    const marks = parseEquivalenceMarks(
      await readFile(join(PROJECT_DIR, "lethal.equivalent.json"), "utf8"),
      "lethal.equivalent.json",
    );
    const m = await manifest();
    const s5 = planted("S5");
    const s5Entries = m.mutants.filter(
      (e) => siteOf(e.file, e.startLine, e.operatorName) === siteOf(s5.file, s5.line, s5.operator),
    );
    // Printed so the mark can be written from the helper's output, never typed by hand.
    const s5Keys = s5Entries.map((e) => serializeKey(identityKeyOf(e)));
    expect(marks.length, `S5's key: ${JSON.stringify(s5Keys)}`).toBe(1);
    const [mark] = marks;
    if (mark === undefined) throw new Error("no mark");
    expect(mark.reason.trim().length).toBeGreaterThan(0);
    const hits = m.mutants.filter((e) => serializeKey(identityKeyOf(e)) === mark.key);
    expect(
      hits.map((e) => siteOf(e.file, e.startLine, e.operatorName)),
      `S5's key: ${JSON.stringify(s5Keys)}`,
    ).toEqual([siteOf(s5.file, s5.line, s5.operator)]);
    const [hit] = hits;
    if (hit === undefined) throw new Error("no hit");
    expect(hit.identityOrdinal ?? 0).toBe(0);
    expect(hit.triggerName).toBeUndefined();
    expect(hit.procedureName).toBe(s5.scope);
  });

  test("C02-03: only the planted equivalent's operator declares an equivalence risk", () => {
    const registry = new Map([...tier1Operators, ...tier2Operators].map((o) => [o.name, o]));
    for (const row of EXPECTED.filter((r) => r.planted !== undefined)) {
      const op = registry.get(row.operator);
      if (op === undefined) throw new Error(`${row.operator} is not registered`);
      expect(op.equivalenceRisk, `${row.planted} ${row.operator}`).toBe(
        row.planted === "S5" ? "value-rewrite" : undefined,
      );
    }
  });

  test("C02-03: every killed row names a killer and every survivor is planted", () => {
    for (const row of EXPECTED) {
      if (row.verdict === "killed") {
        expect(row.killingTest, siteOf(row.file, row.line, row.operator)).toBeString();
        expect(row.planted).toBeUndefined();
      } else {
        expect(row.planted, siteOf(row.file, row.line, row.operator)).toBeDefined();
        expect(row.killingTest).toBeUndefined();
      }
    }
    expect(sorted(EXPECTED.flatMap((r) => (r.planted !== undefined ? [r.planted] : [])))).toEqual([
      "S1",
      "S2",
      "S3",
      "S4",
      "S5",
    ]);
  });

  test("C02-03: the gate checks refuse a wrong report", () => {
    const good = reportFrom(EXPECTED);
    assertHardenVerdicts(good);
    assertHardenMarks(good);

    // Empty-versus-empty must not pass.
    const empty = withCounts({ mutants: [] } as unknown as SessionReport, planted("S5"));
    expect(() => assertHardenVerdicts(empty)).toThrow(HardenGateError);
    expect(() => assertHardenMarks(empty)).toThrow(HardenGateError);
    expect(() => assertHardenAnswers(empty)).toThrow(HardenGateError);

    const killedRow = EXPECTED.find((r) => r.verdict === "killed");
    if (killedRow === undefined) throw new Error("no killed row");
    const wrongKiller = reportFrom(
      EXPECTED.map((r) => (r === killedRow ? { ...r, killingTest: "SomeOtherTest" } : r)),
    );
    expect(() => assertHardenVerdicts(wrongKiller)).toThrow(
      `${siteOf(killedRow.file, killedRow.line, killedRow.operator)} (${killedRow.scope}): killed by SomeOtherTest`,
    );

    const extra: ExpectedMutant = {
      file: "src/HardenLogic.Codeunit.al",
      line: 99,
      operator: "lethal.empty-block",
      scope: "X",
      verdict: "survived",
    };
    expect(() => assertHardenVerdicts(reportFrom([...EXPECTED, extra]))).toThrow(
      "a mutant the table does not predict",
    );

    const noCov = reportFrom(EXPECTED);
    const noCovReport = {
      ...noCov,
      mutants: [
        ...noCov.mutants,
        { ...noCov.mutants[0], line: 98, verdict: "no-coverage" } as MutantOutcome,
      ],
      counts: { ...noCov.counts, noCoverage: 1 },
    } as SessionReport;
    expect(() => assertHardenVerdicts(noCovReport)).toThrow("no-coverage");

    const twoLikely = {
      ...good,
      likelyEquivalentSurvivors: {
        count: 2,
        byRisk: [{ risk: "value-rewrite", mutants: ["M0001", "M0016"], meaning: "m" }],
      },
    } as SessionReport;
    expect(() => assertHardenVerdicts(twoLikely)).toThrow("likelyEquivalentSurvivors");

    const { readerMarkedEquivalent: _dropped, ...noMarks } = good;
    expect(() => assertHardenMarks(noMarks as SessionReport)).toThrow("readerMarkedEquivalent");

    const answers = reportFrom(
      EXPECTED.map((r) => {
        if (r.planted === undefined || r.planted === "S5") return r;
        return { ...r, verdict: "killed" as const, killingTest: ANSWER_KILLERS[r.planted] };
      }),
    );
    assertHardenAnswers(answers);
    const s3Survives = reportFrom(
      EXPECTED.map((r) => {
        if (r.planted === undefined || r.planted === "S5" || r.planted === "S3") return r;
        return { ...r, verdict: "killed" as const, killingTest: ANSWER_KILLERS[r.planted] };
      }),
    );
    expect(() => assertHardenAnswers(s3Survives)).toThrow("S3");
  });
});
