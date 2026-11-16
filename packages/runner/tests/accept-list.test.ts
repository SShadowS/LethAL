import { describe, expect, test } from "bun:test";
// PR-79: the accept list. Spec: docs/superpowers/specs/2026-11-16-pr79-accept-list.md
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clipMutationText } from "@lethal/schemata";
import {
  ACCEPT_REASON_PLACEHOLDER,
  type AcceptEntry,
  AcceptListError,
  type AcceptReportView,
  type AcceptResult,
  type LoadedAcceptList,
  computeAcceptResult,
  parseAcceptList,
} from "../src/accept-list";
import {
  type ReportView,
  changedLineSurvivors,
  renderChangedLineSurvivors,
} from "../src/changed-line-survivors";
import {
  type RunCliConfig,
  exitCodeForReport,
  runExitCode,
  runFromCliWithAccept,
} from "../src/cli";
import type { MutantOutcome, SessionReport } from "../src/report";
import { removeRunScratchAfterAll } from "./helpers/scratch";

removeRunScratchAfterAll();

const FILE = "src/Poster.al";
const LIST_PATH = "/proj/lethal.accepted.json";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

interface Site {
  needle: string;
  nth?: number;
  code: string;
  verdict?: MutantOutcome["verdict"];
  op?: string;
  hash?: string;
  batch?: number;
  file?: string;
  proc?: string;
  trigger?: string;
  unit?: string;
  noSpan?: boolean;
  spanShift?: number;
  extra?: Record<string, unknown>;
}

/** A report row for `needle` in `source`. The member's lines are found by text, not by the parser. */
function rowOf(source: string, s: Site): MutantOutcome {
  let idx = -1;
  for (let i = 0; i <= (s.nth ?? 0); i++) idx = source.indexOf(s.needle, idx + 1);
  if (idx < 0) throw new Error(`needle ${s.needle} not found`);
  const lines = source.split("\n");
  const siteLine = source.slice(0, idx).split("\n").length;
  let start = siteLine - 1;
  while (start >= 0 && !/^\s*(procedure|trigger) /.test(lines[start] ?? "")) start--;
  const indent = (lines[start] ?? "").match(/^\s*/)?.[0] ?? "";
  let end = start;
  while (lines[end] !== `${indent}end;`) end++;
  return {
    mutantCode: s.code,
    batchIndex: s.batch ?? 0,
    file: s.file ?? FILE,
    line: siteLine,
    operatorName: s.op ?? "conditional-boundary",
    verdict: s.verdict ?? "survived",
    astHash: s.hash ?? "h1",
    codeunitName: s.unit ?? "Poster",
    procedureName: s.trigger !== undefined ? "" : (s.proc ?? "Post"),
    ...(s.trigger !== undefined ? { triggerName: s.trigger } : {}),
    operatorMajor: 1,
    startIndex: idx,
    endIndex: idx + s.needle.length,
    originalText: clipMutationText(s.needle),
    mutatedText: "",
    coveringTests: [],
    ...(s.noSpan === true
      ? {}
      : {
          procedureStartLine: start + 1 + (s.spanShift ?? 0),
          procedureEndLine: end + 1,
        }),
    ...(s.extra ?? {}),
  } as unknown as MutantOutcome;
}

type Rep = AcceptReportView & ReportView;
// `null`: a report that records no buildSymbols at all.
const report = (mutants: MutantOutcome[], symbols: string[] | null = []): Rep => ({
  backend: "bcdev",
  validity: { caveats: ["line-narrowed"] },
  ...(symbols !== null ? { buildSymbols: symbols } : {}),
  mutants,
});
const snap = (source: string, file = FILE) => new Map([[file, Buffer.from(source)]]);
const list = (entries: AcceptEntry[] | undefined): LoadedAcceptList => ({
  path: LIST_PATH,
  entries,
});

async function accept(
  source: string,
  rows: MutantOutcome[],
  entries: AcceptEntry[] | undefined,
  symbols: string[] | null = [],
  file = FILE,
): Promise<AcceptResult> {
  return computeAcceptResult({
    report: report(rows, symbols),
    snapshot: snap(source, file),
    list: list(entries),
  });
}

