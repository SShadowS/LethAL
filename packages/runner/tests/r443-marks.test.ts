import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import { type IdentityEntry, identitySiteKey, numberIdentityOrdinals } from "@lethal/schemata";
import type { CompiledArtifact } from "../src/artifact";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import {
  type EquivalenceMark,
  applyEquivalenceMarks,
  parseEquivalenceMarks,
} from "../src/equivalence-marks";
import type { RunEvent } from "../src/events";
import { explain } from "../src/explain";
import type { LineRange } from "../src/line-filter";
import { runSession } from "../src/orchestrator";
import {
  type SessionReport,
  buildReport,
  markIdentityOf,
  markTupleOfRow,
  renderConsole,
} from "../src/report";
import { numberingDigestOf, serializeKey, twinSiteOf } from "../src/selection";
import { ResultsStore } from "../src/store";

/**
 * R443 (widened under R-443): an equivalence mark names its mutant by identity key alone, and a key
 * carries a run-wide twin ordinal (R193, R374). Any renumbering between the run a reader marked
 * from and a later run hands the key to ANOTHER twin, and the mark then hides that twin's survival
 * as "reader-marked equivalent" although nobody looked at it. R-391 closed the same hole for
 * carried verdicts; these are the mark sequences:
 *   1. cross-file: the marked twin's file edits its twin away, and another file's twin inherits the key;
 *   2. same-file: the marked twin is deleted, and the next twin in the file inherits the key;
 *   3. R443's own: a header-refused file reserved no ordinal when the mark was made; once its
 *      header is repaired, its twin takes the marked key back;
 *   (a) B1: `--only` and `--lines` renumber with the source unchanged;
 *   (b) B2: a twin `--lines` dropped never reached the twin facts;
 *   (c) B3: under rule 2 the mark's own key may now belong to another row.
 * In each, the mutant the mark ends up naming must NOT be reported as a matched mark. Every mark
 * here is what `lethal explain` prints for the survivor, pasted through the real marks parser.
 */

const APP_JSON = JSON.stringify({
  id: "4a7d1c52-8b8e-4f0e-9f41-3c6b2d1e5443",
  name: "R443 Fixture",
  publisher: "LethAL",
  version: "1.0.0.0",
  idRanges: [{ from: 50000, to: 80000 }],
});
const selectorIds = { selectorId: 50290, controlId: 50291, tableId: 50292 };
const OP = "lethal.remove-assignment";
const TWIN = "X := X + 1;";

const TEST_AL = `codeunit 50200 "Twin Tests"
{
    Subtype = Test;

    [Test]
    procedure BumpWorks()
    begin
    end;
}
`;

const table = (header: string, stmts: readonly string[]) => `${header}
{
    fields
    {
        field(1; Id; Integer) { }
    }

    procedure Bump(): Integer
    var
        X: Integer;
    begin
${stmts.map((s) => `        ${s}`).join("\n")}
        exit(X);
    end;
}
`;
/** Codeunit lines: statement i is on line 7 + i. */
const codeunit = (header: string, stmts: readonly string[]) => `${header}
{
    procedure Bump(): Integer
    var
        X: Integer;
    begin
${stmts.map((s) => `        ${s}`).join("\n")}
        exit(X);
    end;
}
`;

/** Every mutant survives; the baseline covers every `Bump`. */
class AllSurvive implements ExecutionBackend {
  private active: string | null = null;
  capabilities(): BackendCapabilities {
    return { coverage: "procedure", deploy: "publish", isolation: "session", authoritative: true };
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "stub" };
  }
  async deploy(): Promise<CompiledArtifact | null> {
    return null;
  }
  async compileCheck(): Promise<void> {}
  async activate(id: string | null): Promise<void> {
    this.active = id;
  }
  async run(ref: TestMethodRef): Promise<TestVerdict> {
    if (this.active === null) {
      return {
        ref,
        outcome: "pass",
        durationMs: 5,
        coverage: {
          granularity: "procedure",
          entries: [
            { objectType: "Table", objectId: 50100, procedure: "Bump" },
            { objectType: "Codeunit", objectId: 50100, procedure: "Bump" },
            { objectType: "Codeunit", objectId: 50101, procedure: "Bump" },
          ],
        },
      };
    }
    return {
      ref,
      outcome: "pass",
      durationMs: 5,
      attestation: { observedAny: true, identityMismatch: false },
    };
  }
}

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});
beforeAll(async () => {
  await initParser();
});

