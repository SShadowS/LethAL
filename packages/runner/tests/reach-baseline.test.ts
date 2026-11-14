import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initParser, parseAL, wrapRoot } from "@lethal/engine";
import {
  type TierResolver,
  assignMutantIds,
  dedupeSpecs,
  emitOneFile,
  instrumentOneFile,
  originalPositions,
  planOneFile,
  reachLinesOf,
} from "@lethal/schemata";
import type { TestMethodRef, TestVerdict } from "../src/backend";
import { fileLineMapEntries, objectIdentityOf, resolveFileLine } from "../src/line-map";
import { testKeyOf } from "../src/selection";
import {
  baselineReachOf,
  generateMutationSet,
  operatorTiers,
  reachFromBaseline,
} from "../src/orchestrator";

const REPO = resolve(import.meta.dir, "../../..");
const tierOf: TierResolver = (name) => operatorTiers.get(name);

beforeAll(async () => {
  await initParser();
});

interface Instrumented {
  readonly source: string;
  readonly compiled: string;
  /** mutant id -> its manifest `reachLine` */
  readonly lines: ReadonlyMap<string, number>;
  /** mutant id -> the source offset of its reach statement */
  readonly stmt: ReadonlyMap<string, number>;
  /** the statement's source offset -> its start offset in the original copy */
  readonly where: (source: number) => number | undefined;
  readonly entries: ReturnType<typeof fileLineMapEntries>;
}

async function instrumentDir(dir: string): Promise<Instrumented[]> {
  const set = await generateMutationSet(dir, { emit: () => {} });
  const out: Instrumented[] = [];
  for (const f of set.files) {
    const deduped = dedupeSpecs(f.specs, tierOf);
    const ided = assignMutantIds(new Map([[f.path, deduped]])).get(f.path) ?? [];
    if (ided.length === 0) continue;
    const plan = planOneFile(f, deduped, ided);
    const compiled = emitOneFile(plan);
    const stmt = new Map<string, number>();
    for (const m of plan.compile.members) {
      if (m.reachSite !== undefined) stmt.set(m.mutantId, m.reachSite.stmt);
    }
    out.push({
      source: f.source,
      compiled,
      lines: reachLinesOf(plan, compiled),
      stmt,
      where: originalPositions(plan.compile),
      entries: fileLineMapEntries(wrapRoot(parseAL(compiled)), objectIdentityOf, f.path),
    });
  }
  return out;
}

const fileLineAt = (text: string, offset: number): number =>
  text.slice(0, offset).split("\n").length;

/**
 * R926. The reach line a manifest row carries is where the ORIGINAL copy of the reach statement
 * starts in the instrumented text, in al-runner's coverage frame. The text moves lines (a chain adds
 * some and copies its root once per member), so the source line is wrong for any object with a
 * mutant. For every statement-grain mutant: the text at the mapped offset must be the statement
 * itself (not a mutant's branch), and the line map's own conversion (`resolveFileLine`, the call
 * `alRunnerCoverageFromServer` makes for each reported statement) must give `reachLine`.
 */