/** The ready entry `lethal run` prints for `code`, with a real reason (what a developer pastes). */
async function entryFor(
  source: string,
  rows: MutantOutcome[],
  ref = "0/M1",
  reason = "fine",
  symbols: string[] = [],
): Promise<AcceptEntry> {
  const r = await accept(source, rows, undefined, symbols);
  const ready = r.ready.get(ref);
  if (ready === undefined || !("entry" in ready)) {
    throw new Error(`no ready entry for ${ref}: ${JSON.stringify(ready)}`);
  }
  return { ...ready.entry, reason };
}

const POST = `codeunit 50100 "Poster"
{
    [Scope('OnPrem')]
    procedure Post(X: Integer): Boolean
    begin
        if X > 0 then
            exit(true);
        exit(false);
    end;

    procedure Other(X: Integer): Boolean
    begin
        if X > 0 then
            exit(true);
        exit(false);
    end;
}
`;
const M1: Site = { needle: "X > 0", code: "M1" };

const counted = (rep: Rep, r: AcceptResult) => changedLineSurvivors(rep, r)?.counted ?? [];
const lines = (r: AcceptResult) => r.entryLines.join("\n");

describe("PR-79: an entry accepts a survivor", () => {
  test("the ready entry has the hand-computed anchor", async () => {
    const e = await entryFor(POST, [rowOf(POST, M1)]);
    // [Scope] (0), procedure (1), begin (2), the `if` (3); the site starts at "X" of "if X".
    expect(e.lineInProcedure).toBe(3);
    expect(e.column).toBe(3);
    expect(e.siteText).toBe(sha("if X > 0 then"));
    expect(e.tuple).toBe("h1|Poster|Post|conditional-boundary|1");
    expect(e.procedureText).toBe(
      sha(
        [
          "[Scope('OnPrem')]",
          "procedure Post(X: Integer): Boolean",
          "begin",
          "if X > 0 then",
          "exit(true);",
          "exit(false);",
          "end;",
        ].join("\n"),
      ),
    );
    expect(e.preprocessorSymbols).toEqual([]);
  });

  test("an entry matching every field on one row: accepted, not counted, exit 0 with the flag", async () => {
    const rows = [rowOf(POST, M1)];
    const rep = report(rows);
    const r = await accept(POST, rows, [await entryFor(POST, rows)]);
    expect(r.accepted.get("0/M1")).toBe("fine");
    const s = changedLineSurvivors(rep, r);
    expect(s?.counted).toEqual([]);
    expect(s?.accepted.map((m) => m.reason)).toEqual(["fine"]);
    expect(exitCodeForReport(rep, true, r)).toBe(0);
    expect(runExitCode(rep, { failOnSurvivors: true }, r)).toBe(0);
    // without the result the survivor counts (the same report)
    expect(exitCodeForReport(rep, true)).toBe(9);
    expect(renderChangedLineSurvivors(s as never, r)).toContain("accepted: fine");
  });

  test("each field compared on its own: flipping one on an unchanged source leaves it counted", async () => {
    const rows = [rowOf(POST, M1)];
    const rep = report(rows);
    const e = await entryFor(POST, rows);
    const flips: Record<string, Partial<AcceptEntry>> = {
      file: { file: "src/Elsewhere.al" },
      tuple: { tuple: e.tuple.replace("|Post|", "|Other|") },
      lineInProcedure: { lineInProcedure: e.lineInProcedure + 1 },
      column: { column: e.column + 1 },
      siteText: { siteText: "a".repeat(64) },
      procedureText: { procedureText: "b".repeat(64) },
      preprocessorSymbols: { preprocessorSymbols: ["Z"] },
    };
    for (const [name, flip] of Object.entries(flips)) {
      const r = await accept(POST, rows, [{ ...e, ...flip }]);
      expect(r.accepted.size, name).toBe(0);
      expect(counted(rep, r).length, name).toBe(1);
    }
  });

  test("the file is compared case-insensitively", async () => {
    const rows = [rowOf(POST, M1)];
    const e = await entryFor(POST, rows);
    const r = await accept(POST, rows, [{ ...e, file: "SRC/POSTER.AL" }]);
    expect(r.accepted.size).toBe(1);
  });

  test("a line shift from edits outside the member keeps the entry", async () => {
    const e = await entryFor(POST, [rowOf(POST, M1)]);
    const shifted = POST.replace("{\n", "{\n    // a comment\n    // another\n");
    const rows = [rowOf(shifted, M1)];
    expect(rows[0]?.line).toBe(8);
    const r = await accept(shifted, rows, [e]);
    expect(r.accepted.has("0/M1")).toBe(true);
  });
});