interface RunOpts {
  readonly marks?: readonly EquivalenceMark[];
  readonly only?: readonly string[];
  readonly lines?: readonly LineRange[];
  readonly emit?: (e: RunEvent) => void;
}

async function world(files: Readonly<Record<string, string>>) {
  const root = await mkdtemp(join(tmpdir(), "lethal-r443-"));
  roots.push(root);
  const projectDir = join(root, "app");
  const testDir = join(root, "tests");
  const instrumentedDir = join(root, "instr");
  await Bun.write(join(projectDir, "app.json"), APP_JSON);
  for (const [p, text] of Object.entries(files)) await Bun.write(join(projectDir, p), text);
  await Bun.write(join(testDir, "TwinTests.Codeunit.al"), TEST_AL);
  const run = (o: RunOpts = {}) =>
    runSession({
      backend: new AllSurvive(),
      store: new ResultsStore(":memory:"),
      projectDir,
      testDir,
      instrumentedDir,
      selectorIds,
      ...(o.marks !== undefined ? { equivalenceMarks: o.marks } : {}),
      ...(o.only !== undefined ? { only: o.only } : {}),
      ...(o.lines !== undefined ? { lines: o.lines } : {}),
      ...(o.emit !== undefined ? { emit: [o.emit] } : {}),
    });
  const write = (p: string, text: string) => Bun.write(join(projectDir, p), text);
  return { run, write };
}

type Mutant = SessionReport["mutants"][number];
const twinsOf = (r: SessionReport, file: string): Mutant[] =>
  r.mutants.filter((m) => m.operatorName === OP && m.file === file).sort((a, b) => a.line - b.line);
const keyOf = (m: Mutant): string =>
  serializeKey({
    astHash: m.astHash,
    codeunitName: m.codeunitName,
    procedureName: m.procedureName ?? "",
    operatorName: m.operatorName,
    operatorMajor: m.operatorMajor,
    ordinal: m.identityOrdinal ?? 0,
  });
const one = (ms: readonly Mutant[], what: string): Mutant => {
  const [m] = ms;
  if (m === undefined) throw new Error(`expected ${what}`);
  return m;
};

/**
 * The mark a reader writes for `m` from report `r`: `lethal explain`'s printed mark for that
 * survivor, its placeholder reason replaced, pasted into a marks file and read back by the parser.
 */
function markFor(r: SessionReport, m: Mutant): EquivalenceMark {
  const out = explain(r);
  const s = out.survivors.find(
    (x) => x.batchIndex === m.batchIndex && x.mutantCode === m.mutantCode,
  );
  if (s?.mark === undefined) throw new Error(`explain printed no mark for ${m.mutantCode}`);
  const text = JSON.stringify({
    identityScheme: out.markIdentityScheme,
    marks: [{ ...s.mark, reason: "reviewed: equivalent" }],
  });
  const [mark] = parseEquivalenceMarks(text, "lethal.equivalent.json");
  if (mark === undefined) throw new Error("the pasted mark did not parse");
  return mark;
}

/** `<file> @<line>` of every mutant a matched mark names in `r`. */
function matchedSites(r: SessionReport): string[] {
  const byCode = new Map(r.mutants.map((m) => [`${m.batchIndex ?? 0}/${m.mutantCode}`, m]));
  return (r.readerMarkedEquivalent?.matched ?? [])
    .map((x) => byCode.get(`${x.batchIndex}/${x.mutantCode}`))
    .map((m) => (m === undefined ? "?" : `${m.file} @${m.line}`))
    .sort();
}
const refusedReasons = (r: SessionReport): string[] =>
  (r.readerMarkedEquivalent?.refused ?? []).map((x) => x.reason);

