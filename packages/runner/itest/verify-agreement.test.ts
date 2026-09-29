import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { MutantOutcome, SessionReport } from "../src/report";
import type { VerifyResult } from "../src/verify";
import {
  AgreementJoinError,
  SCRATCH_ANSWERS,
  assertFreshFullRun,
  compareVerifyToFullRun,
  writeScratchSuite,
} from "./verify-agreement";

// Hand-built reports (C02-08 Task 1). Every mutant carries every field `keyOf` reads, so the join
// runs on the real identity key and never on a mutant code.

const MARK = { key: "harden-mark", reason: "equivalent by construction" };

/** An override set to `undefined` REMOVES that field, so a test can take a killer or a mark away. */
type Overrides = { [K in keyof MutantOutcome]?: MutantOutcome[K] | undefined };

function mutant(overrides: Overrides & { mutantCode: string }): MutantOutcome {
  const row: Record<string, unknown> = {
    file: "src\\HardenLogic.Codeunit.al",
    line: 10,
    operatorName: "lethal.empty-block",
    verdict: "survived",
    batchIndex: 0,
    durationMs: 1,
    procedureName: "Proc",
    startIndex: 0,
    endIndex: 1,
    originalText: "",
    mutatedText: "",
    coveringTests: [],
    runner: "fenced",
    astHash: "hash",
    codeunitName: "Harden Logic",
    operatorMajor: 1,
    ...overrides,
  };
  for (const k of Object.keys(row)) if (row[k] === undefined) delete row[k];
  return row as unknown as MutantOutcome;
}

interface Extra {
  /** The mutants the mark matched: a bare code (batch 0) or an R231 `<batchIndex>/<mutantCode>`. */
  readonly matched?: readonly string[];
  readonly stale?: readonly string[];
  readonly resumedFrom?: { runId: number; carriedMutants: number };
  readonly caveats?: readonly string[];
}

function report(mutants: readonly MutantOutcome[], extra: Extra = {}): SessionReport {
  return {
    mutants,
    batches: 1,
    validity: { caveats: extra.caveats ?? [] },
    ...(extra.resumedFrom !== undefined ? { resumedFrom: extra.resumedFrom } : {}),
    readerMarkedEquivalent: {
      matched: (extra.matched ?? []).map((ref) => {
        const [batch, code] = ref.includes("/") ? ref.split("/") : ["0", ref];
        return { batchIndex: Number(batch), mutantCode: code, key: MARK.key, reason: MARK.reason };
      }),
      stale: extra.stale ?? [],
      contradicted: [],
    },
  } as unknown as SessionReport;
}

/** S<n>'s site: distinct hash, procedure and line per planted survivor. */
function site(n: number) {
  return { astHash: `h${n}`, procedureName: `P${n}`, line: 10 * n, operatorName: `lethal.op${n}` };
}

// A: the source run. S1..S4 survived, S5 survived with the reader mark.
const A_MUTANTS = [1, 2, 3, 4, 5].map((n) =>
  mutant({ mutantCode: `M000${n}`, ...site(n), ...(n === 5 ? { readerMark: MARK } : {}) }),
);
const A = report(A_MUTANTS, { matched: ["M0005"] });

// B: the fresh full run. Same keys, DIFFERENT codes in another order, so a code join finds nothing.
const B_CODE: Record<number, string> = {
  1: "M0013",
  2: "M0015",
  3: "M0011",
  4: "M0014",
  5: "M0012",
};
function bMutant(n: number, overrides: Overrides = {}): MutantOutcome {
  const base: Omit<Overrides, "mutantCode"> =
    n === 5
      ? { verdict: "survived", readerMark: MARK }
      : { verdict: "killed", killingTest: `K${n}` };
  return mutant({
    ...site(n),
    ...base,
    ...overrides,
    mutantCode: overrides.mutantCode ?? B_CODE[n] ?? "",
  });
}
function bMutants(replace: Record<number, MutantOutcome | null> = {}): MutantOutcome[] {
  const out: MutantOutcome[] = [];
  for (const n of [3, 5, 1, 4, 2]) {
    const r = replace[n];
    if (r === null) continue;
    out.push(r ?? bMutant(n));
  }
  return out;
}
const B = report(bMutants(), { matched: ["M0012"] });

