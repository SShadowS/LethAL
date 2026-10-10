import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openItemHangRefuses } from "@lethal/builtin-tier1";
import {
  type ALSyntaxNode,
  type SemanticContext,
  buildSemanticContext,
  initParser,
  parseAL,
  visit,
  wrapRoot,
} from "@lethal/engine";
import {
  type DependencyReportSourceRecord,
  dependencyReportReader,
} from "../src/dependency-report-source";
import type { RunEvent } from "../src/events";
import { generateMutationSet } from "../src/orchestrator";
import { foldEvents } from "../src/report-fold";
import { carryRecord } from "../src/selection";
import { buildFakeAppWithEntries } from "./helpers/fake-app";
import { scratchDirs } from "./helpers/scratch";

/**
 * R565: a report OUTSIDE the project is read from the dependency packages, so a call from the
 * project to its preset writer (R555's rule, R561's hazard) is refused. Every package here is built
 * in the test from minimal AL and JSON; nothing is copied from a real app. Each test names the
 * revert that turns it red; the red checks are recorded in /coord/handoff/R-565/build.md.
 */

const scratch = scratchDirs();
beforeAll(async () => {
  await initParser();
});

/** `Continue` is read by the open `Loop` item's exit guard; `SetContinue` writes it. */
const depRep = (view = "", writerBody = "Continue := V;") => `report 70000 "Dep Rep"
{
    dataset
    {
        dataitem(Loop; Integer)
        {
            ${view}
            trigger OnAfterGetRecord()
            begin
                if not Continue then
                    CurrReport.Break();
            end;
        }
    }

    procedure SetContinue(V: Boolean)
    begin
        ${writerBody}
    end;

    procedure Other()
    begin
    end;

    protected var
        Continue: Boolean;
}`;
/** Only open once the report counts as extended (R487). */
const CONST_VIEW = "DataItemTableView = where(Number = const(1));";

const DEP_EXT = `reportextension 70001 "Dep Ext" extends "Dep Rep"
{
    procedure SetFromExt()
    begin
        Continue := true;
    end;
}`;

const uses = (type = '"Dep Rep"') => `codeunit 50100 "Uses Dep"
{
    procedure Go(Flag: Boolean)
    var
        Rep: Report ${type};
    begin
        if Flag = true then
            Rep.SetContinue(true);
        Rep.Other();
        Rep.SetFromExt();
        Rep.RunModal();
    end;
}`;

interface Ident {
  readonly id: string;
  readonly name: string;
  readonly publisher: string;
  readonly version: string;
}
const BASE: Ident = {
  id: "437dbf0e-84ff-417a-965d-ed2bb9650972",
  name: "Base Application",
  publisher: "Microsoft",
  version: "28.5.1.0",
};
const OTHER: Ident = { ...BASE, id: "11111111-2222-3333-4444-555555555555", name: "Other App" };

const MANIFEST = (a: Ident) =>
  `<?xml version="1.0" encoding="utf-8"?><Package xmlns="http://schemas.microsoft.com/navx/2015/manifest"><App Id="${a.id}" Name="${a.name}" Publisher="${a.publisher}" Version="${a.version}" /></Package>`;

const REP_REF = "Warehouse/DepRep.Report.al";
const EXT_REF = "Manufacturing/DepExt.ReportExt.al";

/** A plain package: manifest, symbols (the extension under a namespace) and the given sources. */
function depApp(
  a: Ident,
  opts: {
    report?: string | null;
    ext?: string | null;
    extDeclared?: boolean;
    symbols?: boolean;
  } = {},
): Buffer {
  const report = opts.report === undefined ? depRep() : opts.report;
  const entries: [string, string][] = [["NavxManifest.xml", MANIFEST(a)]];
  if (opts.symbols !== false)
    entries.push([
      "SymbolReference.json",
      JSON.stringify({
        AppId: a.id,
        Reports: [{ Id: 70000, Name: "Dep Rep", ReferenceSourceFileName: REP_REF }],
        Namespaces: [
          {
            Name: "Microsoft",
            ReportExtensions:
              opts.ext !== undefined || opts.extDeclared === true
                ? [
                    {
                      Id: 70001,
                      Name: "Dep Ext",
                      Target: "Dep Rep",
                      ReferenceSourceFileName: EXT_REF,
                    },
                  ]
                : [],
          },
        ],
      }),
    ]);
  if (report !== null) entries.push([`src/${REP_REF}`, report]);
  if (opts.ext !== undefined && opts.ext !== null) entries.push([`src/${EXT_REF}`, opts.ext]);
  return buildFakeAppWithEntries(entries);
}