describe("PR-79: what re-opens an accepted survivor", () => {
  const edits: Array<[string, string, Site, string]> = [
    [
      "the site's line edited (same astHash: x > 0 becomes x > 5)",
      POST.replace("if X > 0 then", "if X > 5 then"),
      { ...M1, needle: "X > 5" },
      "re-opened",
    ],
    [
      "another line of the procedure edited",
      POST.replace("exit(false);", "exit(true);"),
      M1,
      "re-opened",
    ],
    [
      "an attribute changed",
      POST.replace("[Scope('OnPrem')]", "[Scope('Cloud')]"),
      M1,
      "re-opened",
    ],
    [
      "a line added before the site",
      POST.replace("begin\n        if X > 0", "begin\n        Foo();\n        if X > 0"),
      M1,
      "re-opened",
    ],
  ];
  for (const [name, source, site, label] of edits) {
    test(name, async () => {
      const e = await entryFor(POST, [rowOf(POST, M1)]);
      const rows = [rowOf(source, site)];
      const r = await accept(source, rows, [e]);
      expect(r.accepted.size).toBe(0);
      expect(counted(report(rows), r).length).toBe(1);
      expect(lines(r)).toContain(label);
    });
  }

  test("a move to another procedure reads not-in-run, and counts", async () => {
    const e = await entryFor(POST, [rowOf(POST, M1)]);
    const rows = [rowOf(POST, { ...M1, nth: 1, proc: "Other" })];
    const r = await accept(POST, rows, [e]);
    expect(r.accepted.size).toBe(0);
    expect(r.notInRun).toBe(1);
    expect(counted(report(rows), r).length).toBe(1);
  });

  test("a move to another file counts", async () => {
    const e = await entryFor(POST, [rowOf(POST, M1)]);
    const rows = [rowOf(POST, { ...M1, file: "src/Moved.al" })];
    const r = await accept(POST, rows, [e], [], "src/Moved.al");
    expect(r.accepted.size).toBe(0);
    expect(counted(report(rows), r).length).toBe(1);
  });

  test("another preprocessor symbol set re-opens it", async () => {
    const rows = [rowOf(POST, M1)];
    const e = await entryFor(POST, rows);
    const r = await accept(POST, rows, [e], ["X"]);
    expect(r.accepted.size).toBe(0);
    expect(lines(r)).toContain("re-opened");
  });

  test("a report with no buildSymbols accepts nothing, even a matching entry", async () => {
    const rows = [rowOf(POST, M1)];
    const e = await entryFor(POST, rows);
    const r = await accept(POST, rows, [e], null);
    expect(r.accepted.size).toBe(0);
    expect(r.ready.get("0/M1")).toEqual({ cannot: expect.stringContaining("no build symbols") });
  });
});

describe("PR-79: twins", () => {
  const TWIN = `codeunit 50100 "Poster"
{
    procedure Post(X: Integer)
    begin
        if X > 0 then
            Foo();
        if X > 0 then
            Foo();
    end;
}
`;
  const A: Site = { needle: "X > 0", code: "M1" };
  const B: Site = { needle: "X > 0", nth: 1, code: "M2" };

  test("twins at different places are each accepted by their own entry", async () => {
    const rows = [rowOf(TWIN, A), rowOf(TWIN, B)];
    const ea = await entryFor(TWIN, rows, "0/M1", "a");
    const eb = await entryFor(TWIN, rows, "0/M2", "b");
    expect([ea.lineInProcedure, eb.lineInProcedure]).toEqual([2, 4]);
    const r = await accept(TWIN, rows, [ea, eb]);
    expect(r.accepted.get("0/M1")).toBe("a");
    expect(r.accepted.get("0/M2")).toBe("b");
  });

  test("A accepted, then A is killed and B survives: the entry does not accept B", async () => {
    const ea = await entryFor(TWIN, [rowOf(TWIN, A), rowOf(TWIN, B)], "0/M1");
    const rows = [rowOf(TWIN, { ...A, verdict: "killed" }), rowOf(TWIN, B)];
    const r = await accept(TWIN, rows, [ea]);
    expect(r.accepted.size).toBe(0);
    expect(counted(report(rows), r).map((m) => m.mutantCode)).toEqual(["M2"]);
    expect(lines(r)).toContain("killed");
    expect(lines(r)).not.toContain("ambiguous");
  });
});