describe("R926: reachLine is in the coverage frame", () => {
  for (const rel of [
    "fixtures/sandbox-app",
    "fixtures/sandbox-multiobject",
    "fixtures/sandbox-data",
  ]) {
    test(rel, async () => {
      let checked = 0;
      let moved = 0;
      let shifted = 0;
      for (const b of await instrumentDir(join(REPO, rel))) {
        for (const [id, line] of b.lines) {
          const stmt = b.stmt.get(id);
          expect(stmt).toBeDefined();
          const off = b.where(stmt ?? -1);
          expect(off).toBeDefined();
          const head = b.source.slice(stmt, (stmt ?? 0) + 5); // five characters: a chain's copy may differ after them (`;`, a guard after `begin`)
          expect(b.compiled.startsWith(head, off)).toBe(true);
          // Never a mutant's branch: its copy sits behind `Active(..) then begin`, the original
          // behind `else begin` or in place.
          expect(/Active\('M\d+'\) then begin\s*$/.test(b.compiled.slice(0, off))).toBe(false);
          const fileLine = fileLineAt(b.compiled, off ?? 0);
          const placed = resolveFileLine(b.entries, fileLine);
          expect(placed?.objectLine).toBe(line);
          if (fileLine !== fileLineAt(b.source, stmt ?? 0)) moved++;
          if (placed !== undefined && placed.objectLine !== fileLine) shifted++;
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(0);
      // The text really moves lines, so the source line would be wrong; the multi-object fixture
      // also proves the object frame is not the file frame.
      if (rel.endsWith("sandbox-app")) expect(moved).toBeGreaterThan(0);
      if (rel.endsWith("multiobject")) expect(shifted).toBeGreaterThan(0);
    }, 60_000);
  }

  test("several mutants in one object, two on one statement, and a nested statement", async () => {
    const [b] = (await instrumentDir(join(REPO, "fixtures/sandbox-multiobject"))).slice(1);
    if (b === undefined) throw new Error("no second file");
    // Mutants on one statement share its one original copy.
    const byStmt = new Map<number, Set<number>>();
    for (const [id, line] of b.lines) {
      const s = b.stmt.get(id) ?? -1;
      byStmt.set(s, (byStmt.get(s) ?? new Set()).add(line));
    }
    expect([...byStmt.values()].some((l) => l.size === 1)).toBe(true);
    for (const lines of byStmt.values()) expect(lines.size).toBe(1);
    expect(b.lines.size).toBeGreaterThan(byStmt.size);
    // `Reached` holds an `if` whose then-statement (`exit(X + 1)`) sits inside a block that
    // has mutants of its own: every statement still lands on its own, distinct line.
    expect(new Set(b.lines.values()).size).toBe(byStmt.size);
  });

  async function oneFile(body: string): Promise<Instrumented> {
    const dir = await mkdtemp(join(tmpdir(), "r926-"));
    await writeFile(
      join(dir, "app.json"),
      JSON.stringify({
        id: "df1aa9ff-6539-4c86-a9d0-ad702b61ac9b",
        name: "R926",
        publisher: "LethAL",
        version: "1.0.0.0",
        idRanges: [{ from: 79900, to: 79999 }],
      }),
    );
    await writeFile(join(dir, "T.Codeunit.al"), body);
    const [b] = await instrumentDir(dir);
    await rm(dir, { recursive: true, force: true });
    if (b === undefined) throw new Error("no mutants");
    return b;
  }

  // R989 (R-976, measured on edge-736fc7677): al-runner reports a hit on the `if` of a one-line
  // `if c then begin X end` even when `c` is false. In the INSTRUMENTED text the chain puts X's
  // original copy on a line of its own, so X's reach line is not the `if`'s and a false-path test
  // does not cover X. Pinned here: an emit change that left X on the guard's line would let every
  // such test over-cover X (R975) and read it reached (R926).
  test("a one-line guarded block: the inner statement's reach line is not the guard's", async () => {
    const b = await oneFile(`codeunit 79900 "One Line"
{
    procedure P(N: Integer): Integer
    var
        I: Integer;
    begin
        if N > 5 then begin I := 7; end;
        exit(I);
    end;
}
`);
    const linesAt = (start: string) =>
      new Set(
        [...b.stmt]
          .filter(([, s]) => b.source.startsWith(start, s))
          .map(([id]) => b.lines.get(id)),
      );
    const guard = linesAt("if N > 5");
    const inner = linesAt("I := 7");
    expect(guard.size).toBe(1);
    expect(inner.size).toBe(1);
    expect([...inner][0]).not.toBe([...guard][0]);
  });

  test("a statement over several lines starts where its first line is, two mutants share it", async () => {
    const b = await oneFile(`codeunit 79900 "Multi Line"
{
    procedure Calc(A: Integer; B: Integer; C: Integer): Integer
    var
        Total: Integer;
    begin
        Total := A +
            B +
            C;
        if (A > B) and
           (B > C) then
            Total := 0;
        exit(Total);
    end;
}
`);
    const wanted = ["Total := A +", "if (A > B) and"];
    for (const start of wanted) {
      const ids = [...b.stmt].filter(([, s]) => b.source.startsWith(start, s)).map(([id]) => id);
      expect(ids.length).toBeGreaterThan(1);
      const lines = new Set(ids.map((id) => b.lines.get(id)));
      expect(lines.size).toBe(1);
      const [line] = [...lines];
      // The coverage statement al-runner reports for it: its first line, in the instrumented frame.
      const hit = b.compiled.split("\n").findIndex((l, i) => {
        const p = resolveFileLine(b.entries, i + 1);
        return p?.objectLine === line;
      });
      // The statement's first line; a chain closing just before it may share that line (no newline).
      expect(b.compiled.split("\n")[hit]?.trim().endsWith(start)).toBe(true);
    }
  });

  // R926 review E: dispatch-plan.ts's NOT_AN_OBJECT / DIRECTIVE_ONLY are copies of line-map.ts's
  // rule. Pinned by behaviour: a namespace and a using line before the first object, and a comment,
  // a multi-line comment, a pragma and a #region between the two objects, none of which is an
  // object. If the two rules disagree on any of them, the reach line leaves line-map's frame.
  test("lines that are no object do not move the base: reachSiteOf agrees with line-map", async () => {
    const b = await oneFile(`namespace R926.Pin;

using System.Utilities;

codeunit 79900 "Pin One"
{
    procedure One(A: Integer; B: Integer): Boolean
    begin
        exit(A > B);
    end;
}

// a line comment
/* a block
   comment */
#pragma warning disable AA0137
#region Second
codeunit 79901 "Pin Two"
{
    procedure Two(A: Integer; B: Integer): Boolean
    begin
        exit(A > B);
    end;
}
#endregion
`);
    const second = b.source.indexOf("codeunit 79901");
    const seen = { first: 0, second: 0 };
    for (const [id, line] of b.lines) {
      const stmt = b.stmt.get(id) ?? -1;
      const off = b.where(stmt);
      expect(off).toBeDefined();
      const placed = resolveFileLine(b.entries, fileLineAt(b.compiled, off ?? 0));
      expect(placed?.objectLine).toBe(line);
      if (stmt < second) seen.first++;
      else seen.second++;
    }
    expect(seen.first).toBeGreaterThan(0);
    expect(seen.second).toBeGreaterThan(0);
  });
});

/**
 * R926: the reach side table must not touch the emitted text. The hash is of every instrumented
 * file of two fixtures, taken BEFORE the side table existed; `instrumentOneFile` (which now also
 * computes `reachLine`) must give the same text as `emitOneFile` alone. A later change that leaks
 * into the text moves the hash.
 */
describe("R926: the emitted text is byte-identical", () => {
  test("hash of the instrumented fixtures, and instrumentOneFile equals emitOneFile", async () => {
    const hash = new Bun.CryptoHasher("sha256");
    for (const rel of ["fixtures/sandbox-app", "fixtures/sandbox-multiobject"]) {
      const set = await generateMutationSet(join(REPO, rel), { emit: () => {} });
      for (const f of set.files) {
        const deduped = dedupeSpecs(f.specs, tierOf);
        const ided = assignMutantIds(new Map([[f.path, deduped]])).get(f.path) ?? [];
        if (ided.length === 0) continue;
        const text = emitOneFile(planOneFile(f, deduped, ided));
        expect(instrumentOneFile(f, deduped, ided).compiled).toBe(text);
        hash.update(`${f.path}\n${text}\n`);
      }
    }
    expect(hash.digest("hex")).toBe(
      "5bc4d1f4e5c5293bf964c7df752d10f99c3b1d2d864b083117929a2b2bf23b73",
    );
  });
});

const ref = (method: string, codeunitId = 79100): TestMethodRef => ({
  codeunitId,
  codeunitName: "Sandbox Tests",
  method,
});
const verdict = (
  r: TestMethodRef,
  outcome: TestVerdict["outcome"],
  lines: readonly number[] | undefined,
  extra: Partial<TestVerdict> = {},
): TestVerdict => ({
  ref: r,
  outcome,
  durationMs: 1,
  ...(lines !== undefined
    ? {
        coverage: {
          granularity: "line" as const,
          entries: lines.map((line) => ({ objectType: "Codeunit", objectId: 79000, line })),
        },
      }
    : {}),
  ...extra,
});
const site = {
  reachGrain: "statement",
  reachLine: 5,
  objectType: "codeunit",
  codeunitId: 79000,
} as const;

describe("R926: only a complete set of passing baseline coverages decides", () => {
  const a = ref("ATest");
  const b = ref("BTest");
  const modes = { isolationOf: () => "test" as const };

  test("a baseline row that did not pass leaves the mutant undecided, never unreached", () => {
    for (const bad of ["timeout", "error", "skip", "fail"] as const) {
      const rows = [
        { ref: a, verdict: verdict(a, "pass", [4]) },
        { ref: b, verdict: verdict(b, bad, [4]) },
      ];
      const evidence = baselineReachOf(rows, new Set([a, b]), modes);
      expect(reachFromBaseline(site, [a, b], evidence, () => "test")).toBeUndefined();
    }
    // The control: both pass and miss, so unreached.
    const rows = [
      { ref: a, verdict: verdict(a, "pass", [4]) },
      { ref: b, verdict: verdict(b, "pass", [6]) },
    ];
    const evidence = baselineReachOf(rows, new Set([a, b]), modes);
    expect(reachFromBaseline(site, [a, b], evidence, () => "test")).toEqual({
      guardReached: false,
      reachedBy: [],
    });
  });

  // R-917: a flagged pass ran to its end, so it IS evidence (measured: nearly every pass of Microsoft's
  // apps is flagged, and excluding them left every v3 reach undecided).
  test("a flagged baseline pass is evidence: its hit decides the reach", () => {
    const rows = [{ ref: b, verdict: verdict(b, "pass", [4], { flagged: true }) }];
    const evidence = baselineReachOf(rows, new Set([b]), modes);
    expect(evidence.hits.has(testKeyOf(b))).toBe(true);
  });

  test("a refused, reused or partial baseline row is not evidence", () => {
    const cases: Array<[string, TestVerdict, boolean]> = [
      ["refused", verdict(b, "error", [4], { runnerRow: "runner-refused" }), true],
      ["reused (not run here)", verdict(b, "pass", [4]), false],
      [
        "naming gap",
        {
          ...verdict(b, "pass", [4]),
          coverage: {
            granularity: "line",
            entries: [{ objectType: "Codeunit", objectId: 79000, line: 4 }],
            namingGaps: [{ objectType: "Codeunit", objectId: 79000 }],
          },
        },
        true,
      ],
      ["procedure grain", verdict(b, "pass", undefined), true],
    ];
    for (const [name, v, ranHere] of cases) {
      const rows = [
        { ref: a, verdict: verdict(a, "pass", [4]) },
        { ref: b, verdict: v },
      ];
      const evidence = baselineReachOf(rows, new Set(ranHere ? [a, b] : [a]), modes);
      expect([name, reachFromBaseline(site, [a, b], evidence, () => "test")]).toEqual([
        name,
        undefined,
      ]);
    }
  });

  test("a hit names the testing method; a mode that moved is undecided", () => {
    const rows = [
      { ref: a, verdict: verdict(a, "pass", [5]) },
      { ref: b, verdict: verdict(b, "pass", [4]) },
    ];
    const evidence = baselineReachOf(rows, new Set([a, b]), modes);
    expect(reachFromBaseline(site, [a, b], evidence, () => "test")).toEqual({
      guardReached: true,
      reachedBy: ["Sandbox Tests.ATest"],
    });
    expect(reachFromBaseline(site, [a, b], evidence, () => "method")).toBeUndefined();
    expect(reachFromBaseline(site, [], evidence, () => "test")).toBeUndefined();
    const { reachLine: _line, ...noLine } = site;
    expect(reachFromBaseline(noLine, [a], evidence, () => "test")).toBeUndefined();
  });
});
