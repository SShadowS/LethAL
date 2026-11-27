/**
 * PR-490: join BC's verdicts with al-runner v3's on the FULL site key (file, line, operator, startIndex, endIndex), and
 * sort every difference into a class, so real-project runs measure how far v3 can be trusted (R586's evidence).
 *
 *   bun scripts/bc-v3-join.ts --bc <report.json> [--bc <report.json> ...] --v3 <report.json> [--file <path>] --out <dir>
 *
 * Several --bc reports are one run in halves (lethal-bugs' split files): their keys must be disjoint, and mutant codes are
 * per half, so the join never uses mutantCode. --file keeps one source file. Writes `<out>/joined.tsv` (one row per key,
 * no source text) and `<out>/summary.json`, and prints the summary. Refuses (throws) when the two sides were built from
 * different source (sourceSha256), when a side repeats a key, or when either side has no mutant in scope: an empty
 * "agreement" proves nothing.
 *
 * Classes, decided in this order for a key in both:
 * - `equal`: same verdict, and when both killed, the same killing test method;
 * - `killed-other-test`: both killed, by different tests;
 * - `coverage`: one side `no-coverage` and the covering sets differ (a coverage difference, not a verdict);
 * - `baseline`: the side that did not kill/survive names, in its note, a test that did not pass at its baseline, or the
 *   two baselines' failing sets differ on a covering test;
 * - `v3-refused` / `bc-error`: `error` on one side only;
 * - `killed-vs-survived` / `survived-vs-killed` (BC first): an answered verdict differs: the class to examine;
 * - `other`.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionReport } from "../packages/runner/src/report";
import { loadReport } from "./report-summary.ts";

export class BcV3JoinRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BcV3JoinRefusal";
  }
}

interface Row {
  readonly code: string;
  readonly verdict: string;
  readonly killingTest: string;
  readonly covering: readonly string[];
  readonly note: string;
}

type Mutant = SessionReport["mutants"][number];

export function siteKey(
  m: Pick<Mutant, "file" | "line" | "operatorName" | "startIndex" | "endIndex">,
): string {
  return [m.file, m.line, m.operatorName, m.startIndex, m.endIndex].join("|");
}

function rowOf(m: Mutant): Row {
  const r = m as Mutant & {
    killingTest?: string;
    coveringTests?: readonly string[];
    failureNote?: string;
  };
  return {
    code: m.mutantCode,
    verdict: m.verdict,
    killingTest: r.killingTest ?? "",
    covering: r.coveringTests ?? [],
    note: r.failureNote ?? "",
  };
}

function index(
  reports: readonly SessionReport[],
  file: string | undefined,
  side: string,
): Map<string, Row> {
  const out = new Map<string, Row>();
  for (const rep of reports)
    for (const m of rep.mutants) {
      if (file !== undefined && m.file !== file) continue;
      const k = siteKey(m);
      if (out.has(k)) throw new BcV3JoinRefusal(`${side}: the site key ${k} appears twice`);
      out.set(k, rowOf(m));
    }
  return out;
}

const ANSWERED = new Set(["killed", "survived"]);
/** LethAL's note on a mutant whose only covering tests failed or were refused at the baseline. */
const BASELINE_NOTE = /did not pass at baseline/;

export function classify(
  bc: Row,
  v3: Row,
  bcBaselineRed: ReadonlySet<string>,
  v3BaselineRed: ReadonlySet<string>,
): string {
  if (bc.verdict === v3.verdict) {
    if (bc.verdict !== "killed" || bc.killingTest === v3.killingTest) return "equal";
    return "killed-other-test";
  }
  const sameCover =
    bc.covering.length === v3.covering.length && bc.covering.every((t) => v3.covering.includes(t));
  if ((bc.verdict === "no-coverage" || v3.verdict === "no-coverage") && !sameCover)
    return "coverage";
  const cover = new Set([...bc.covering, ...v3.covering]);
  const redOnOneSide = [...cover].some((t) => bcBaselineRed.has(t) !== v3BaselineRed.has(t));
  if (redOnOneSide || BASELINE_NOTE.test(bc.note) || BASELINE_NOTE.test(v3.note)) return "baseline";
  if (v3.verdict === "error" && bc.verdict !== "error") return "v3-refused";
  if (bc.verdict === "error" && v3.verdict !== "error") return "bc-error";
  if (ANSWERED.has(bc.verdict) && ANSWERED.has(v3.verdict)) return `${bc.verdict}-vs-${v3.verdict}`;
  return "other";
}

export interface JoinResult {
  readonly summary: {
    readonly sourceSha256: string;
    readonly bcMutants: number;
    readonly v3Mutants: number;
    readonly both: number;
    readonly onlyBc: number;
    readonly onlyV3: number;
    readonly classes: Readonly<Record<string, number>>;
    /** over the keys where both sides ANSWERED (killed or survived): same verdict, and same verdict AND killing test */
    readonly answeredAgreement: {
      readonly both: number;
      readonly verdict: number;
      readonly equal: number;
    };
    /**
     * Over the keys none of whose covering tests (either side's) is red at either baseline: the comparison neither side's
     * baseline refusals or failures can disturb. `verdict` counts the same verdict (a different killing test included).
     */
    readonly greenBaseline: { readonly both: number; readonly verdict: number };
  };
  readonly rows: readonly string[];
}