describe("PR-79: twins on one line differ by column", () => {
  const ONE = `codeunit 50100 "Poster"
{
    procedure Post(X: Integer)
    begin
        if (X > 0) or (X > 0) then
            Foo();
    end;
}
`;
  const A: Site = { needle: "X > 0", code: "M1" };
  const B: Site = { needle: "X > 0", nth: 1, code: "M2" };

  test("each is accepted by its own entry; killing A leaves B counted and the entry on A alone", async () => {
    const both = [rowOf(ONE, A), rowOf(ONE, B)];
    const ea = await entryFor(ONE, both, "0/M1", "a");
    const eb = await entryFor(ONE, both, "0/M2", "b");
    expect(eb.column - ea.column).toBe(11);
    expect(eb.lineInProcedure).toBe(ea.lineInProcedure);
    const r = await accept(ONE, both, [ea, eb]);
    expect([...r.accepted.keys()].sort()).toEqual(["0/M1", "0/M2"]);
    const rows = [rowOf(ONE, { ...A, verdict: "killed" }), rowOf(ONE, B)];
    const r2 = await accept(ONE, rows, [ea]);
    expect(r2.accepted.size).toBe(0);
    expect(counted(report(rows), r2).map((m) => m.mutantCode)).toEqual(["M2"]);
    expect(lines(r2)).toContain("killed");
    expect(lines(r2)).not.toContain("ambiguous");
  });
});

describe("PR-79: equivalence marks do not exempt, and the carry hide does not block", () => {
  test("a survivor with a readerMark on a changed line is still counted", async () => {
    const rows = [
      rowOf(POST, { ...M1, extra: { readerMark: { key: "k", reason: "equivalent" } } }),
    ];
    const r = await accept(POST, rows, []);
    expect(counted(report(rows), r).map((m) => m.mutantCode)).toEqual(["M1"]);
    expect(exitCodeForReport(report(rows), true, r)).toBe(9);
  });

  test("review 1 HIGH 2: the survivor's coarse tuple is in carryHidden.tuples and the entry still accepts it", async () => {
    const rows = [rowOf(POST, M1)];
    const e = await entryFor(POST, rows);
    const hidden = { tuples: ["h1|conditional-boundary|1"], files: [] };
    const rep = { ...report(rows), carryHidden: hidden };
    const rowCoarse = `${rows[0]?.astHash}|${rows[0]?.operatorName}|${rows[0]?.operatorMajor}`;
    expect(rep.carryHidden.tuples).toContain(rowCoarse); // the hide is present
    const r = await computeAcceptResult({ report: rep, snapshot: snap(POST), list: list([e]) });
    expect(r.accepted.get("0/M1")).toBe("fine");
  });
});

describe("PR-79: rows that cannot be anchored", () => {
  test("no procedure span: no entry, and it is named", async () => {
    const rows = [rowOf(POST, { ...M1, noSpan: true })];
    const r = await accept(POST, rows, undefined);
    expect(r.ready.get("0/M1")).toEqual({ cannot: expect.stringContaining("no procedure span") });
    const out = renderChangedLineSurvivors(changedLineSurvivors(report(rows), r) as never, r);
    expect(out).toContain("cannot be accepted: it has no procedure span");
    expect(out).not.toContain("to accept it");
  });

  test("a span outside the file gets no entry", async () => {
    const rows = [rowOf(POST, M1)];
    const bad = { ...rows[0], procedureEndLine: 999 } as unknown as MutantOutcome;
    const r = await accept(POST, [bad], undefined);
    expect(r.ready.get("0/M1")).toEqual({ cannot: expect.stringContaining("outside the file") });
  });

  test("an empty site never anchors (empty never matches empty)", async () => {
    const rows = [rowOf(POST, M1)];
    const empty = {
      ...rows[0],
      endIndex: rows[0]?.startIndex,
      originalText: "",
    } as unknown as MutantOutcome;
    const r = await accept(POST, [empty], undefined);
    expect(r.ready.get("0/M1")).toEqual({ cannot: expect.stringContaining("offsets") });
  });

  test("a row whose text is not the text at its offsets (a carried row) gets no entry", async () => {
    const rows = [rowOf(POST, M1)];
    const carried = { ...rows[0], originalText: "Y < 9" } as unknown as MutantOutcome;
    const r = await accept(POST, [carried], undefined);
    expect(r.ready.get("0/M1")).toEqual({ cannot: expect.stringContaining("original text") });
  });

  test("the re-parsed member's lines disagree with the row's: a loud refusal", async () => {
    const rows = [rowOf(POST, { ...M1, spanShift: 1 })];
    await expect(accept(POST, rows, undefined)).rejects.toThrow(AcceptListError);
    await expect(accept(POST, rows, undefined)).rejects.toThrow(/spans lines/);
  });
});

