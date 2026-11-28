/**
 * PR-492: rank al-runner v3's refusal families (each mapped to its upstream issue) by what they cost a real run, so
 * alrunner can order fixes by value. Built on PR-490's join (`scripts/bc-v3-join.ts`).
 *
 *   bun scripts/v3-refusal-cost.ts run --name <label> --v3 <report.json> --v3-store <db> [--bc <report.json> ...]
 *                                     --out <costs.json>
 *   bun scripts/v3-refusal-cost.ts render --out <priority.md> --unmapped-out <private.txt> <costs.json> [...]
 *
 * Per family, for one v3 run:
 * - `testsRefused`: tests not run at v3's baseline (the store's latest run) with that family's refusal text;
 * - `errorMutants`: mutants whose final v3 verdict is `error` because of this family's refusal of the MUTANT itself
 *   (its own note matches; a non-refusal error note is not counted);
 * - `cascadeErrors`: mutants v3 ends as `error` because an EARLIER test of the codeunit was refused while it ran: the
 *   note names that test by method, and the error is credited to that test's own family (not to whatever the note's
 *   truncated quote happens to match);
 * - with BC reports (joined on the full site key), over the joined keys only:
 *   - `killsLost`: BC killed it, and BC's killing test is refused at v3's baseline with that family's text;
 *   - `reachedOnlyByRefused`: every one of BC's covering tests is refused on v3, at least one by this family (a mutant
 *     reached by tests of two families counts in both).
 * Ranked by killsLost + errorMutants + cascadeErrors, then testsRefused. Families mapped to no issue are listed as `unmapped` with a
 * normalised text, so a new class is never silently dropped. `render` writes counts, issue numbers and family labels
 * only: no project source, object, file or test name, so the file can go to alrunner.
 */

import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { SessionReport } from "../packages/runner/src/report";
import { resolveKiller, scoredVerdict, siteKey } from "./bc-v3-join.ts";
import { loadReport } from "./report-summary.ts";

export interface Family {
  readonly id: string;
  /** upstream issue (`#nnnn`), or why there is none (`by design`, `LethAL`, `culture`) */
  readonly issue: string;
  readonly label: string;
  readonly pattern: RegExp;
}