describe("R443: a mark never names a twin it was not written for", () => {
  test("cross-file: the marked table twin is edited away; the codeunit twin is not marked", async () => {
    const w = await world({
      "A_Twin.Table.al": table('table 50100 "Twin"', [TWIN]),
      "B_Twin.Codeunit.al": codeunit('codeunit 50100 "Twin"', [TWIN]),
    });
    const first = await w.run();
    const a = one(twinsOf(first, "A_Twin.Table.al"), "the table twin");
    const mark = markFor(first, a);
    // Control: in the same source the mark names exactly the table twin.
    expect(matchedSites(await w.run({ marks: [mark] }))).toEqual([`A_Twin.Table.al @${a.line}`]);

    await w.write("A_Twin.Table.al", table('table 50100 "Twin"', ["X := 2;"]));
    const second = await w.run({ marks: [mark] });
    expect(matchedSites(second)).toEqual([]);
    expect(second.readerMarkedEquivalent?.stale).toEqual([mark.key]);
    // The STALE banner no longer claims an edit keeps a mark from drifting onto another mutant.
    const banner = renderConsole(second);
    expect(banner).toContain("EQUIVALENCE MARKS STALE: 1 mark(s)");
    expect(banner).not.toContain("drift");
  });

  test("same-file: the marked first twin is deleted; the second twin is not marked", async () => {
    const w = await world({
      "B_Twin.Codeunit.al": codeunit('codeunit 50101 "Pair"', [TWIN, "X := X * 2;", TWIN]),
    });
    const first = await w.run();
    const t0 = one(
      twinsOf(first, "B_Twin.Codeunit.al").filter((m) => (m.identityOrdinal ?? 0) === 0),
      "twin 0",
    );
    const mark = markFor(first, t0);
    expect(mark.fileSingleton).toBe(false);

    await w.write("B_Twin.Codeunit.al", codeunit('codeunit 50101 "Pair"', ["X := X * 2;", TWIN]));
    const second = await w.run({ marks: [mark] });
    expect(matchedSites(second)).toEqual([]);
    expect(refusedReasons(second)).toEqual(["renumbered"]);
    // The console names the refused mark, why, and the command that prints its replacement.
    const banner = renderConsole(second);
    expect(banner).toContain("EQUIVALENCE MARKS REFUSED: 1 mark(s)");
    expect(banner).toContain("lethal explain");
    expect(banner).toContain(`  ${mark.key} (B_Twin.Codeunit.al): renumbered, `);
  });

  test("header refusal (R443): a repaired file's twin does not inherit a mark made while it was refused", async () => {
    // T4's no-header shape: the namespace and the header on one line is refused (R307), and a
    // refused file reserves no ordinal, so the good file's twin held ordinal 0 when it was marked.
    const w = await world({
      "A_Bad.Table.al": table('namespace X; table 50100 "Twin"', [TWIN]),
      "B_Good.Codeunit.al": codeunit('codeunit 50100 "Twin"', [TWIN]),
    });
    const first = await w.run();
    expect(first.mutants.some((m) => m.file === "A_Bad.Table.al")).toBe(false);
    const good = one(twinsOf(first, "B_Good.Codeunit.al"), "the good twin");
    const mark = markFor(first, good);
    expect(mark.file).toBe("B_Good.Codeunit.al");

    await w.write("A_Bad.Table.al", table('namespace X;\ntable 50100 "Twin"', [TWIN]));
    const second = await w.run({ marks: [mark] });
    expect(matchedSites(second)).toEqual([]);
  });
});