describe("PR-79: labels, one per entry", () => {
  test("an entry in a changed file whose site is not in the run: not-in-run, never re-opened", async () => {
    const e = await entryFor(POST, [rowOf(POST, M1)]);
    const rows = [rowOf(POST, { ...M1, nth: 1, proc: "Other", code: "M9" })];
    const r = await accept(POST, rows, [e]);
    expect(lines(r)).toContain("1 entries match no site of this run");
    expect(lines(r)).not.toContain("re-opened");
    expect(lines(r)).not.toContain("0/M9");
  });

  test("an accepted entry with another changed site in its procedure stays accepted, with no other label", async () => {
    const TWO = POST.replace(
      "exit(false);\n    end;\n\n    procedure Other",
      "if Y < 5 then\n            exit(false);\n        exit(false);\n    end;\n\n    procedure Other",
    );
    const rows = [rowOf(TWO, M1), rowOf(TWO, { needle: "Y < 5", code: "M2", hash: "h2" })];
    const e = await entryFor(TWO, rows);
    const r = await accept(TWO, rows, [e]);
    expect([...r.accepted.keys()]).toEqual(["0/M1"]);
    expect(r.entryLines).toEqual([]);
    expect(counted(report(rows), r).map((m) => m.mutantCode)).toEqual(["M2"]);
  });

  test("a negate entry whose row was killed, beside a surviving boundary row at the site: killed, never identity changed", async () => {
    const neg: Site = { ...M1, op: "negate-conditional", hash: "n1" };
    const bnd: Site = { ...M1, code: "M2", op: "conditional-boundary", hash: "b1" };
    const e = await entryFor(POST, [rowOf(POST, neg), rowOf(POST, bnd)]);
    const r = await accept(
      POST,
      [rowOf(POST, { ...neg, verdict: "killed" }), rowOf(POST, bnd)],
      [e],
    );
    expect(r.entryLines).toHaveLength(1);
    expect(lines(r)).toContain("killed");
    expect(lines(r)).not.toContain("identity changed");
  });

  test("killed and timeout-killed say remove; no-coverage and error say keep", async () => {
    const e = await entryFor(POST, [rowOf(POST, M1)]);
    for (const [verdict, text] of [
      ["killed", "a test now kills it"],
      ["timeout-killed", "a test now kills it"],
      ["no-coverage", "not measured this run"],
      ["error", "not measured this run"],
    ] as const) {
      const r = await accept(POST, [rowOf(POST, { ...M1, verdict })], [e]);
      expect(lines(r), verdict).toContain(text);
      expect(lines(r), verdict).toContain(
        text.startsWith("a test") ? "remove the entry" : "keep the entry",
      );
    }
  });

  test("identity changed: the same site, text and operator under a new astHash", async () => {
    const e = await entryFor(POST, [rowOf(POST, M1)]);
    const rows = [rowOf(POST, { ...M1, hash: "h2" })];
    const r = await accept(POST, rows, [e]);
    expect(lines(r)).toContain("identity changed");
    expect(lines(r)).toContain("not the code");
    expect(r.accepted.size).toBe(0);
  });

  test("a row of another operator at the same site never reads as identity changed", async () => {
    const e = await entryFor(POST, [rowOf(POST, M1)]);
    const rows = [rowOf(POST, { ...M1, op: "negate-conditional", hash: "h2" })];
    const r = await accept(POST, rows, [e]);
    expect(lines(r)).not.toContain("identity changed");
    expect(r.notInRun).toBe(1);
  });

  test("an ambiguous anchor: the entry is ambiguous and the survivors print 'cannot be accepted'", async () => {
    const e = await entryFor(POST, [rowOf(POST, M1)]);
    const rows = [rowOf(POST, M1), rowOf(POST, { ...M1, code: "M2" })];
    const r = await accept(POST, rows, [e]);
    expect(r.accepted.size).toBe(0);
    expect(lines(r)).toContain("ambiguous");
    const out = renderChangedLineSurvivors(changedLineSurvivors(report(rows), r) as never, r);
    expect(out).toContain("cannot be accepted: ambiguous");
    expect(out).not.toContain("to accept it");
  });
});