/**
 * The tests that did not pass at a run's baseline, as `<codeunit>.<method>`, from its results store: a report lists only
 * the tests it never ran (`notRunAtBaseline`), not the ones that ran and failed.
 */
export function baselineRedFromStore(path: string): Set<string> {
  const db = new Database(path, { readonly: true });
  try {
    const rows = db
      .query(
        "select coalesce(codeunit_name, cast(codeunit_id as text)) || '.' || method as t from test_results where mutant_row_id is null and outcome <> 'pass'",
      )
      .all() as { t: string }[];
    return new Set(rows.map((r) => r.t));
  } finally {
    db.close();
  }
}

export function joinReports(
  bcReports: readonly SessionReport[],
  v3: SessionReport,
  file?: string,
  extraRed: { readonly bc?: ReadonlySet<string>; readonly v3?: ReadonlySet<string> } = {},
): JoinResult {
  const shas = new Set([...bcReports, v3].map((r) => r.sourceSha256));
  if (shas.size !== 1)
    throw new BcV3JoinRefusal(
      `the reports were built from different source: ${[...shas].join(", ")}`,
    );
  const bc = index(bcReports, file, "bc");
  const v = index([v3], file, "v3");
  if (bc.size === 0 || v.size === 0)
    throw new BcV3JoinRefusal(
      `no mutant in scope on ${bc.size === 0 ? "the BC side" : "the v3 side"}`,
    );
  const red = (reps: readonly SessionReport[]) =>
    new Set(reps.flatMap((r) => r.notRunAtBaseline ?? []));
  const bcRed = new Set([...red(bcReports), ...(extraRed.bc ?? [])]);
  const v3Red = new Set([...red([v3]), ...(extraRed.v3 ?? [])]);
  const classes: Record<string, number> = {};
  const rows = [
    "key\tbc code\tv3 code\tbc verdict\tv3 verdict\tbc killing test\tv3 killing test\tbc covering\tv3 covering\tclass\tv3 note",
  ];
  let answered = 0;
  let answeredVerdict = 0;
  let answeredEqual = 0;
  let green = 0;
  let greenVerdict = 0;
  for (const [k, b] of bc) {
    const w = v.get(k);
    if (w === undefined) continue;
    const c = classify(b, w, bcRed, v3Red);
    classes[c] = (classes[c] ?? 0) + 1;
    const sameVerdict = c === "equal" || c === "killed-other-test";
    if (ANSWERED.has(b.verdict) && ANSWERED.has(w.verdict)) {
      answered++;
      if (sameVerdict) answeredVerdict++;
      if (c === "equal") answeredEqual++;
    }
    // a side that names baseline-red tests in its note (its covering list then holds none) is baseline-affected too
    const noteRed = BASELINE_NOTE.test(b.note) || BASELINE_NOTE.test(w.note);
    if (!noteRed && ![...b.covering, ...w.covering].some((t) => bcRed.has(t) || v3Red.has(t))) {
      green++;
      if (sameVerdict) greenVerdict++;
    }
    if (c !== "equal")
      rows.push(
        [
          k,
          b.code,
          w.code,
          b.verdict,
          w.verdict,
          b.killingTest,
          w.killingTest,
          b.covering.length,
          w.covering.length,
          c,
          w.note.slice(0, 300).replace(/[\t\n\r]/g, " "),
        ].join("\t"),
      );
  }
  const both = Object.values(classes).reduce((a, n) => a + n, 0);
  return {
    summary: {
      sourceSha256: [...shas][0] ?? "",
      bcMutants: bc.size,
      v3Mutants: v.size,
      both,
      onlyBc: bc.size - both,
      onlyV3: v.size - both,
      classes,
      answeredAgreement: { both: answered, verdict: answeredVerdict, equal: answeredEqual },
      greenBaseline: { both: green, verdict: greenVerdict },
    },
    rows,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const all = (flag: string) =>
    args.flatMap((a, i) =>
      a === flag && args[i + 1] !== undefined ? [args[i + 1] as string] : [],
    );
  const one = (flag: string) => all(flag)[0];
  const bcPaths = all("--bc");
  const v3Path = one("--v3");
  const out = one("--out");
  if (bcPaths.length === 0 || v3Path === undefined || out === undefined)
    throw new Error(
      "usage: bc-v3-join.ts --bc <report.json> [--bc ...] --v3 <report.json> [--file <path>] [--bc-store <db> ...] [--v3-store <db>] --out <dir>",
    );
  const fromStores = (paths: string[]) =>
    new Set(paths.flatMap((p) => [...baselineRedFromStore(p)]));
  const result = joinReports(bcPaths.map(loadReport), loadReport(v3Path), one("--file"), {
    bc: fromStores(all("--bc-store")),
    v3: fromStores(all("--v3-store")),
  });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "joined.tsv"), `${result.rows.join("\n")}\n`);
  writeFileSync(join(out, "summary.json"), `${JSON.stringify(result.summary, null, 2)}\n`);
  console.log(JSON.stringify(result.summary, null, 2));
}