describe("R443 controls", () => {
  test("unchanged source: a same-file twin's mark matches its own mutant (rule 1)", async () => {
    const w = await world({
      "B_Twin.Codeunit.al": codeunit('codeunit 50101 "Pair"', [TWIN, "X := X * 2;", TWIN]),
    });
    const first = await w.run();
    const t1 = one(
      twinsOf(first, "B_Twin.Codeunit.al").filter((m) => (m.identityOrdinal ?? 0) === 1),
      "twin 1",
    );
    const mark = markFor(first, t1);
    expect(mark.fileSingleton).toBe(false);
    expect(matchedSites(await w.run({ marks: [mark] }))).toEqual([
      `B_Twin.Codeunit.al @${t1.line}`,
    ]);
  });

  test("an unrelated edit: a singleton's mark still matches (rule 2)", async () => {
    const w = await world({
      "A_Twin.Table.al": table('table 50100 "Twin"', [TWIN]),
      "B_Other.Codeunit.al": codeunit('codeunit 50101 "Other"', ["X := 5;"]),
    });
    const first = await w.run();
    const a = one(twinsOf(first, "A_Twin.Table.al"), "the table twin");
    const mark = markFor(first, a);
    expect(mark.fileSingleton).toBe(true);

    await w.write("B_Other.Codeunit.al", codeunit('codeunit 50101 "Other"', ["X := 6;"]));
    const second = await w.run({ marks: [mark] });
    expect(second.numberingDigest).not.toBe(first.numberingDigest);
    expect(matchedSites(second)).toEqual([`A_Twin.Table.al @${a.line}`]);
  });

  test("a legacy key-only mark is refused (`no-proof`), even on unchanged source", async () => {
    const w = await world({ "A_Twin.Table.al": table('table 50100 "Twin"', [TWIN]) });
    const first = await w.run();
    const a = one(twinsOf(first, "A_Twin.Table.al"), "the table twin");
    const legacy: EquivalenceMark = { key: keyOf(a), reason: "old", identityScheme: 4 };
    const [parsed] = parseEquivalenceMarks(
      JSON.stringify({ identityScheme: explain(first).markIdentityScheme, marks: [legacy] }),
      "m",
    );
    if (parsed === undefined) throw new Error("legacy mark did not parse");
    const second = await w.run({ marks: [parsed] });
    expect(matchedSites(second)).toEqual([]);
    expect(second.readerMarkedEquivalent?.refused).toEqual([{ key: keyOf(a), reason: "no-proof" }]);
    expect(one(twinsOf(second, "A_Twin.Table.al"), "a").readerMark).toBeUndefined();
  });
});

describe("R443 (a) B1: --only and --lines renumber with the source unchanged", () => {
  const files = {
    "A_Twin.Table.al": table('table 50100 "Twin"', [TWIN]),
    "B_Twin.Codeunit.al": codeunit('codeunit 50100 "Twin"', [TWIN]),
  };

  test("marked under --only B, applied in a full run: names B's twin, never A's", async () => {
    const w = await world(files);
    const narrowed = await w.run({ only: ["B_Twin.Codeunit.al"] });
    const b = one(twinsOf(narrowed, "B_Twin.Codeunit.al"), "B's twin");
    expect(b.identityOrdinal ?? 0).toBe(0);
    const mark = markFor(narrowed, b);

    const full = await w.run({ marks: [mark] });
    const fullB = one(twinsOf(full, "B_Twin.Codeunit.al"), "B's twin");
    expect(matchedSites(full)).toEqual([`B_Twin.Codeunit.al @${fullB.line}`]);
  });

  test("marked in a full run, applied under --only B: A's mark never lands on B", async () => {
    const w = await world(files);
    const full = await w.run();
    const a = one(twinsOf(full, "A_Twin.Table.al"), "A's twin");
    const b = one(twinsOf(full, "B_Twin.Codeunit.al"), "B's twin");

    const aOnly = await w.run({ only: ["B_Twin.Codeunit.al"], marks: [markFor(full, a)] });
    expect(matchedSites(aOnly)).toEqual([]);
    // Control: B's own mark follows it under --only (rule 2).
    const bOnly = await w.run({ only: ["B_Twin.Codeunit.al"], marks: [markFor(full, b)] });
    expect(matchedSites(bOnly)).toEqual([`B_Twin.Codeunit.al @${b.line}`]);
  });

  test("--lines, same file: marked when the first twin was filtered out, applied in a full run", async () => {
    const w = await world({
      "B_Twin.Codeunit.al": codeunit('codeunit 50101 "Pair"', [TWIN, "X := X * 2;", TWIN]),
    });
    // Only the second twin (line 9) is generated, so it holds ordinal 0.
    const narrowed = await w.run({ lines: [{ file: "B_Twin.Codeunit.al", start: 9, end: 9 }] });
    const second = one(twinsOf(narrowed, "B_Twin.Codeunit.al"), "the second twin");
    expect(second.line).toBe(9);
    expect(second.identityOrdinal ?? 0).toBe(0);
    const mark = markFor(narrowed, second);
    expect(mark.fileSingleton).toBe(false);

    const full = await w.run({ marks: [mark] });
    expect(matchedSites(full)).toEqual([]);
    expect(refusedReasons(full)).toEqual(["renumbered"]);
  });
});

