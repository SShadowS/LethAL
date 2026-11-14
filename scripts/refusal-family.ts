#!/usr/bin/env bun
/**
 * PR-01 (process review item 5): a generator per refusal family. It emits one invented AL app whose cells are type x method x
 * state, each in its own test codeunit (a refusal in one test of a codeunit cascades to the tests after it), runs it on an
 * al-runner build, and lists every cell al-runner refuses, grouped into classes by its refusal text.
 *
 *   bun scripts/refusal-family.ts --family untouched-handle [--bin <al-runner>] [--out <dir>] [--json <report.json>]
 *
 * Each test only makes its call: a pass means the call returned, a fail that it raised an error (its message is kept), a
 * refusal that al-runner would not run it. What BC does in each cell is not known here (an error or a no-op): only a later BC
 * differential measures it, so the report lists refusals, never "differs from BC". A class is NEW when no text of the family's
 * upstream issue names it (`known`, by its stable part).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { V3_TIMEOUT_MESSAGE, isV3RefusalText } from "../packages/runner/src/al-runner-rows";

export interface Cell {
  readonly type: string;
  readonly method: string;
  readonly state: string;
  /** AL `var` lines the call needs (besides the handle). */
  readonly vars?: readonly string[];
  /** AL statements that put the handle in its state (none: untouched). */
  readonly setup?: readonly string[];
  /** The one AL statement under test. */
  readonly call: string;
}

export interface Family {
  readonly name: string;
  readonly issue: string;
  /** Stable parts of refusal texts the family's issue already names. */
  readonly known: readonly string[];
  /** AL objects the cells need besides the test codeunits (a table to open). */
  readonly support: string;
  /** The handle's declaration, per type. */
  readonly handles: Readonly<Record<string, string>>;
  readonly cells: readonly Cell[];
  /** PR-02: the app's `target` when the cells need one (DotNet needs `OnPrem`). */
  readonly target?: "OnPrem";
}

const untouched = (type: string, method: string, call: string, vars: string[] = []): Cell => ({
  type,
  method,
  state: "untouched",
  vars,
  call,
});
const closedRef = (method: string, call: string, vars: string[] = []): Cell => ({
  type: "RecordRef",
  method,
  state: "closed",
  vars,
  setup: ['RR.Open(Database::"Cell Row");', "RR.Close();"],
  call,
});