/** Order matters: the first match wins, so the narrower text comes first. */
export const FAMILIES: readonly Family[] = [
  {
    id: "deferred-duplicate-insert",
    issue: "#8267",
    label:
      "a duplicate-key Insert still deferred when a test under a non-default TransactionModel ends",
    pattern: /error of a duplicate-key Insert .* is deferred/,
  },
  {
    id: "xml-attribute-collection",
    issue: "#8486",
    label: "an XmlAttributeCollection method on something else",
    pattern: /XmlAttributeCollection method/,
  },
  {
    id: "xml-readfrom",
    issue: "#8257",
    label: "XmlDocument.ReadFrom of something that is not a created InStream",
    pattern: /XmlDocument\.ReadFrom of/,
  },
  {
    id: "isolated-storage",
    issue: "#8036",
    label: "IsolatedStorage.Get of a missing Guid key",
    pattern: /IsolatedStorage\.Get of a missing Guid key/,
  },
  {
    id: "unpinned-error-text",
    issue: "by design",
    label: "the test result of an error whose text is not pinned (ADR-059)",
    pattern: /error whose text is not pinned/,
  },
  // PR-493: the five families PR-492 left unfiled, each found filed upstream (searched read-only; the refusal text of
  // the first cites its issue itself), so none needed a new repro.
  {
    id: "subscriber-by-id",
    issue: "#8470",
    label: "an event subscriber bound to its publisher by object id",
    pattern: /subscribes to its publisher by the id/,
  },
  {
    id: "gotokey-descending",
    issue: "#8172",
    label: "GoToKey on a list opened on the last row of a descending view",
    pattern: /GoToKey on a list/,
  },
  {
    id: "datacaption-no-source",
    issue: "#8004",
    label: "the caption of a page with DataCaptionExpression and no source table",
    pattern: /DataCaptionExpression and no source table/,
  },
  {
    id: "text-to-blob",
    issue: "#8213",
    label: "a conversion of Text to Blob (through a FieldRef)",
    pattern: /conversion of Text .* to Blob/,
  },
  {
    // #8203 is the "no collation weight" family; a non-Latin letter's order is collation data, which on Linux BC is
    // culture data (R1210), so its BC answer is not a filing reason by itself
    id: "collation-no-weight",
    issue: "#8203",
    label: "ordering of a character with no collation weight (collation data)",
    pattern: /no collation weight/,
  },
  {
    id: "number-sequence",
    issue: "#8002",
    label:
      "an earlier test changed a number sequence that existed before it (TestIsolation = Function rollback not measured)",
    // #8002 covers both forms: a NumberSequence or an IsolatedStorage key that existed before the test
    pattern: /changed (number sequence|IsolatedStorage key)/,
  },
  {
    id: "relationfieldno",
    issue: "#8592",
    label: "Field.RelationFieldNo of a TableRelation without a field, unmeasured shape",
    pattern: /RelationFieldNo/,
  },
  {
    id: "saveas-pdf-tree",
    issue: "#9266",
    label: "Report.SaveAs as Pdf, data items another tree / one inside one",
    pattern: /SaveAs as Pdf .*(another tree|one inside one)/,
  },
  {
    id: "decimal-overflow",
    issue: "#9267",
    label: "Decimal arithmetic overflow",
    pattern: /decimal overflow/,
  },
  {
    id: "filter-number-field",
    issue: "#9263",
    label: "SetRange/SetFilter of a non-numeric Code/Text into a number field",
    pattern: /SetRange or SetFilter of (Code|Text) .* into a \w+ field/,
  },
  {
    id: "integer-to-date",
    issue: "#9264",
    label: "conversion of Integer to Date",
    pattern: /conversion of Integer -?\d+ to Date/,
  },
  {
    id: "fieldref-unassigned-setfilter",
    issue: "#7964",
    label: "FieldRef.SetFilter on an unassigned FieldRef",
    pattern: /FieldRef\.SetFilter on a FieldRef that was never assigned/,
  },
  {
    id: "fieldref-enumvaluecount",
    issue: "#8255",
    label: "FieldRef.EnumValueCount on an unassigned FieldRef",
    pattern: /FieldRef\.EnumValueCount/,
  },
  {
    id: "untouched-handle",
    issue: "#7760",
    label: "untouched or uncreated stream/handle, unassigned FieldRef, undeclared report id",
    pattern: /untouched handle|never created|never assigned|which no report declares/,
  },
  {
    id: "setfilter-value-expected",
    issue: "#8213",
    label: "SetFilter value expected after `..`",
    pattern: /SetFilter: value expected after/,
  },
  {
    // #8219's title names it: "Evaluate of a comparison filter into Decimal"
    id: "evaluate-comparison-decimal",
    issue: "#8219",
    label: "Evaluate of a comparison filter into Decimal",
    pattern: /Evaluate of .* into Decimal/,
  },
  {
    id: "setfilter-empty-term",
    issue: "#7764",
    label: "SetFilter empty filter term",
    pattern: /SetFilter: empty filter term/,
  },
  {
    id: "format-region",
    issue: "#8094",
    label: "Format under CurrReport.FormatRegion",
    pattern: /FormatRegion/,
  },
  {
    id: "recordref-not-open",
    issue: "#8254",
    label: "RecordRef method on a RecordRef that is not open; Page.Run with RecordRef",
    pattern: /on a RecordRef that is not open|Page\.Run with RecordRef/,
  },
  {
    id: "json-writer",
    issue: "#8219",
    label: "Newtonsoft JsonTextWriter exceptions; Boolean/Code to BigInteger conversions",
    pattern: /JsonTextWriter|JsonWriterException|conversion of (Boolean|Code) .* to BigInteger/,
  },
  {
    id: "zip-archive",
    issue: "#7924",
    label: ".NET ZipArchive exceptions and writes over an AL stream",
    pattern: /ZipArchive/,
  },
  {
    id: "saveas-error-calcfield",
    issue: "#8486",
    label:
      "an error inside SaveAs of a report with a layout/extension; FieldRef.CalcField of a non-FlowField",
    pattern: /an error in a SaveAs of report|FieldRef\.CalcField/,
  },
  {
    id: "rowversion",
    issue: "#8993",
    label: "SystemRowVersion of a row the open transaction inserted",
    pattern: /SystemRowVersion/,
  },
  {
    id: "page-row-state",
    issue: "#7821",
    label: "a page action leaving another row, or a list losing its only row",
    pattern: /action left another row|lost its only row/,
  },
  {
    id: "parameters-xml",
    issue: "#7908",
    label: "request-page parameters without the XML declaration form",
    pattern: /parameters string without the XML declaration/,
  },
  {
    id: "xml-element",
    issue: "#8036",
    label: "an unassigned XmlElement",
    pattern: /unassigned XmlElement/,
  },
  {
    id: "xml-node",
    issue: "#8084",
    label: "an unassigned XmlNode; XmlNode as XML content; CalcDate out of range",
    pattern: /unassigned XmlNode|XmlNode as XML content|CalcDate result outside/,
  },
  {
    id: "by-value-view",
    issue: "#8596",
    label: "Record.SetFilter on a record handed by value, unmeasured view",
    pattern: /a record handed by value/,
  },
  {
    id: "http",
    issue: "by design",
    label: "an outbound HTTP request no handler answers (ADR-027)",
    pattern: /outbound HTTP request/,
  },
  {
    id: "download",
    issue: "by design",
    label: "File.DownloadFromStream needs a client",
    pattern: /DownloadFromStream/,
  },
  {
    id: "placeholder-pdf",
    issue: "by design",
    label: "reading a placeholder Pdf's content",
    pattern: /placeholder Pdf/,
  },
  {
    id: "reach-cascade",
    issue: "LethAL",
    label: "a cascade: part of a test's reach is not known",
    pattern: /reach is not known|reach not known/,
  },
  {
    id: "testpage",
    issue: "LethAL",
    label: "a TestPage refused in the fenced session",
    pattern: /TestPage/,
  },
  {
    id: "culture",
    issue: "culture",
    label: "words of another GlobalLanguage",
    pattern: /GlobalLanguage/,
  },
];