describe("R443 (b) B2: a twin --lines dropped is not a singleton", () => {
  test("marked from a --lines run, the marked twin deleted, a full run: the other twin is not marked", async () => {
    const w = await world({
      "B_Twin.Codeunit.al": codeunit('codeunit 50101 "Pair"', [TWIN, "X := X * 2;", TWIN]),
    });
    const narrowed = await w.run({ lines: [{ file: "B_Twin.Codeunit.al", start: 7, end: 7 }] });
    const first = one(twinsOf(narrowed, "B_Twin.Codeunit.al"), "the first twin");
    expect(first.line).toBe(7);
    // The run's twin sites cannot see the dropped twin; its carryHidden can.
    expect(narrowed.twinSites).toEqual([]);
    const mark = markFor(narrowed, first);

    await w.write("B_Twin.Codeunit.al", codeunit('codeunit 50101 "Pair"', ["X := X * 2;", TWIN]));
    const full = await w.run({ marks: [mark] });
    // The sequence first, then why: the mark never proved a singleton.
    expect(matchedSites(full)).toEqual([]);
    expect(mark.fileSingleton).toBe(false);
    expect(refusedReasons(full)).toEqual(["renumbered"]);
  });
});

describe("R443 (c) B3: the per-row readerMark joins on the matched row, not the mark's key", () => {
  test("rule 2 moves the mark's key to another row; only the matched row carries readerMark", async () => {
    const w = await world({
      "A_Twin.Table.al": table('table 50100 "Twin"', [TWIN]),
      "B_Twin.Codeunit.al": codeunit('codeunit 50100 "Twin"', [TWIN]),
      "C_Twin.Codeunit.al": codeunit('codeunit 50101 "Twin"', [TWIN]),
    });
    const first = await w.run();
    const b = one(twinsOf(first, "B_Twin.Codeunit.al"), "B's twin");
    expect(b.identityOrdinal).toBe(1);
    const mark = markFor(first, b);

    await w.write("A_Twin.Table.al", table('table 50100 "Twin"', ["X := 2;"]));
    const second = await w.run({ marks: [mark] });
    const b2 = one(twinsOf(second, "B_Twin.Codeunit.al"), "B's twin");
    const c2 = one(twinsOf(second, "C_Twin.Codeunit.al"), "C's twin");
    // The mark's own key now names C's twin.
    expect(keyOf(c2)).toBe(mark.key);
    expect(matchedSites(second)).toEqual([`B_Twin.Codeunit.al @${b2.line}`]);
    // The per-row join first: C's row holds the mark's old key and must not carry it.
    expect(c2.readerMark).toBeUndefined();
    expect(b2.readerMark).toEqual({ key: keyOf(b2), reason: "reviewed: equivalent" });
    expect(second.readerMarkedEquivalent?.matched.map((m) => m.key)).toEqual([keyOf(b2)]);
  });
});

describe("R443 (d) N1: with this run's numbering facts absent, every mark is refused", () => {
  test("a stream without the facts folds to a report that applies no mark", async () => {
    const w = await world({ "A_Twin.Table.al": table('table 50100 "Twin"', [TWIN]) });
    const first = await w.run();
    const a = one(twinsOf(first, "A_Twin.Table.al"), "A's twin");
    const mark = markFor(first, a);
    const events: RunEvent[] = [];
    const withFacts = await w.run({ marks: [mark], emit: (e) => events.push(e) });
    expect(matchedSites(withFacts)).toEqual([`A_Twin.Table.al @${a.line}`]);

    // The same stream with the three fields removed, as a stream from before R443 has it.
    const stripped = events.map((e) => {
      if (e.type !== "mutation-set-generated") return e;
      const { numberingDigest: _d, twinSites: _t, carryHidden: _c, ...rest } = e;
      return rest;
    });
    const caps = new AllSurvive().capabilities();
    const report = buildReport(
      { caps, buildSymbols: [], equivalenceMarks: [mark], preprocessorSymbols: [] },
      stripped,
    );
    expect(report.readerMarkedEquivalent?.matched).toEqual([]);
    expect(report.readerMarkedEquivalent?.refused).toEqual([
      { key: mark.key, reason: "no-run-facts", file: "A_Twin.Table.al" },
    ]);
    expect(report.numberingDigest).toBeUndefined();
    // And explain offers no mark from such a report, since it could carry no proof.
    expect(explain(report).survivors.every((s) => s.mark === undefined)).toBe(true);
  });
});