/** #7760's family: a handle used before anything assigned, created or opened it. */
export const UNTOUCHED_HANDLE: Family = {
  name: "untouched-handle",
  issue: "https://github.com/aldevtools/BusinessCentral.AL.Runner/issues/7760",
  known: [
    "an InStream was expected, got an untouched handle",
    "an OutStream was expected, got an untouched handle",
    "use of an InStream that was never created",
    "use of an OutStream that was never created",
    "RecordRef.FieldCount on a RecordRef that is not open",
    "FieldRef.Class on a FieldRef that was never assigned",
    "KeyRef.FieldCount on a KeyRef that was never assigned",
    "CopyStream from an untouched handle into a DotNet stream",
  ],
  support:
    'table 51000 "Cell Row"\n{\n    fields\n    {\n        field(1; "Code"; Code[10]) { }\n    }\n    keys { key(PK; "Code") { Clustered = true; } }\n}\n',
  handles: {
    InStream: "InS: InStream;",
    OutStream: "OutS: OutStream;",
    XmlElement: "E: XmlElement;",
    KeyRef: "K: KeyRef;",
    FieldRef: "FR: FieldRef;",
    RecordRef: "RR: RecordRef;",
  },
  cells: [
    untouched("InStream", "EOS", "B := InS.EOS();", ["B: Boolean;"]),
    untouched("InStream", "ReadText", "InS.ReadText(T);", ["T: Text;"]),
    untouched("InStream", "Read", "InS.Read(T);", ["T: Text;"]),
    untouched("InStream", "Length", "I := InS.Length();", ["I: BigInteger;"]),
    untouched("InStream", "Position", "I := InS.Position();", ["I: BigInteger;"]),
    untouched("InStream", "ResetPosition", "InS.ResetPosition();"),
    untouched("OutStream", "WriteText", "OutS.WriteText('x');"),
    untouched("OutStream", "Write", "OutS.Write('x');"),
    untouched("OutStream", "CopyStream", "CopyStream(OutS, InS);", ["InS: InStream;"]),
    untouched("XmlElement", "Name", "T := E.Name();", ["T: Text;"]),
    untouched("XmlElement", "InnerText", "T := E.InnerText();", ["T: Text;"]),
    untouched("XmlElement", "InnerXml", "T := E.InnerXml();", ["T: Text;"]),
    untouched("XmlElement", "Add", "E.Add(XmlText.Create('x'));"),
    untouched("XmlElement", "SetAttribute", "E.SetAttribute('a', 'b');"),
    untouched("XmlElement", "GetChildElements", "L := E.GetChildElements();", ["L: XmlNodeList;"]),
    untouched("XmlElement", "Attributes", "A := E.Attributes();", ["A: XmlAttributeCollection;"]),
    untouched("XmlElement", "AsXmlNode", "N := E.AsXmlNode();", ["N: XmlNode;"]),
    untouched("XmlElement", "WriteTo", "E.WriteTo(T);", ["T: Text;"]),
    untouched("KeyRef", "FieldCount", "I := K.FieldCount();", ["I: Integer;"]),
    untouched("KeyRef", "Active", "B := K.Active();", ["B: Boolean;"]),
    untouched("KeyRef", "FieldIndex", "F := K.FieldIndex(1);", ["F: FieldRef;"]),
    untouched("KeyRef", "Record", "R := K.Record();", ["R: RecordRef;"]),
    untouched("FieldRef", "Class", "C := FR.Class();", ["C: FieldClass;"]),
    untouched("FieldRef", "Name", "T := FR.Name();", ["T: Text;"]),
    untouched("FieldRef", "Number", "I := FR.Number();", ["I: Integer;"]),
    untouched("FieldRef", "Type", "Y := FR.Type();", ["Y: FieldType;"]),
    untouched("FieldRef", "Length", "I := FR.Length();", ["I: Integer;"]),
    untouched("FieldRef", "Caption", "T := FR.Caption();", ["T: Text;"]),
    untouched("FieldRef", "Value", "V := FR.Value();", ["V: Variant;"]),
    untouched("FieldRef", "SetRange", "FR.SetRange();"),
    untouched("FieldRef", "GetFilter", "T := FR.GetFilter();", ["T: Text;"]),
    untouched("FieldRef", "Active", "B := FR.Active();", ["B: Boolean;"]),
    untouched("FieldRef", "Relation", "I := FR.Relation();", ["I: Integer;"]),
    untouched("FieldRef", "Record", "R := FR.Record();", ["R: RecordRef;"]),
    untouched("RecordRef", "Number", "I := RR.Number();", ["I: Integer;"]),
    untouched("RecordRef", "Name", "T := RR.Name();", ["T: Text;"]),
    untouched("RecordRef", "FieldCount", "I := RR.FieldCount();", ["I: Integer;"]),
    untouched("RecordRef", "KeyCount", "I := RR.KeyCount();", ["I: Integer;"]),
    untouched("RecordRef", "FindSet", "B := RR.FindSet();", ["B: Boolean;"]),
    untouched("RecordRef", "FindFirst", "B := RR.FindFirst();", ["B: Boolean;"]),
    untouched("RecordRef", "IsEmpty", "B := RR.IsEmpty();", ["B: Boolean;"]),
    untouched("RecordRef", "Count", "I := RR.Count();", ["I: Integer;"]),
    untouched("RecordRef", "SetRecFilter", "RR.SetRecFilter();"),
    untouched("RecordRef", "GetFilters", "T := RR.GetFilters();", ["T: Text;"]),
    untouched("RecordRef", "ReadPermission", "B := RR.ReadPermission();", ["B: Boolean;"]),
    untouched("RecordRef", "WritePermission", "B := RR.WritePermission();", ["B: Boolean;"]),
    untouched("RecordRef", "Close", "RR.Close();"),
    untouched("RecordRef", "IsTemporary", "B := RR.IsTemporary();", ["B: Boolean;"]),
    untouched("RecordRef", "Reset", "RR.Reset();"),
    untouched("RecordRef", "Field", "F := RR.Field(1);", ["F: FieldRef;"]),
    untouched("RecordRef", "KeyIndex", "K := RR.KeyIndex(1);", ["K: KeyRef;"]),
    untouched("RecordRef", "Caption", "T := RR.Caption();", ["T: Text;"]),
    untouched("RecordRef", "Init", "RR.Init();"),
    untouched("RecordRef", "SetLoadFields", "RR.SetLoadFields(1);"),
    closedRef("Number", "I := RR.Number();", ["I: Integer;"]),
    closedRef("FieldCount", "I := RR.FieldCount();", ["I: Integer;"]),
    closedRef("FindSet", "B := RR.FindSet();", ["B: Boolean;"]),
    closedRef("IsEmpty", "B := RR.IsEmpty();", ["B: Boolean;"]),
    closedRef("Field", "F := RR.Field(1);", ["F: FieldRef;"]),
  ],
};