/** A refusal text's family; `unmapped:<normalised text>` when no family matches; null when it is not a refusal. */
export function familyOf(text: string): string | null {
  // a known family counts even without the NotRun marker (LethAL's reach cascades carry none)
  const f = FAMILIES.find((x) => x.pattern.test(text));
  if (f !== undefined) return f.id;
  if (!/NotRun|out-of-scope|not run/i.test(text)) return null;
  const norm = text
    .replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "<x>")
    .replace(/\d+/g, "N")
    .replace(/\s+/g, " ")
    .slice(0, 120);
  return `unmapped:${norm}`;
}

export interface FamilyCost {
  testsRefused: number;
  errorMutants: number;
  cascadeErrors: number;
  killsLost: number;
  reachedOnlyByRefused: number;
}
const ZERO: FamilyCost = {
  testsRefused: 0,
  errorMutants: 0,
  cascadeErrors: 0,
  killsLost: 0,
  reachedOnlyByRefused: 0,
};
/** LethAL's cascade note: an earlier test of the codeunit, named by method, was refused while it ran. */
const CASCADE = /an earlier test of this codeunit was refused while it ran \(([^:()]+): /;
export interface RunCost {
  readonly name: string;
  readonly v3Mutants: number;
  readonly joined: number;
  readonly families: Record<string, FamilyCost>;
}

/** The latest run's baseline rows that did not pass, with their messages, as `<codeunit>.<method>` -> message. */
export function baselineRefusals(storePath: string): Map<string, string> {
  const db = new Database(storePath, { readonly: true });
  try {
    const rows = db
      .query(
        "select codeunit_name as c, method as m, coalesce(failure_message, '') as f from test_results where mutant_row_id is null and outcome <> 'pass' and run_id = (select max(run_id) from test_results where mutant_row_id is null)",
      )
      .all() as { c: string | null; m: string; f: string }[];
    const out = new Map<string, string>();
    for (const r of rows) {
      if (r.c === null)
        throw new Error(`${storePath}: a baseline row for ${r.m} has no codeunit name`);
      out.set(`${r.c}.${r.m}`, r.f);
    }
    return out;
  } finally {
    db.close();
  }
}

type M = SessionReport["mutants"][number] & {
  failureNote?: string;
  killingTest?: string;
  coveringTests?: readonly string[];
};

export function costOf(
  name: string,
  v3: SessionReport,
  refused: ReadonlyMap<string, string>,
  bcReports: readonly SessionReport[] = [],
): RunCost {
  const families: Record<string, FamilyCost> = {};
  const of = (id: string): FamilyCost => {
    families[id] ??= { ...ZERO };
    return families[id];
  };
  const testFamily = new Map<string, string>();
  for (const [test, msg] of refused) {
    const f = familyOf(msg);
    if (f === null) continue;
    testFamily.set(test, f);
    of(f).testsRefused++;
  }
  /** a cascade note's earlier test (a method name) -> that refused test's family, when exactly one refused test has it */
  const cascadeFamily = (method: string): string | undefined => {
    const hits = [...testFamily].filter(([t]) => t.endsWith(`.${method}`));
    return hits.length === 1 ? hits[0]?.[1] : undefined;
  };
  const v3Verdict = new Map<string, string>();
  for (const m of v3.mutants as M[]) {
    v3Verdict.set(siteKey(m), scoredVerdict(m.verdict));
    if (m.verdict !== "error") continue;
    const note = m.failureNote ?? "";
    const cascade = CASCADE.exec(note);
    if (cascade?.[1] !== undefined) {
      // credit the earlier test's own refusal; fall back to the note's quote only when that test is not resolvable
      const f = cascadeFamily(cascade[1]) ?? familyOf(note);
      if (f !== null) of(f).cascadeErrors++;
      continue;
    }
    const f = familyOf(note);
    if (f !== null) of(f).errorMutants++;
  }
  let joined = 0;
  for (const rep of bcReports)
    for (const m of rep.mutants as M[]) {
      const v = v3Verdict.get(siteKey(m));
      if (v === undefined) continue;
      joined++;
      const covering = m.coveringTests ?? [];
      // a kill is LOST only when v3 did not kill the mutant at all (another test may still kill it)
      if (scoredVerdict(m.verdict) === "killed" && v !== "killed") {
        const f = testFamily.get(resolveKiller(m.killingTest ?? "", covering));
        if (f !== undefined) of(f).killsLost++;
      }
      if (covering.length > 0 && covering.every((t) => testFamily.has(t)))
        for (const f of new Set(covering.map((t) => testFamily.get(t) as string)))
          of(f).reachedOnlyByRefused++;
    }
  return { name, v3Mutants: v3.mutants.length, joined, families };
}

const score = (c: FamilyCost) => c.killsLost + c.errorMutants + c.cascadeErrors;

/** The unmapped texts, as `U<n>\t<text>`, numbered as `render` numbers them. PRIVATE: they may name project objects. */
export function unmappedTexts(runs: readonly RunCost[]): string[] {
  return [...new Set(runs.flatMap((r) => Object.keys(r.families)))]
    .filter((id) => id.startsWith("unmapped:"))
    .sort()
    .map((id, i) => `U${i + 1}\t${id.slice("unmapped:".length)}`);
}

export function render(runs: readonly RunCost[]): string {
  const ids = new Set(runs.flatMap((r) => Object.keys(r.families)));
  const total = (id: string): FamilyCost =>
    runs.reduce(
      (t, r) => {
        const c = r.families[id];
        if (c === undefined) return t;
        return {
          testsRefused: t.testsRefused + c.testsRefused,
          errorMutants: t.errorMutants + c.errorMutants,
          cascadeErrors: t.cascadeErrors + (c.cascadeErrors ?? 0),
          killsLost: t.killsLost + c.killsLost,
          reachedOnlyByRefused: t.reachedOnlyByRefused + c.reachedOnlyByRefused,
        };
      },
      { ...ZERO },
    );
  const ranked = [...ids].sort(
    (a, b) =>
      score(total(b)) - score(total(a)) ||
      total(b).testsRefused - total(a).testsRefused ||
      a.localeCompare(b),
  );
  // an unmapped text can name the project's objects, so the shared file withholds it (renderUnmapped lists it privately)
  const unmapped = [...ids].filter((id) => id.startsWith("unmapped:")).sort();
  const label = (id: string) => {
    const f = FAMILIES.find((x) => x.id === id);
    return f === undefined
      ? {
          issue: "none",
          label: `unmapped text U${unmapped.indexOf(id) + 1} (withheld: may name project objects)`,
        }
      : f;
  };
  const head = [
    "# al-runner refusal families ranked by what they cost a real project",
    "",
    "Counts only: no project source, object, file or test name. Generated by LethAL's `scripts/v3-refusal-cost.ts`.",
    "",
    "Runs:",
    ...runs.map(
      (r) =>
        `- **${r.name}**: ${r.v3Mutants} v3 mutants${r.joined > 0 ? `, ${r.joined} joined with BC verdicts` : " (no BC verdicts joined)"}`,
    ),
    "",
    "Columns, per run:",
    "- **tests**: tests refused at v3's baseline;",
    "- **errors**: mutants v3 ends as `error` because of this family's refusal of the mutant itself;",
    "- **cascade**: mutants v3 ends as `error` because an earlier test of the codeunit was refused while it ran,",
    "  credited to that earlier test's own family;",
    "- **kills lost**: BC kills whose killing test v3 refused while v3 did not kill the mutant (joined runs only);",
    "- **only-refused**: mutants BC reaches only through tests v3 refused (joined runs only; a mutant reached by",
    "  two families' tests counts in both).",
    "",
    "Ranked by kills lost + errors + cascade, summed over the runs. Read the rank as an order, not a total:",
    "- the runs can overlap (an area run is part of a whole-project run), so a sum counts the same test twice;",
    "- kills lost exist only for a run with BC verdicts joined; a run without them shows `-` and cannot add any;",
    "- one mutant can count in two families (a kill lost under one, an error under another).",
    "",
  ];
  const cols = runs.map((r) => r.name);
  const table = [
    `| rank | issue | family | ${cols.map((c) => `${c}: tests / errors / cascade / kills lost / only-refused`).join(" | ")} |`,
    `|---|---|---|${cols.map(() => "---").join("|")}|`,
    ...ranked.map((id, i) => {
      const l = label(id);
      const cells = runs.map((r) => {
        const c = r.families[id];
        if (c === undefined) return "";
        const bc = r.joined > 0 ? ` / ${c.killsLost} / ${c.reachedOnlyByRefused}` : " / - / -";
        return `${c.testsRefused} / ${c.errorMutants} / ${c.cascadeErrors ?? 0}${bc}`;
      });
      return `| ${i + 1} | ${l.issue} | ${l.label} | ${cells.join(" | ")} |`;
    }),
  ];
  return `${[...head, ...table].join("\n")}\n`;
}

if (import.meta.main) {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === "run") {
    const { values } = parseArgs({
      args: rest,
      strict: true,
      options: {
        name: { type: "string" },
        v3: { type: "string" },
        "v3-store": { type: "string" },
        bc: { type: "string", multiple: true },
        out: { type: "string" },
      },
    });
    if (
      values.name === undefined ||
      values.v3 === undefined ||
      values["v3-store"] === undefined ||
      values.out === undefined
    )
      throw new Error(
        "usage: v3-refusal-cost.ts run --name <label> --v3 <report> --v3-store <db> [--bc <report> ...] --out <costs.json>",
      );
    const cost = costOf(
      values.name,
      loadReport(values.v3),
      baselineRefusals(values["v3-store"]),
      (values.bc ?? []).map(loadReport),
    );
    writeFileSync(values.out, `${JSON.stringify(cost, null, 2)}\n`);
    console.log(render([cost]));
  } else if (mode === "render") {
    const { values, positionals } = parseArgs({
      args: rest,
      strict: true,
      allowPositionals: true,
      options: { out: { type: "string" }, "unmapped-out": { type: "string" } },
    });
    if (
      values.out === undefined ||
      values["unmapped-out"] === undefined ||
      positionals.length === 0
    )
      throw new Error(
        "usage: v3-refusal-cost.ts render --out <priority.md> --unmapped-out <private.txt> <costs.json> ...",
      );
    const runs = positionals.map((p) => JSON.parse(readFileSync(p, "utf8")) as RunCost);
    const md = render(runs);
    writeFileSync(values.out, md);
    // PRIVATE: the withheld texts, numbered as U1, U2, ... in the shared file; never sent with it
    writeFileSync(values["unmapped-out"], `${unmappedTexts(runs).join("\n")}\n`);
    console.log(md);
  } else throw new Error("usage: v3-refusal-cost.ts run|render ...");
}