describe("R443: explain's mark comes from the RECORDED facts", () => {
  test("numberingDigest is the report's; fileSingleton reads twinSites and carryHidden, never the rows", async () => {
    const w = await world({ "A_Twin.Table.al": table('table 50100 "Twin"', [TWIN]) });
    const r = await w.run();
    const a = one(twinsOf(r, "A_Twin.Table.al"), "A's twin");
    const markOf = (rep: SessionReport) => {
      const s = explain(rep).survivors.find((x) => x.mutantCode === a.mutantCode);
      if (s?.mark === undefined) throw new Error("no mark");
      return s.mark;
    };
    const base = markOf(r);
    expect(base.key).toBe(markIdentityOf(a));
    expect(base.file).toBe("A_Twin.Table.al");
    expect(base.numberingDigest).toBe(r.numberingDigest ?? "");
    expect(base.fileSingleton).toBe(true);
    const hidden = r.carryHidden ?? { tuples: [], files: [] };
    // A twin site recorded for the run, although the rows show one mutant.
    expect(
      markOf({ ...r, twinSites: [twinSiteOf("A_Twin.Table.al", markTupleOfRow(a))] }).fileSingleton,
    ).toBe(false);
    // Its coarse tuple hidden (a line filter or a header refusal dropped a site sharing it).
    const coarse = `${a.astHash}|${a.operatorName}|${a.operatorMajor}`;
    expect(markOf({ ...r, carryHidden: { ...hidden, tuples: [coarse] } }).fileSingleton).toBe(
      false,
    );
    // Its file hidden whole.
    expect(
      markOf({ ...r, carryHidden: { ...hidden, files: ["A_Twin.Table.al"] } }).fileSingleton,
    ).toBe(false);
    // Only some of the three facts is a corrupt report, refused by name.
    const { twinSites: _t, ...partial } = r;
    expect(() => explain(partial as SessionReport)).toThrow(/written together/);
  });
});

describe("R443 r2.1: the digest hashes the numbering OUTPUT, so a collation change cannot pass rule 1", () => {
  test("a reversed file comparator changes the digest, and the mark still names its own twin", () => {
    const TUPLE = "h|Twin|Bump|lethal.remove-assignment|1";
    const entries: IdentityEntry[] = [
      { file: "A.al", startIndex: 10, endIndex: 20, operatorName: OP, tuple: TUPLE },
      { file: "B.al", startIndex: 10, endIndex: 20, operatorName: OP, tuple: TUPLE },
    ];
    const real = numberIdentityOrdinals(entries);
    // The injected numbering: files in REVERSE order, as another host's collation could sort them.
    const reversed = new Map<string, number>();
    [...entries]
      .sort((x, y) => (x.file < y.file ? 1 : -1))
      .forEach((e, i) =>
        reversed.set(identitySiteKey(e.file, e.startIndex, e.endIndex, e.operatorName), i),
      );
    const realDigest = numberingDigestOf(entries, real);
    const reversedDigest = numberingDigestOf(entries, reversed);
    expect(reversedDigest).not.toBe(realDigest);
    // Code-unit order, never the input order: shuffling the input does not move the digest.
    expect(numberingDigestOf([...entries].reverse(), real)).toBe(realDigest);

    // A's mark made on the real host (A is ordinal 0), applied on the reversed host (A is 1).
    const mark: EquivalenceMark = {
      key: TUPLE,
      reason: "r",
      identityScheme: 1,
      file: "A.al",
      numberingDigest: realDigest,
      fileSingleton: true,
    };
    const ord = (f: string) => reversed.get(identitySiteKey(f, 10, 20, OP)) ?? -1;
    const mutants = ["A.al", "B.al"].map((file, i) => ({
      batchIndex: 0,
      mutantCode: `M${i}`,
      identity: ord(file) > 0 ? `${TUPLE}|${ord(file)}` : TUPLE,
      file,
      tuple: TUPLE,
      verdict: "survived",
    }));
    const r = applyEquivalenceMarks([mark], mutants, 1, [], {
      numberingDigest: reversedDigest,
      twinSites: new Set(),
    });
    expect(r.matched.map((m) => m.mutantCode)).toEqual(["M0"]);
  });
});