const noObject = (type: string, method: string, call: string, vars: string[] = []): Cell => ({
  type,
  method,
  state: "no object",
  vars,
  call,
});

/**
 * PR-02, #8036's family: a member of a DotNet variable that holds no object (declared, never constructed or assigned; a mutant
 * that removes the line making the object leaves exactly this), over .NET types BC apps use. Properties and methods; each
 * statement only makes the one access.
 */
export const DOTNET_NO_OBJECT: Family = {
  name: "dotnet-no-object",
  issue: "https://github.com/aldevtools/BusinessCentral.AL.Runner/issues/8036",
  target: "OnPrem",
  known: [
    // #8036 item 1, as worded upstream now (still a refusal): a member of a DotNet variable that holds no object (Uri.AbsoluteUri, UriBuilder.Query).
    "DotNet System.Uri.AbsoluteUri: 'System.Uri.AbsoluteUri' is an instance member and the variable holds no object",
  ],
  support: `dotnet
{
    assembly(System)
    {
        type(System.Uri; GenUri) { }
        type(System.UriBuilder; GenUriBuilder) { }
        type(System.Text.RegularExpressions.Regex; GenRegex) { }
    }
    assembly(mscorlib)
    {
        type(System.Text.StringBuilder; GenStringBuilder) { }
        type(System.TimeZoneInfo; GenTimeZoneInfo) { }
        type(System.Globalization.CultureInfo; GenCultureInfo) { }
        type(System.IO.MemoryStream; GenMemoryStream) { }
        type(System.Text.Encoding; GenEncoding) { }
    }
    assembly(System.Xml)
    {
        type(System.Xml.XmlDocument; GenXmlDocument) { }
    }
}
`,
  handles: {
    Uri: "U: DotNet GenUri;",
    UriBuilder: "UB: DotNet GenUriBuilder;",
    Regex: "RX: DotNet GenRegex;",
    StringBuilder: "SB: DotNet GenStringBuilder;",
    TimeZoneInfo: "Z: DotNet GenTimeZoneInfo;",
    CultureInfo: "CI: DotNet GenCultureInfo;",
    MemoryStream: "MS: DotNet GenMemoryStream;",
    Encoding: "EN: DotNet GenEncoding;",
    XmlDocument: "XD: DotNet GenXmlDocument;",
  },
  cells: [
    noObject("Uri", "AbsoluteUri", "T := U.AbsoluteUri;", ["T: Text;"]),
    noObject("Uri", "Host", "T := U.Host;", ["T: Text;"]),
    noObject("Uri", "Port", "I := U.Port;", ["I: Integer;"]),
    noObject("Uri", "IsAbsoluteUri", "B := U.IsAbsoluteUri;", ["B: Boolean;"]),
    noObject("Uri", "ToString", "T := U.ToString();", ["T: Text;"]),
    noObject("UriBuilder", "Query", "T := UB.Query;", ["T: Text;"]),
    noObject("UriBuilder", "Host", "T := UB.Host;", ["T: Text;"]),
    noObject("UriBuilder", "ToString", "T := UB.ToString();", ["T: Text;"]),
    noObject("Regex", "IsMatch", "B := RX.IsMatch('a');", ["B: Boolean;"]),
    noObject("Regex", "Replace", "T := RX.Replace('a', 'b');", ["T: Text;"]),
    noObject("Regex", "ToString", "T := RX.ToString();", ["T: Text;"]),
    noObject("StringBuilder", "Append", "SB.Append('x');"),
    noObject("StringBuilder", "ToString", "T := SB.ToString();", ["T: Text;"]),
    noObject("StringBuilder", "Length", "I := SB.Length;", ["I: Integer;"]),
    noObject("StringBuilder", "Clear", "SB.Clear();"),
    noObject("TimeZoneInfo", "Id", "T := Z.Id;", ["T: Text;"]),
    noObject("TimeZoneInfo", "DisplayName", "T := Z.DisplayName;", ["T: Text;"]),
    noObject("TimeZoneInfo", "GetUtcOffset", "Z.GetUtcOffset(CurrentDateTime());"),
    noObject("CultureInfo", "Name", "T := CI.Name;", ["T: Text;"]),
    noObject("CultureInfo", "DisplayName", "T := CI.DisplayName;", ["T: Text;"]),
    noObject("CultureInfo", "ToString", "T := CI.ToString();", ["T: Text;"]),
    noObject("MemoryStream", "Length", "L := MS.Length;", ["L: BigInteger;"]),
    noObject("MemoryStream", "Position", "L := MS.Position;", ["L: BigInteger;"]),
    noObject("MemoryStream", "Close", "MS.Close();"),
    noObject("Encoding", "WebName", "T := EN.WebName;", ["T: Text;"]),
    noObject("Encoding", "EncodingName", "T := EN.EncodingName;", ["T: Text;"]),
    noObject("XmlDocument", "OuterXml", "T := XD.OuterXml;", ["T: Text;"]),
    noObject("XmlDocument", "InnerText", "T := XD.InnerText;", ["T: Text;"]),
    noObject("XmlDocument", "LoadXml", "XD.LoadXml('<a/>');"),
  ],
};