/** The measured ReadyToRun wrapper shape (al-runner's platform apps): no NavxManifest.xml of its
 *  own, a `readytorunappmanifest.json`, and ONE inner `<id hex>_<version>_28_28014.app`. */
function wrap(
  inner: Buffer,
  a: Ident,
  opts: {
    fileName?: string;
    entryName?: string;
    embedded?: Partial<Ident>;
    manifest?: boolean;
    extra?: [string, Buffer][];
  } = {},
): Buffer {
  const fileName = opts.fileName ?? `${a.id.replaceAll("-", "")}_${a.version}_28_28014.app`;
  const e = { ...a, ...opts.embedded };
  const entries: [string, string | Buffer][] = [];
  if (opts.manifest !== false)
    entries.push([
      "readytorunappmanifest.json",
      JSON.stringify({
        EmbeddedAppId: e.id,
        EmbeddedAppName: e.name,
        EmbeddedAppPublisher: e.publisher,
        EmbeddedAppVersion: e.version,
        EmbeddedAppFileName: fileName,
      }),
    ]);
  entries.push([opts.entryName ?? fileName, inner]);
  for (const x of opts.extra ?? []) entries.push(x);
  return buildFakeAppWithEntries(entries);
}

/** A folder holding the given packages, by file name. */
function folder(pkgs: Record<string, Buffer>): string {
  const d = scratch("lethal-r565-");
  for (const [name, buf] of Object.entries(pkgs)) writeFileSync(join(d, name), buf);
  return d;
}

/** The project (one codeunit) against `dirs`, asked through the dispatch hang refusal. */
function project(dirs: readonly string[], src = uses(), extra: Record<string, string> = {}) {
  const files = [
    { path: "c.al", root: wrapRoot(parseAL(src)) },
    ...Object.entries(extra).map(([path, s]) => ({ path, root: wrapRoot(parseAL(s)) })),
  ];
  const reader = dependencyReportReader(dirs);
  const ctx: SemanticContext = { ...buildSemanticContext(files), dependencyReport: reader.lookup };
  const find = (kind: string, text: string): ALSyntaxNode => {
    let hit: ALSyntaxNode | null = null;
    for (const f of files)
      visit(f.root, (n: ALSyntaxNode) => {
        if (hit === null && n.rawKind === kind && n.text === text) hit = n;
      });
    if (hit === null) throw new Error(`${kind} ${text} not found`);
    return hit;
  };
  return {
    refused: (text: string): boolean =>
      openItemHangRefuses(find("call_expression", text), ctx, undefined),
    records: (): DependencyReportSourceRecord[] => reader.records(),
  };
}

const SET = "Rep.SetContinue(true)";
const brief = (r: DependencyReportSourceRecord) =>
  `${r.kind} ${r.report ?? r.package} ${r.outcome}${r.version !== undefined ? ` ${r.version}` : ""}`;