function vrow(n: number, overrides: Partial<VerifyResult> = {}): VerifyResult {
  const s = A_MUTANTS[n - 1];
  if (s === undefined) throw new Error(`no S${n}`);
  const base: VerifyResult = {
    id: `0/${s.mutantCode}`,
    batchIndex: 0,
    mutantCode: s.mutantCode,
    file: s.file,
    line: s.line,
    operatorName: s.operatorName,
    procedureName: s.procedureName,
    verdict: "killed",
    killingTest: { codeunitId: 79550, codeunitName: "Harden Tests", method: `K${n}` },
  };
  if (n === 5) {
    const { killingTest: _k, ...rest } = base;
    return {
      ...rest,
      verdict: "skipped",
      skipped: { reason: "reader-marked-equivalent", mark: MARK },
      ...overrides,
    };
  }
  return { ...base, ...overrides };
}
const OUT = { results: [1, 2, 3, 4, 5].map((n) => vrow(n)) };

function agreeOf(rows: ReturnType<typeof compareVerifyToFullRun>["rows"]): Record<string, boolean> {
  return Object.fromEntries(rows.map((r) => [r.id, r.agree]));
}

describe("C02-08: compareVerifyToFullRun", () => {
  test("agrees on the base scene: five rows, all agree, zero diffs, with B's codes renumbered", () => {
    const { rows, diffs } = compareVerifyToFullRun(OUT, A, B);
    expect(diffs).toEqual([]);
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.agree)).toBe(true);
  });

  test("a trigger row (empty procedureName, triggerName set) joins and agrees, as verify reports it", () => {
    const trig = {
      astHash: "ht",
      procedureName: "",
      triggerName: "OnInsert",
      line: 99,
      operatorName: "lethal.opT",
    };
    const a = report([mutant({ mutantCode: "M0001", ...trig })]);
    const b = report([mutant({ mutantCode: "M0021", ...trig })]);
    const out = {
      results: [
        {
          id: "0/M0001",
          batchIndex: 0,
          mutantCode: "M0001",
          file: "src\\HardenLogic.Codeunit.al",
          line: 99,
          operatorName: "lethal.opT",
          procedureName: "",
          verdict: "survived",
        } satisfies VerifyResult,
      ],
    };
    const { rows, diffs } = compareVerifyToFullRun(out, a, b);
    expect(diffs).toEqual([]);
    expect(rows[0]?.agree).toBe(true);
    expect(rows[0]?.key).toBe("ht|Harden Logic|OnInsert|lethal.opT|1");
  });

  test("(a) a killed row whose full-run mutant survived is one diff naming its id; that row agree false", () => {
    const b = report(bMutants({ 1: bMutant(1, { verdict: "survived", killingTest: undefined }) }), {
      matched: ["M0012"],
    });
    const { rows, diffs } = compareVerifyToFullRun(OUT, A, b);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toContain("0/M0001");
    expect(agreeOf(rows)).toEqual({
      "0/M0001": false,
      "0/M0002": true,
      "0/M0003": true,
      "0/M0004": true,
      "0/M0005": true,
    });
  });

  test("(b) a killed row whose full-run killer differs by method is one diff; agree false", () => {
    const b = report(bMutants({ 2: bMutant(2, { killingTest: "K9" }) }), { matched: ["M0012"] });
    const { rows, diffs } = compareVerifyToFullRun(OUT, A, b);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toContain("0/M0002");
    expect(diffs[0]).toContain("by K9");
    expect(agreeOf(rows)["0/M0002"]).toBe(false);
    expect(rows.filter((r) => !r.agree)).toHaveLength(1);
  });

  test("(c) a skipped row whose full-run mutant was killed is one diff (a contradicted mark); agree false", () => {
    const b = report(
      bMutants({ 5: bMutant(5, { verdict: "killed", killingTest: "K5", readerMark: undefined }) }),
    );
    const { rows, diffs } = compareVerifyToFullRun(OUT, A, b);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toContain("0/M0005");
    expect(agreeOf(rows)["0/M0005"]).toBe(false);
    expect(rows.filter((r) => !r.agree)).toHaveLength(1);
  });

  test("(d) a skipped row whose full-run mutant carries no readerMark, or another key, or is absent from matched (that variant keeps the per-row readerMark), is one diff each; agree false", () => {
    const variants: SessionReport[] = [
      report(bMutants({ 5: bMutant(5, { readerMark: undefined }) }), { matched: ["M0012"] }),
      report(bMutants({ 5: bMutant(5, { readerMark: { key: "other-key", reason: "r" } }) }), {
        matched: ["M0012"],
      }),
      report(bMutants(), { matched: [] }),
    ];
    for (const b of variants) {
      const { rows, diffs } = compareVerifyToFullRun(OUT, A, b);
      expect(diffs).toHaveLength(1);
      expect(diffs[0]).toContain("0/M0005");
      expect(agreeOf(rows)["0/M0005"]).toBe(false);
      expect(rows.filter((r) => !r.agree)).toHaveLength(1);
    }
  });

  test("(e) an empty verify result throws AgreementJoinError", () => {
    expect(() => compareVerifyToFullRun({ results: [] }, A, B)).toThrow(AgreementJoinError);
  });

  test("(f) a verify id not in the source report, or in it twice, throws", () => {
    const stray = { results: [vrow(1, { id: "0/M0099", mutantCode: "M0099" })] };
    expect(() => compareVerifyToFullRun(stray, A, B)).toThrow(AgreementJoinError);
    const [s1] = A_MUTANTS;
    if (s1 === undefined) throw new Error("no S1");
    const twice = report([...A_MUTANTS, s1], { matched: ["M0005"] });
    expect(() => compareVerifyToFullRun(OUT, twice, B)).toThrow(AgreementJoinError);
  });

  test("(g) a key missing from the full run, or present twice, is one diff naming the key; agree false", () => {
    const missing = compareVerifyToFullRun(
      OUT,
      A,
      report(bMutants({ 3: null }), { matched: ["M0012"] }),
    );
    expect(missing.diffs).toHaveLength(1);
    expect(missing.diffs[0]).toContain("h3|Harden Logic|P3|lethal.op3|1");
    expect(missing.diffs[0]).toContain("missing");
    expect(agreeOf(missing.rows)["0/M0003"]).toBe(false);
    expect(missing.rows.filter((r) => !r.agree)).toHaveLength(1);

    const twice = compareVerifyToFullRun(
      OUT,
      A,
      report([...bMutants(), bMutant(3, { mutantCode: "M0019" })], { matched: ["M0012"] }),
    );
    expect(twice.diffs).toHaveLength(1);
    expect(twice.diffs[0]).toContain("h3|Harden Logic|P3|lethal.op3|1");
    expect(twice.diffs[0]).toContain("ambiguous(2)");
    expect(agreeOf(twice.rows)["0/M0003"]).toBe(false);
    expect(twice.rows.filter((r) => !r.agree)).toHaveLength(1);
  });

  test("(i) an error row never agrees, even with a full-run error", () => {
    const out = { results: [vrow(1, { verdict: "error" })] };
    const b = report([bMutant(1, { verdict: "error", killingTest: undefined })]);
    const { rows, diffs } = compareVerifyToFullRun(out, A, b);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toContain("0/M0001");
    expect(rows[0]?.agree).toBe(false);
  });

  test("(j) a verify row whose file, line, operator or procedure differs from its source mutant is one diff AND row.agree is false, even though its B verdict would agree", () => {
    const skews: Partial<VerifyResult>[] = [
      { file: "src\\Other.Codeunit.al" },
      { line: 11 },
      { operatorName: "lethal.other" },
      { procedureName: "OtherProc" },
    ];
    for (const skew of skews) {
      const out = { results: [vrow(1, skew), vrow(2)] };
      const { rows, diffs } = compareVerifyToFullRun(out, A, B);
      expect(diffs).toHaveLength(1);
      expect(diffs[0]).toContain("0/M0001");
      expect(agreeOf(rows)).toEqual({ "0/M0001": false, "0/M0002": true });
    }
  });

  test("(k) the negative control: the base scene against A itself gives exactly four diffs, each naming one S1..S4 id and reading 'verify killed by K<n>, full run survived'; S1..S4 agree false, S5 agree true", () => {
    const { rows, diffs } = compareVerifyToFullRun(OUT, A, A);
    expect(diffs).toHaveLength(4);
    for (const n of [1, 2, 3, 4]) {
      const hits = diffs.filter((d) => d.includes(`0/M000${n}`));
      expect(hits).toHaveLength(1);
      expect(hits[0]).toContain(`verify killed by K${n}, full run survived`);
    }
    expect(agreeOf(rows)).toEqual({
      "0/M0001": false,
      "0/M0002": false,
      "0/M0003": false,
      "0/M0004": false,
      "0/M0005": true,
    });
  });

  test("(l) renumbered codes: A's M0003 is B's M0011 and B's M0003 is a different mutant; the join follows the key, never the code", () => {
    const decoy = mutant({
      mutantCode: "M0003",
      astHash: "decoy",
      procedureName: "Decoy",
      verdict: "survived",
    });
    const b = report([...bMutants(), decoy], { matched: ["M0012"] });
    const { rows, diffs } = compareVerifyToFullRun(OUT, A, b);
    expect(diffs).toEqual([]);
    expect(rows.every((r) => r.agree)).toBe(true);
    expect(rows.find((r) => r.id === "0/M0003")?.full).toBe("killed");
  });

  test("(m) same astHash in two procedures: A's S1 and a B mutant with the same astHash and operator in ANOTHER procedure do not join; only the same-procedure one does", () => {
    const elsewhere = bMutant(1, {
      mutantCode: "M0030",
      procedureName: "Elsewhere",
      verdict: "survived",
      killingTest: undefined,
    });
    const b = report([...bMutants(), elsewhere], { matched: ["M0012"] });
    const { rows, diffs } = compareVerifyToFullRun(OUT, A, b);
    expect(diffs).toEqual([]);
    expect(agreeOf(rows)["0/M0001"]).toBe(true);
    expect(rows.find((r) => r.id === "0/M0001")?.full).toBe("killed");
  });

  test("(n) ordinal twins: two byte-identical mutants in one procedure (identityOrdinal 0 and 1) with different B verdicts each join to their own twin", () => {
    const twin = { astHash: "ht", procedureName: "Twin", line: 50, operatorName: "lethal.opT" };
    const a = report([
      mutant({ mutantCode: "M0001", ...twin }),
      mutant({ mutantCode: "M0002", ...twin, line: 51, identityOrdinal: 1 }),
    ]);
    const b = report([
      mutant({ mutantCode: "M0022", ...twin, line: 51, identityOrdinal: 1, verdict: "survived" }),
      mutant({ mutantCode: "M0021", ...twin, verdict: "killed", killingTest: "K7" }),
    ]);
    const base = {
      batchIndex: 0,
      file: "src\\HardenLogic.Codeunit.al",
      operatorName: "lethal.opT",
      procedureName: "Twin",
    };
    const out = {
      results: [
        {
          ...base,
          id: "0/M0001",
          mutantCode: "M0001",
          line: 50,
          verdict: "killed",
          killingTest: { codeunitId: 1, codeunitName: "T", method: "K7" },
        },
        { ...base, id: "0/M0002", mutantCode: "M0002", line: 51, verdict: "survived" },
      ] satisfies VerifyResult[],
    };
    const { rows, diffs } = compareVerifyToFullRun(out, a, b);
    expect(diffs).toEqual([]);
    expect(agreeOf(rows)).toEqual({ "0/M0001": true, "0/M0002": true });
  });

  test("(o) tampered B killer: B's S2 killed by a base-suite method is one diff", () => {
    const b = report(bMutants({ 2: bMutant(2, { killingTest: "BaseSuiteTest" }) }), {
      matched: ["M0012"],
    });
    const { rows, diffs } = compareVerifyToFullRun(OUT, A, b);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toContain("0/M0002");
    expect(agreeOf(rows)["0/M0002"]).toBe(false);
    expect(rows.filter((r) => !r.agree)).toHaveLength(1);
  });

  test("(p) tampered B mark: B's S5 survived but readerMarkedEquivalent lists it under stale, not matched, is one diff", () => {
    // Deliberately inconsistent: S5 KEEPS its per-row readerMark and leaves ONLY `matched`, so the
    // row-mark condition cannot carry this case.
    const b = report(bMutants(), { matched: [], stale: [MARK.key] });
    const { rows, diffs } = compareVerifyToFullRun(OUT, A, b);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toContain("0/M0005");
    expect(agreeOf(rows)["0/M0005"]).toBe(false);
    expect(rows.filter((r) => !r.agree)).toHaveLength(1);
  });
});