export const FAMILIES: Readonly<Record<string, Family>> = {
  [UNTOUCHED_HANDLE.name]: UNTOUCHED_HANDLE,
  [DOTNET_NO_OBJECT.name]: DOTNET_NO_OBJECT,
};

/** The first codeunit id; cell i is `BASE + 1 + i`. */
export const BASE_ID = 51000;

/** A cell's test codeunit name (AL caps object names at 30). */
export function cellName(c: Cell, i: number): string {
  return `C${i} ${c.type} ${c.method} ${c.state === "untouched" ? "" : c.state}`
    .trim()
    .slice(0, 30);
}

/** The app's files: app.json and one .al file with the support objects and one test codeunit per cell. */
export function emitApp(f: Family): Record<string, string> {
  const units = f.cells.map((c, i) => {
    const vars = [f.handles[c.type], ...(c.vars ?? [])].filter((v) => v !== undefined);
    const body = [...(c.setup ?? []), c.call].map((s) => `        ${s}`).join("\n");
    return `codeunit ${BASE_ID + 1 + i} "${cellName(c, i)}"
{
    Subtype = Test;

    [Test]
    procedure Cell()
    var
${vars.map((v) => `        ${v}`).join("\n")}
    begin
${body}
    end;
}
`;
  });
  return {
    "app.json": `${JSON.stringify(
      {
        id: "51000000-0000-4000-8000-000000051000",
        name: `Refusal Family ${f.name}`,
        publisher: "LethAL Repro",
        version: "1.0.0.0",
        platform: "28.0.0.0",
        runtime: "17.0",
        ...(f.target !== undefined ? { target: f.target } : {}),
        idRanges: [{ from: BASE_ID, to: BASE_ID + 1 + f.cells.length }],
        features: ["NoImplicitWith"],
      },
      null,
      2,
    )}\n`,
    "src/Cells.al": `// Generated by scripts/refusal-family.ts (PR-01), family ${f.name}: invented, no corpus source text.\n${f.support}\n${units.join("\n")}`,
  };
}

export type Outcome = "pass" | "fail" | "refused" | "timeout" | "missing";

export interface CellResult {
  readonly cell: Cell;
  readonly outcome: Outcome;
  readonly message?: string;
}

/** The refusal text of a row: what follows v3's marker (wherever it stands), without a trailing ` (not pinned)`. */
export function refusalText(message: string): string {
  const at = message.indexOf("NotRun: out-of-scope: ");
  return (at >= 0 ? message.slice(at + "NotRun: out-of-scope: ".length) : message)
    .replace(/ \(not pinned\)$/, "")
    .trim();
}

/** Each cell's outcome from the run's rows (`Codeunit<id>.Cell`). A cell with no row is `missing`, never a pass. */
export function classify(
  f: Family,
  rows: ReadonlyArray<{ name: string; status: string; message?: string; notRun?: boolean }>,
): CellResult[] {
  const byName = new Map(rows.map((r) => [r.name, r]));
  return f.cells.map((cell, i) => {
    const r = byName.get(`Codeunit${BASE_ID + 1 + i}.Cell`);
    if (r === undefined) return { cell, outcome: "missing" };
    // A stopped test is neither a refusal nor a score.
    if (r.notRun === true && V3_TIMEOUT_MESSAGE.test(r.message ?? ""))
      return {
        cell,
        outcome: "timeout",
        ...(r.message !== undefined ? { message: r.message } : {}),
      };
    // Review: v3's refusal marker ANYWHERE in the message is a refusal, with or without `notRun` (R675).
    if (r.notRun === true || isV3RefusalText(r.message))
      return { cell, outcome: "refused", message: refusalText(r.message ?? "") };
    if (r.status === "pass") return { cell, outcome: "pass" };
    return { cell, outcome: "fail", ...(r.message !== undefined ? { message: r.message } : {}) };
  });
}