describe("PR-79: triggers are anchored with every enclosing declaration", () => {
  const body = (site: boolean) => (site ? "if X > 0 then Foo();" : "Foo();");
  const kinds: Array<[string, string, (a: string, b: string) => string]> = [
    [
      "a dataitem OnAfterGetRecord",
      "OnAfterGetRecord",
      (a, b) =>
        `report 50100 "Poster"\n{\n    dataset\n    {\n        dataitem(A; Item)\n        {\n            trigger OnAfterGetRecord()\n            begin\n                ${a}\n            end;\n        }\n        dataitem(B; Item)\n        {\n            trigger OnAfterGetRecord()\n            begin\n                ${b}\n            end;\n        }\n    }\n}\n`,
    ],
    [
      "an XMLport element trigger",
      "OnAfterAssignField",
      (a, b) =>
        `xmlport 50100 "Poster"\n{\n    schema\n    {\n        textelement(Root)\n        {\n            tableelement(T; Item)\n            {\n                fieldelement(FA; T."No.")\n                {\n                    trigger OnAfterAssignField()\n                    begin\n                        ${a}\n                    end;\n                }\n                fieldelement(FB; T.Name)\n                {\n                    trigger OnAfterAssignField()\n                    begin\n                        ${b}\n                    end;\n                }\n            }\n        }\n    }\n}\n`,
    ],
    [
      "an XMLport trigger whose inner headers are equal and only an outer element differs",
      "OnAfterAssignField",
      (a, b) =>
        `xmlport 50100 "Poster"\n{\n    schema\n    {\n        textelement(Root)\n        {\n            tableelement(T1; Item)\n            {\n                fieldelement(F; T."No.")\n                {\n                    trigger OnAfterAssignField()\n                    begin\n                        ${a}\n                    end;\n                }\n            }\n            tableelement(T2; Item)\n            {\n                fieldelement(F; T."No.")\n                {\n                    trigger OnAfterAssignField()\n                    begin\n                        ${b}\n                    end;\n                }\n            }\n        }\n    }\n}\n`,
    ],
    [
      "a modify(...) trigger",
      "OnAfterValidate",
      (a, b) =>
        `pageextension 50100 "Poster" extends "Item Card"\n{\n    layout\n    {\n        modify("No.")\n        {\n            trigger OnAfterValidate()\n            begin\n                ${a}\n            end;\n        }\n        modify(Name)\n        {\n            trigger OnAfterValidate()\n            begin\n                ${b}\n            end;\n        }\n    }\n}\n`,
    ],
    [
      "a field trigger with a wrapped header (the first lines are equal)",
      "OnValidate",
      (a, b) =>
        `table 50100 "Poster"\n{\n    fields\n    {\n        field(\n            1; "No."; Code[20])\n        {\n            trigger OnValidate()\n            begin\n                ${a}\n            end;\n        }\n        field(\n            2; Name; Code[20])\n        {\n            trigger OnValidate()\n            begin\n                ${b}\n            end;\n        }\n    }\n}\n`,
    ],
  ];
  for (const [name, trigger, make] of kinds) {
    test(`${name}: the body moved to the other container is not accepted`, async () => {
      const v1 = make(body(true), body(false));
      const v2 = make(body(false), body(true));
      const site: Site = { ...M1, trigger };
      const e = await entryFor(v1, [rowOf(v1, site)]);
      // not vacuous: the entry accepts its own site
      expect((await accept(v1, [rowOf(v1, site)], [e])).accepted.has("0/M1")).toBe(true);
      const rows = [rowOf(v2, site)];
      const r = await accept(v2, rows, [e]);
      expect(r.accepted.size).toBe(0);
      expect(counted(report(rows), r).length).toBe(1);
    });
  }

  test("field A's accepted trigger while field B's is edited: A is not re-opened, and B's entry is never named for A", async () => {
    const field = kinds.find(([n]) => n.startsWith("a field trigger"));
    const make = (a: string, b: string) => field?.[2](a, b) ?? "";
    const v1 = make(body(true), body(true));
    const site: Site = { ...M1, trigger: "OnValidate" };
    const a = rowOf(v1, site);
    const b = rowOf(v1, { ...site, nth: 1, code: "M2" });
    const e = await entryFor(v1, [a, b]);
    const v2 = make(body(true), "if X > 7 then Foo();");
    const edited = rowOf(v2, { ...site, needle: "X > 7", code: "M3" });
    const r = await accept(v2, [edited], [e]);
    expect(lines(r)).not.toContain("re-opened");
    expect(lines(r)).not.toContain("0/M3");
    expect(r.notInRun).toBe(1);
  });
});