describe("R565 test 1: a plain package with source", () => {
  // Red: crossWriters skips the lookup (`dep` undefined).
  test("the call to the dependency report's writer is refused; Rep.Other() is not", () => {
    const p = project([folder({ "Base.app": depApp(BASE) })]);
    expect(p.refused(SET)).toBe(true);
    expect(p.refused("Rep.Other()")).toBe(false);
    expect(p.records()).toEqual([
      {
        kind: "report",
        report: "dep rep",
        outcome: "ok",
        package: "Base.app",
        appId: BASE.id,
        version: BASE.version,
        entry: `src/${REP_REF}`,
        entrySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
  });
  test("control: with no package folder the call stays emitted and the report is not-found", () => {
    const p = project([]);
    expect(p.refused(SET)).toBe(false);
    expect(p.records().map(brief)).toEqual(["report dep rep not-found"]);
  });
  // Red: look the report up by name only (adversary F6).
  test("a `Report 70000` receiver is looked up by id", () => {
    const p = project([folder({ "Base.app": depApp(BASE) })], uses("70000"));
    expect(p.refused(SET)).toBe(true);
  });
  test("control: a report the project declares is not looked up outside", () => {
    const own = depRep().replace("70000", "50101");
    const p = project([], uses(), { "r.al": own });
    expect(p.refused(SET)).toBe(true);
    expect(p.records()).toEqual([]);
  });
});

describe("R565 test 2: a dependency reportextension's own writers", () => {
  // Red: read no extension of X (skip every `exts` entry).
  test("Rep.SetFromExt() is refused when the extension (in another app) is read", () => {
    const p = project([
      folder({
        "Base.app": depApp(BASE),
        "Other.app": buildFakeAppWithEntries([
          ["NavxManifest.xml", MANIFEST(OTHER)],
          [
            "SymbolReference.json",
            JSON.stringify({
              ReportExtensions: [
                { Name: "Dep Ext", Target: "Dep Rep", ReferenceSourceFileName: EXT_REF },
              ],
            }),
          ],
          [`src/${EXT_REF}`, DEP_EXT],
        ]),
      }),
    ]);
    expect(p.refused("Rep.SetFromExt()")).toBe(true);
    expect(p.records().map(brief)).toEqual([
      `extension dep rep ok ${OTHER.version}`,
      `report dep rep ok ${BASE.version}`,
    ]);
  });
});

describe("R565 test 3: every outside report counts as extended", () => {
  // Red: `reportExtended` ignores `ctx.allReportsExtended`.
  test("a const(1) item with an extension that has no source: the writer call is refused", () => {
    const p = project([
      folder({ "Base.app": depApp(BASE, { report: depRep(CONST_VIEW), extDeclared: true }) }),
    ]);
    expect(p.refused(SET)).toBe(true);
    expect(p.records().map(brief)).toEqual([
      `extension dep rep no-source ${BASE.version}`,
      `report dep rep ok ${BASE.version}`,
    ]);
  });
  test("and with no extension at all (the project or an installed app may extend it)", () => {
    const p = project([folder({ "Base.app": depApp(BASE, { report: depRep(CONST_VIEW) }) })]);
    expect(p.refused(SET)).toBe(true);
  });
  test("control: the same report in the PROJECT, not extended, is bounded: not refused", () => {
    const own = depRep(CONST_VIEW).replace("70000", "50101");
    expect(project([], uses(), { "r.al": own }).refused(SET)).toBe(false);
  });
});

describe("R565 test 4: the measured ReadyToRun wrapper", () => {
  // Red: never unwrap (a wrapper reads as `no-symbols`).
  test("is read through its one inner package, with the inner identity", () => {
    const p = project([folder({ "Microsoft_Base Application.app": wrap(depApp(BASE), BASE) })]);
    expect(p.refused(SET)).toBe(true);
    expect(p.records().map((r) => [r.outcome, r.package, r.appId, r.version])).toEqual([
      ["ok", "Microsoft_Base Application.app", BASE.id, BASE.version],
    ]);
  });
});

describe("R565 test 5: a wrapper not in the measured shape fails closed", () => {
  const inner = depApp(BASE);
  const innerName = `${BASE.id.replaceAll("-", "")}_${BASE.version}_28_28014.app`;
  const cases: [string, Buffer, string][] = [
    // Red: take the first inner entry blindly.
    [
      "two inner .app entries",
      wrap(inner, BASE, { extra: [["x_1.0.0.0.app", inner]] }),
      "unwrap-failed",
    ],
    // Red: drop the EmbeddedAppFileName name check.
    [
      "an inner entry not named EmbeddedAppFileName",
      wrap(inner, BASE, { entryName: "Other_1.app" }),
      "unwrap-failed",
    ],
    // Red: drop the identity comparison.
    [
      "an inner identity that differs from Embedded*",
      wrap(inner, BASE, { embedded: { version: "28.5.2.0" } }),
      "unwrap-failed",
    ],
    // Red: drop the inner SymbolReference.json check.
    [
      "an inner package without SymbolReference.json",
      wrap(depApp(BASE, { symbols: false }), BASE),
      "unwrap-failed",
    ],
    // Red: unwrap any package holding one inner .app (a file-name fallback).
    ["no wrapper manifest", wrap(inner, BASE, { manifest: false }), "no-symbols"],
    // Red: let a duplicate entry name through.
    ["one entry name twice", wrap(inner, BASE, { extra: [[innerName, inner]] }), "unreadable"],
  ];
  for (const [label, pkg, outcome] of cases)
    test(`${label}: ${outcome}, nothing read`, () => {
      const p = project([folder({ "W.app": pkg })]);
      expect(p.refused(SET)).toBe(false);
      expect(p.records().map(brief)).toEqual([
        `package W.app ${outcome}`,
        "report dep rep not-found",
      ]);
    });
  // Red: let a corrupt package throw out of the reader.
  test("a corrupt package is unreadable alone; the others are still read", () => {
    const p = project([folder({ "A.app": Buffer.from("not a zip"), "Base.app": depApp(BASE) })]);
    expect(p.refused(SET)).toBe(true);
    expect(p.records().map(brief)).toEqual([
      "package A.app unreadable",
      `report dep rep ok ${BASE.version}`,
    ]);
  });
});

const APP_JSON = JSON.stringify({
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  name: "T",
  publisher: "P",
  version: "1.0.0.0",
  idRanges: [{ from: 50000, to: 79999 }],
});

/** A project folder holding `uses()`; generation against `dirs`, with its warnings. */
async function generate(dirs: readonly string[] | undefined) {
  const dir = scratch("lethal-r565-proj-");
  writeFileSync(join(dir, "app.json"), APP_JSON);
  writeFileSync(join(dir, "Uses.Codeunit.al"), uses());
  const warnings: { code: string; message: string }[] = [];
  const set = await generateMutationSet(dir, {
    emit: (e) => {
      if (e.type === "warning") warnings.push({ code: e.code, message: e.message });
    },
    ...(dirs !== undefined ? { dependencyPackageDirs: dirs } : {}),
  });
  const line = 8; // `Rep.SetContinue(true);`
  const atLine = (set.files[0]?.specs ?? []).filter(
    (s) => s.before.startPosition.row + 1 === line,
  ).length;
  return { set, warnings, atLine };
}

describe("R565 test 6: no source, not found, ambiguous: a warning, a record, the mutant stays", () => {
  const unavailable = (w: { code: string; message: string }[]) =>
    w.filter((x) => x.code === "dependency-report-source-unavailable");
  test("control: with the source the call's line emits nothing", async () => {
    const got = await generate([folder({ "Base.app": depApp(BASE) })]);
    expect(got.atLine).toBe(0);
    expect(unavailable(got.warnings)).toEqual([]);
    expect(got.set.dependencyReportSources.map(brief)).toEqual([
      `report dep rep ok ${BASE.version}`,
    ]);
  });
  // Red: emit no warning for a lookup that is not ok.
  test("no-source", async () => {
    const got = await generate([folder({ "Base.app": depApp(BASE, { report: null }) })]);
    expect(got.atLine).toBeGreaterThan(0);
    expect(unavailable(got.warnings).map((w) => w.message)).toEqual([
      expect.stringContaining('report "dep rep": dependency source no-source in Base.app'),
    ]);
    expect(got.set.dependencyReportSources.map(brief)).toEqual([
      `report dep rep no-source ${BASE.version}`,
    ]);
  });
  test("not-found (no folder given)", async () => {
    const got = await generate(undefined);
    expect(got.atLine).toBeGreaterThan(0);
    expect(unavailable(got.warnings).length).toBe(1);
    expect(got.set.dependencyReportSources.map(brief)).toEqual(["report dep rep not-found"]);
  });
  // Red: use the first of two apps declaring the report.
  test("ambiguous (two app ids declare it): nothing is read", async () => {
    const got = await generate([folder({ "Base.app": depApp(BASE), "Other.app": depApp(OTHER) })]);
    expect(got.atLine).toBeGreaterThan(0);
    expect(got.set.dependencyReportSources).toEqual([
      { kind: "report", report: "dep rep", outcome: "ambiguous", package: "Base.app, Other.app" },
    ]);
    expect(unavailable(got.warnings).length).toBe(1);
  });
});

describe("R565 test 7: which package is read", () => {
  const v = (version: string) => ({ ...BASE, version });
  const noWriter = depRep("", "Message('none');");
  // Red: take the first package of an app (file-name order) instead of the highest version.
  test("the same app at two versions in one folder: the highest", () => {
    const p = project([
      folder({
        "A_28.5.1.0.app": depApp(v("28.5.1.0"), { report: noWriter }),
        "B_28.5.9.0.app": depApp(v("28.5.9.0")),
      }),
    ]);
    expect(p.refused(SET)).toBe(true);
    expect(p.records().map(brief)).toEqual(["report dep rep ok 28.5.9.0"]);
  });
  // Red: ignore folder priority (highest version anywhere).
  test("the first folder holding the app wins over a higher version later (adversary F3)", () => {
    const p = project([
      folder({ "Base.app": depApp(v("28.5.1.0")) }),
      folder({ "Base.app": depApp(v("29.0.0.0"), { report: noWriter }) }),
    ]);
    expect(p.refused(SET)).toBe(true);
    expect(p.records().map(brief)).toEqual(["report dep rep ok 28.5.1.0"]);
  });
});

describe("R565 review r1 fixes", () => {
  // Red: read the entry with no try (the corrupt entry throws out of generation).
  test("an entry that is listed but cannot be read is unreadable; nothing throws", () => {
    const pkg = depApp(BASE);
    const at = pkg.indexOf(Buffer.from(`src/${REP_REF}`));
    pkg.fill(0, at - 30, at - 26); // the entry's local header signature, its first occurrence
    const p = project([folder({ "Base.app": pkg })]);
    expect(p.refused(SET)).toBe(false);
    expect(p.records().map(brief)).toEqual([`report dep rep unreadable ${BASE.version}`]);
  });
  // Red: let a later folder's copy stand in for a refused first copy.
  test("a refused copy in the first folder blocks the same app id in a later folder", () => {
    const bad = wrap(depApp(BASE), BASE, { embedded: { version: "28.5.2.0" } });
    const p = project([folder({ "W.app": bad }), folder({ "Base.app": depApp(BASE) })]);
    expect(p.refused(SET)).toBe(false);
    const recs = p.records();
    expect(recs.map(brief)).toEqual([
      "package Base.app unwrap-failed",
      "package W.app unwrap-failed",
      "report dep rep not-found",
    ]);
    expect(recs[0]?.detail).toContain("copy in an earlier folder was refused");
  });
  test("control: a valid copy in the same first folder is still read", () => {
    const bad = wrap(depApp(BASE), BASE, { embedded: { version: "28.5.2.0" } });
    const p = project([folder({ "W.app": bad, "Base.app": depApp(BASE) })]);
    expect(p.refused(SET)).toBe(true);
  });
  // Red: record `ok` when the file declares no report of the symbols' name.
  test("a file that does not declare the report its symbols name is base-not-found, with a warning", async () => {
    const renamed = depRep().replace('"Dep Rep"', '"Renamed Rep"');
    const p = project([folder({ "Base.app": depApp(BASE, { report: renamed }) })]);
    expect(p.refused(SET)).toBe(false);
    expect(p.records().map(brief)).toEqual([`report dep rep base-not-found ${BASE.version}`]);
    const got = await generate([folder({ "Base.app": depApp(BASE, { report: renamed }) })]);
    expect(
      got.warnings.filter((w) => w.code === "dependency-report-source-unavailable").length,
    ).toBe(1);
  });
});

describe("R565 test 8: the digest covers the dependency entry's bytes", () => {
  // Red: leave `entrySha256` out of `recordLine`.
  test("a changed entry gives another digest; the same bytes the same one", async () => {
    const a = await generate([folder({ "Base.app": depApp(BASE) })]);
    const same = await generate([folder({ "Base.app": depApp(BASE) })]);
    const edited = await generate([
      folder({ "Base.app": depApp(BASE, { report: `${depRep()}\n// edited` }) }),
    ]);
    expect(same.set.dependencySourceSha256).toBe(a.set.dependencySourceSha256);
    expect(edited.set.dependencySourceSha256).not.toBe(a.set.dependencySourceSha256);
    // the source and the mutant set are unchanged: only the dependency moved
    expect(edited.atLine).toBe(a.atLine);
  });
});

describe("R565 test 9: carryRecord's rule 1 needs both digests, and null is never equal", () => {
  const m = {
    mutantId: "M0001",
    file: "Sample.Codeunit.al",
    startIndex: 10,
    endIndex: 20,
    startLine: 2,
    operatorName: "conditional-boundary",
    operatorVersion: "1.2.0",
    astHash: "abc123",
    objectType: "codeunit",
    codeunitId: 70000,
    codeunitName: "Sample",
    procedureName: "Post",
    originalText: "Original();",
    mutatedText: "",
  };
  const side = (dependencyHash: string | null) => ({ hash: "src", twins: null, dependencyHash });
  const carry = (rec: string | null, cur: string | null) =>
    carryRecord(
      m,
      side(rec),
      { ...side(cur), twins: new Set<string>(), refused: new Set<string>() },
      () => "carried",
      () => undefined,
    );
  test("control: both digests equal: carried", () => {
    expect(carry("d", "d")).toBe("carried");
  });
  // Red: drop the dependency digest from rule 1.
  test("another digest, or a recorded null (a run from before R565): not carried", () => {
    expect(carry("d", "e")).toBeUndefined();
    expect(carry(null, "d")).toBeUndefined();
  });
  // Red: compare with plain `===` (null equals null).
  test("null against null is not equal", () => {
    expect(carry(null, null)).toBeUndefined();
  });
});

describe("R565 test 10: the loader only reads", () => {
  // Red: write a file into a package folder from the reader.
  test("package folders keep their file lists and mtimes", async () => {
    const d = folder({ "Base.app": wrap(depApp(BASE), BASE), "Bad.app": Buffer.from("x") });
    mkdirSync(join(d, "sub"));
    const snap = () =>
      readdirSync(d, { recursive: true })
        .map(String)
        .sort()
        .map((f) => `${f} ${statSync(join(d, f)).mtimeMs}`);
    const before = snap();
    const got = await generate([d]);
    expect(got.atLine).toBe(0);
    expect(snap()).toEqual(before);
  });
});

describe("R565: the report fold", () => {
  const generated = (extra: Record<string, unknown>) =>
    ({
      type: "mutation-set-generated",
      siteCount: 0,
      deployedCount: 0,
      hangCapableCount: 0,
      totalFiles: 0,
      instrumentableFiles: 0,
      notInstrumentedFiles: [],
      declarativeSiteFiles: [],
      excludedByOnly: 0,
      excludedByExclude: 0,
      excludedByOperator: 0,
      ...extra,
    }) as unknown as RunEvent;
  const statics = {
    caps: { coverage: "none", deploy: "none", isolation: "process", authoritative: false },
  } as unknown as Parameters<typeof foldEvents>[0];
  // Red: drop the both-or-neither check. (The fields reaching the report: the runSession test in
  // r391-cross-file-twin.test.ts.)
  test("a stream carrying only one of the two fields is refused", () => {
    expect(() => foldEvents(statics, [generated({ dependencySourceSha256: "d" })])).toThrow(
      /only one of dependencyReportSources/,
    );
    expect(() => foldEvents(statics, [generated({ dependencyReportSources: [] })])).toThrow(
      /only one of dependencyReportSources/,
    );
  });
});