describe("R231: the skipped-row join matches batchIndex, not only the code", () => {
  test("(q) matched names ANOTHER batch's M0012 with the same key: one diff; agree false", () => {
    // Mutant ids restart per batch. B's S5 is batch 1's M0012; the list names batch 0's M0012. A
    // join by code alone would read that as this survivor's mark.
    const b = report(bMutants({ 5: bMutant(5, { batchIndex: 1 }) }), { matched: ["0/M0012"] });
    const { rows, diffs } = compareVerifyToFullRun(OUT, A, b);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toContain("0/M0005");
    expect(agreeOf(rows)["0/M0005"]).toBe(false);
    // The control: the same list naming batch 1 agrees.
    const ok = report(bMutants({ 5: bMutant(5, { batchIndex: 1 }) }), { matched: ["1/M0012"] });
    expect(compareVerifyToFullRun(OUT, A, ok).diffs).toEqual([]);
  });
});

describe("C02-08: writeScratchSuite", () => {
  const TESTS_DIR = resolve(import.meta.dir, "../../../fixtures/sandbox-harden-tests");
  const ANSWERS_FILE = resolve(
    import.meta.dir,
    "../../../fixtures/sandbox-harden-answers/src/HardenAnswerKey.Codeunit.al",
  );
  const BASE_METHODS = [
    "IsLargeSeparatesSmallFromLarge",
    "CountInCategoryCountsRows",
    "FirstAmountReadsARow",
    "SetAmountStoresTheAmount",
    "AmountValidateDoublesIt",
    "BonusForPaysOnlyAboveTen",
  ];
  const ANSWER_METHODS = [
    "IsLargeAtTheBoundary",
    "CountInCategoryIgnoresOtherCategories",
    "FirstAmountReadsTheFirstRow",
    "SetAmountRunsValidation",
    "BonusForTwiceOnOneInstance",
  ];

  test("C02-08: the scratch suite holds the six base tests and the five answer tests, all names unique", async () => {
    const dest = await mkdtemp(join(tmpdir(), "lethal-scratch-suite-"));
    try {
      const refs = await writeScratchSuite(TESTS_DIR, ANSWERS_FILE, dest);
      expect(refs).toHaveLength(11);
      expect(new Set(refs.map((r) => r.method)).size).toBe(11);

      const answerRefs = refs.filter((r) => r.codeunitId === SCRATCH_ANSWERS.codeunitId);
      expect(answerRefs).toHaveLength(5);
      expect(answerRefs.every((r) => r.codeunitName === SCRATCH_ANSWERS.codeunitName)).toBe(true);
      expect(new Set(answerRefs.map((r) => r.method))).toEqual(new Set(ANSWER_METHODS));

      const baseRefs = refs.filter((r) => r.codeunitId !== SCRATCH_ANSWERS.codeunitId);
      expect(new Set(baseRefs.map((r) => r.method))).toEqual(new Set(BASE_METHODS));

      const [destAppJson, srcAppJson] = await Promise.all([
        readFile(join(dest, "app.json")),
        readFile(join(TESTS_DIR, "app.json")),
      ]);
      expect(destAppJson.equals(srcAppJson)).toBe(true);
    } finally {
      await rm(dest, { recursive: true, force: true });
    }
  });

  test("C02-08: a duplicate method name across codeunits throws", async () => {
    const dest = await mkdtemp(join(tmpdir(), "lethal-scratch-suite-dup-"));
    const scratchAnswers = await mkdtemp(join(tmpdir(), "lethal-scratch-answers-dup-"));
    try {
      const original = await readFile(ANSWERS_FILE, "utf8");
      // The answers file ALSO declares a base-suite method name, as an agent adding a test could.
      const tampered = original.replace(
        "    local procedure InsertEntry",
        "    [Test]\n    procedure IsLargeSeparatesSmallFromLarge()\n    begin\n    end;\n\n    local procedure InsertEntry",
      );
      expect(tampered).not.toBe(original);
      const tamperedFile = join(scratchAnswers, "HardenAnswerKey.Codeunit.al");
      await writeFile(tamperedFile, tampered, "utf8");
      await expect(writeScratchSuite(TESTS_DIR, tamperedFile, dest)).rejects.toThrow();
    } finally {
      await rm(dest, { recursive: true, force: true });
      await rm(scratchAnswers, { recursive: true, force: true });
    }
  });

  test("C02-08: a missing header throws", async () => {
    const dest = await mkdtemp(join(tmpdir(), "lethal-scratch-suite-noheader-"));
    const scratchAnswers = await mkdtemp(join(tmpdir(), "lethal-scratch-answers-noheader-"));
    try {
      const original = await readFile(ANSWERS_FILE, "utf8");
      const tampered = original.replace(
        'codeunit 79575 "Harden Answer Key"',
        'codeunit 79580 "Harden Answer Key"',
      );
      expect(tampered).not.toBe(original);
      const tamperedFile = join(scratchAnswers, "HardenAnswerKey.Codeunit.al");
      await writeFile(tamperedFile, tampered, "utf8");
      await expect(writeScratchSuite(TESTS_DIR, tamperedFile, dest)).rejects.toThrow();
    } finally {
      await rm(dest, { recursive: true, force: true });
      await rm(scratchAnswers, { recursive: true, force: true });
    }
  });
});

describe("C02-08: assertFreshFullRun", () => {
  test("(h1) a carried mutant throws", () => {
    const b = report(bMutants({ 1: bMutant(1, { carried: true }) }), { matched: ["M0012"] });
    expect(() => assertFreshFullRun(b)).toThrow(AgreementJoinError);
  });

  test("(h2) a 'resumed' entry in validity.caveats throws", () => {
    const b = report(bMutants(), { matched: ["M0012"], caveats: ["resumed"] });
    expect(() => assertFreshFullRun(b)).toThrow(AgreementJoinError);
  });

  test("(h3) a resumedFrom with ZERO carried mutants and no caveat throws", () => {
    const b = report(bMutants(), {
      matched: ["M0012"],
      resumedFrom: { runId: 7, carriedMutants: 0 },
    });
    expect(() => assertFreshFullRun(b)).toThrow(AgreementJoinError);
  });

  test("(h4) a clean report passes", () => {
    expect(() => assertFreshFullRun(B)).not.toThrow();
  });
});