describe("PR-79: parsing", () => {
  const good = {
    file: "src/Poster.al",
    tuple: "h1|Poster|Post|conditional-boundary|1",
    lineInProcedure: 3,
    column: 3,
    siteText: "a".repeat(64),
    procedureText: "b".repeat(64),
    reason: "fine",
  };
  const parse = (...e: unknown[]) => parseAcceptList(JSON.stringify({ accepted: e }), "f.json");

  test("a good entry parses; absent symbols read as []", () => {
    expect(parse(good)[0]).toMatchObject({ preprocessorSymbols: [], reason: "fine" });
  });
  test("refusals, each by name", () => {
    const bad: Array<[string, unknown, RegExp]> = [
      ["a missing field", { ...good, siteText: undefined }, /"siteText" is required/],
      [
        "the placeholder reason",
        { ...good, reason: ACCEPT_REASON_PLACEHOLDER },
        /"reason" is required/,
      ],
      ["an empty reason", { ...good, reason: "  " }, /"reason" is required/],
      ["bad hex", { ...good, procedureText: "XYZ" }, /"procedureText"/],
      ["a negative place", { ...good, lineInProcedure: -1 }, /"lineInProcedure"/],
      ["a negative column", { ...good, column: -2 }, /"column"/],
      ["a backslash path", { ...good, file: "src\\Poster.al" }, /"\/"/],
      ["a short tuple", { ...good, tuple: "a|b" }, /"tuple"/],
    ];
    for (const [name, entry, re] of bad) expect(() => parse(entry), name).toThrow(re);
    expect(() => parseAcceptList("{", "f.json")).toThrow(/not valid JSON/);
    expect(() => parseAcceptList("{}", "f.json")).toThrow(/"accepted" array/);
  });
  test("an identical duplicate and a duplicate with another reason are refused", () => {
    expect(() => parse(good, good)).toThrow(/same anchor/);
    expect(() => parse(good, { ...good, reason: "other" })).toThrow(/same anchor/);
    expect(() => parse(good, { ...good, file: "SRC/POSTER.AL", reason: "x" })).toThrow(
      /same anchor/,
    );
  });
  test("the same site under another symbol set is not a duplicate", () => {
    expect(parse(good, { ...good, preprocessorSymbols: ["X"] })).toHaveLength(2);
  });
});