/**
 * A refusal's class: its text up to the first `: ` (the reason's explanation is dropped), with a leading `Type.Method` made
 * `Type.*`, since al-runner names the method in each text ("RecordRef.FindSet on a RecordRef that is not open" and
 * "RecordRef.FieldCount on a RecordRef that is not open" are one class).
 */
export function classOf(text: string): string {
  // PR-02: a DotNet member's text names the member twice and the cause after it; the cause is the class.
  const dotnet = /^DotNet [\w.]+: '[\w.]+' (.*)$/.exec(text);
  if (dotnet) return `DotNet *: ${dotnet[1]}`;
  const head = text.split(": ")[0] ?? text;
  return head.replace(/^([A-Za-z]+)\.[A-Za-z]+ on /, "$1.* on ").trim();
}

/** Refused cells grouped by their class; `known` marks a class the family's issue already names. */
export function refusalClasses(
  f: Family,
  results: readonly CellResult[],
): { text: string; known: boolean; cells: string[] }[] {
  const known = new Set(f.known.map(classOf));
  const groups = new Map<string, string[]>();
  for (const r of results) {
    if (r.outcome !== "refused") continue;
    const k = classOf(r.message ?? "");
    groups.set(k, [...(groups.get(k) ?? []), `${r.cell.type}.${r.cell.method} (${r.cell.state})`]);
  }
  return [...groups.entries()]
    .map(([text, cells]) => ({ text, known: known.has(text), cells }))
    .sort((a, b) => Number(a.known) - Number(b.known) || a.text.localeCompare(b.text));
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const f = FAMILIES[opt("--family") ?? ""];
  if (f === undefined)
    throw new Error(
      `usage: refusal-family.ts --family ${Object.keys(FAMILIES).join("|")} [--bin <al-runner>] [--out <dir>] [--json <file>]`,
    );
  const bin = opt("--bin") ?? "/work/tools/al-runner-v3/current/al-runner";
  const dir = opt("--out") ?? mkdtempSync(join(tmpdir(), "refusal-family-"));
  for (const [file, text] of Object.entries(emitApp(f))) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  const p = Bun.spawnSync([bin, "test", "--bc-version", "28", "--output-json", dir], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ALRUNNER_SEED: "1" },
    timeout: 600_000,
  });
  let j: {
    tests?: { name: string; status: string; message?: string; notRun?: boolean }[];
    compilationErrors?: unknown[];
  };
  try {
    j = JSON.parse(p.stdout.toString());
  } catch (err) {
    throw new Error(
      `al-runner gave no JSON (exit ${p.exitCode}${p.exitedDueToTimeout === true ? ", timed out after 600 s" : ""}): ${String(err)}; stderr: ${p.stderr.toString().slice(-500)}`,
    );
  }
  if ((j.compilationErrors ?? []).length > 0 || !Array.isArray(j.tests) || j.tests.length === 0)
    throw new Error(
      `the generated app did not run (exit ${p.exitCode}): ${JSON.stringify(j.compilationErrors ?? []).slice(0, 2000)}`,
    );
  const results = classify(f, j.tests);
  const n = (o: Outcome) => results.filter((r) => r.outcome === o).length;
  console.log(
    `family ${f.name} on ${bin}: ${results.length} cells: pass ${n("pass")}, fail ${n("fail")}, refused ${n("refused")}, missing ${n("missing")} (app in ${dir})`,
  );
  for (const c of refusalClasses(f, results))
    console.log(
      `${c.known ? "known" : "NEW  "} ${c.cells.length} cell(s): ${c.text}\n        ${c.cells.join(", ")}`,
    );
  for (const r of results.filter((x) => x.outcome === "missing" || x.outcome === "timeout"))
    console.log(`${r.outcome.toUpperCase()}: ${r.cell.type}.${r.cell.method} (${r.cell.state})`);
  for (const r of results.filter((x) => x.outcome === "fail"))
    console.log(
      `fail: ${r.cell.type}.${r.cell.method} (${r.cell.state}): ${(r.message ?? "").slice(0, 160)}`,
    );
  const json = opt("--json");
  if (json !== undefined) writeFileSync(json, `${JSON.stringify(results, null, 2)}\n`);
  // A cell with no row means the run did not cover the family: not a result to read.
  if (n("missing") > 0) process.exitCode = 2;
}