describe("PR-79: the section", () => {
  test("no file: the path line is printed when survivors are counted, and not otherwise", async () => {
    const rows = [rowOf(POST, M1)];
    const r = await accept(POST, rows, undefined);
    const out = renderChangedLineSurvivors(changedLineSurvivors(report(rows), r) as never, r);
    expect(out).toContain(`no lethal.accepted.json at ${LIST_PATH}`);
    const none = await accept(POST, [rowOf(POST, { ...M1, verdict: "killed" })], undefined);
    const quiet = renderChangedLineSurvivors(
      changedLineSurvivors(report([rowOf(POST, { ...M1, verdict: "killed" })]), none) as never,
      none,
    );
    expect(quiet).not.toContain("no lethal.accepted.json");
  });

  test("round trip: the printed entry, pasted back with a reason, is accepted on the re-run", async () => {
    const rows = [rowOf(POST, M1)];
    const r = await accept(POST, rows, undefined);
    const out = renderChangedLineSurvivors(changedLineSurvivors(report(rows), r) as never, r);
    const printed = out.split("\n").find((l) => l.includes("to accept it"));
    expect(printed).toBeDefined();
    const json = (printed ?? "").slice((printed ?? "").indexOf("{"));
    const pasted = parseAcceptList(
      JSON.stringify({ accepted: [{ ...JSON.parse(json), reason: "reviewed" }] }),
      "pasted.json",
    );
    // the placeholder as printed is refused until a reason is written
    expect(() =>
      parseAcceptList(JSON.stringify({ accepted: [JSON.parse(json)] }), "pasted.json"),
    ).toThrow(/"reason"/);
    const again = await accept(POST, rows, pasted);
    expect(again.accepted.get("0/M1")).toBe("reviewed");
  });
});

describe("PR-79: runFromCli", () => {
  const setup = async (accepted: string | undefined) => {
    const root = await mkdtemp(join(tmpdir(), "lethal-pr79-"));
    const projectDir = join(root, "app");
    const testDir = join(root, "tests");
    await mkdir(join(projectDir, "src"), { recursive: true });
    await mkdir(testDir, { recursive: true });
    await writeFile(
      join(projectDir, "app.json"),
      JSON.stringify({
        id: "0f2b7c5e-4d3a-4917-8a1c-3b4a8d9f1027",
        name: "A",
        publisher: "L",
        version: "1.0.0.0",
        idRanges: [{ from: 79000, to: 79199 }],
      }),
    );
    await writeFile(join(projectDir, FILE), POST);
    if (accepted !== undefined) await writeFile(join(projectDir, "lethal.accepted.json"), accepted);
    await writeFile(join(root, "lethal.config.json"), "{}");
    const parsed: RunCliConfig = {
      mode: "run",
      projectDir,
      testDir,
      backendKind: "al-runner-v3",
      dbPath: ":memory:",
      configPath: join(root, "lethal.config.json"),
      skipKnownSurvivors: false,
      workers: 1,
      keepEnv: false,
      allowExpiringEnv: false,
      lines: [{ file: FILE, start: 1, end: 30 }],
    };
    return { root, parsed };
  };

  test("a malformed accept file stops the run BEFORE it starts", async () => {
    const { root, parsed } = await setup('{"accepted": [{"file": "src/Poster.al"}]}');
    try {
      let started = 0;
      await expect(
        runFromCliWithAccept(parsed, {
          validateSelectorIdsForProject: async () => {},
          buildBackend: async () => {
            started++;
            return {} as never;
          },
          runSession: async () => {
            started++;
            throw new Error("must not start");
          },
        }),
      ).rejects.toThrow(AcceptListError);
      expect(started).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the accept result comes back beside the report, computed from the run's snapshot", async () => {
    const rows = [rowOf(POST, M1)];
    const e = await entryFor(POST, rows);
    const { root, parsed } = await setup(JSON.stringify({ accepted: [e] }));
    try {
      const canned = {
        validity: { caveats: ["line-narrowed"] },
        buildSymbols: [],
        mutants: rows,
      } as unknown as SessionReport;
      const out = await runFromCliWithAccept(parsed, {
        validateSelectorIdsForProject: async () => {},
        buildBackend: async () => ({}) as never,
        runSession: async () => canned,
      });
      expect(out.report).toBe(canned);
      expect(out.accept?.fileFound).toBe(true);
      expect(out.accept?.accepted.get("0/M1")).toBe("fine");
      // the file edited on disk after the snapshot changes nothing: the text is the snapshot's
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a run with no line filter reads no accept file (even a malformed one)", async () => {
    const { root, parsed } = await setup("{ not json");
    try {
      const { lines: _lines, ...whole } = parsed;
      const canned = { validity: { caveats: [] }, mutants: [] } as unknown as SessionReport;
      const out = await runFromCliWithAccept(whole, {
        validateSelectorIdsForProject: async () => {},
        buildBackend: async () => ({}) as never,
        runSession: async () => canned,
      });
      expect(out.accept).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
