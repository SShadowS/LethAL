/**
 * PR-490: join BC's verdicts with al-runner v3's on the FULL site key (file, line, operator, startIndex, endIndex), and
 * sort every difference into a class, so real-project runs measure how far v3 can be trusted (R586's evidence).
 *
 *   bun scripts/bc-v3-join.ts --bc <report.json> [--bc ...] --v3 <report.json> [--file <path>]
 *                             [--bc-store <db> ...] [--v3-store <db>] --out <dir>
 *
 * Several --bc reports are one run in halves (lethal-bugs' split files): their keys must be disjoint and their baselines
 * equal, and mutant codes are per half, so the join never uses mutantCode. --file keeps one source file. A store adds the
 * tests that failed at that run's baseline but are missing from its report's `notRunAtBaseline` (its latest run only).
 * Writes `<out>/joined.tsv` (one row per key that differs or is on one side only; its note column can quote values from
 * error messages, so it stays in a private folder) and `<out>/summary.json`, and prints the summary.
 *
 * Refuses (throws): a report without `sourceSha256`, different source, different test methods (name, file, line), a
 * repeated key, halves with different baselines, an empty side ("agreement" over nothing proves nothing).
 *
 * Classes for a key in both, each decided by the test that DECIDES the difference, never by an unrelated covering test:
 * - `equal`; `killed-other-test` (both killed, by different tests: the kill order);
 * - one side killed, the other not:
 *   - `baseline`: the killing test is red at the other side's baseline (so the other side never ran it);
 *   - `v3-refused` / `bc-error`: the other side is `error` without a baseline note (a refusal of this one mutant);
 *   - `coverage`: the other side is `no-coverage` though the killing test is green there;
 *   - `killed-vs-survived` / `survived-vs-killed` (BC first): the killing test is green on both and the other side ran it:
 *     the class to examine;
 * - a `no-coverage` side whose note says its only covering tests were refused at baseline is `baseline` in every case
 *   (PR-504: the other side's covering list may be object-level, so it proves no reach);
 * - neither killed: `baseline` when an `error` side's note names baseline-red tests, or a `no-coverage` side has every
 *   one of the other side's covering tests red; `v3-refused` / `bc-error` for another one-sided `error`; `coverage` for
 *   another `no-coverage`; `other`.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { SessionReport } from "../packages/runner/src/report";
import { loadReport } from "./report-summary.ts";

export class BcV3JoinRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BcV3JoinRefusal";
  }
}

export interface Row {
  readonly code: string;
  readonly verdict: string;
  /** the killing test's full name `<codeunit>.<method>`, resolved from the covering tests; "" when not killed */
  readonly killer: string;
  readonly covering: readonly string[];
  readonly note: string;
}

type Mutant = SessionReport["mutants"][number];

export function siteKey(
  m: Pick<Mutant, "file" | "line" | "operatorName" | "startIndex" | "endIndex">,
): string {
  return [m.file, m.line, m.operatorName, m.startIndex, m.endIndex].join("|");
}

/**
 * A report's `killingTest` is the method alone; the covering test that ends in `.<method>` names its codeunit. Codeunit
 * names can hold dots, so the name is never split. No match keeps the bare method (it then matches no red set).
 */
export function resolveKiller(method: string, covering: readonly string[]): string {
  if (method === "") return "";
  return covering.find((t) => t.endsWith(`.${method}`)) ?? method;
}

/**
 * PR-494: the verdict as LethAL SCORES it. `timeout-killed` (a mutant that hung its killing test, stopped by
 * `--stop-hung-sessions`) counts as killed in the mutation score, so it is a kill here too; reading only `"killed"`
 * dropped those kills from every class and cost.
 */
export function scoredVerdict(verdict: string): string {
  return verdict === "timeout-killed" ? "killed" : verdict;
}

function rowOf(m: Mutant): Row {
  const r = m as Mutant & {
    killingTest?: string;
    coveringTests?: readonly string[];
    failureNote?: string;
  };
  const covering = r.coveringTests ?? [];
  const verdict = scoredVerdict(m.verdict);
  return {
    code: m.mutantCode,
    verdict,
    killer: verdict === "killed" ? resolveKiller(r.killingTest ?? "", covering) : "",
    covering,
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
/**
 * PR-504: v3's note on a `no-coverage` whose only covering tests v3 refused at baseline ("al-runner v3 refusal: mutant
 * covered by test(s) al-runner v3 refused at baseline (...)"). That is a baseline difference, whatever the other side's
 * covering list holds: BC's list can be object-level (`coverageAttribution: object`, every test touching the object), so
 * a BC covering test green on v3 does not show it reaches the mutant (DOTests file 2: 95 rows).
 */
const REFUSED_AT_BASELINE_NOTE = /refused at baseline/;
const refusedOnly = (r: Row): boolean =>
  r.verdict === "no-coverage" && REFUSED_AT_BASELINE_NOTE.test(r.note);

/** One side killed (`k`), the other (`o`) did not; `oRed` is the other side's baseline-red set. */
function oneKilled(
  k: Row,
  o: Row,
  oRed: ReadonlySet<string>,
  oSide: "bc" | "v3",
  kFirst: boolean,
): string {
  if (oRed.has(k.killer) || refusedOnly(o)) return "baseline";
  if (o.verdict === "error")
    return BASELINE_NOTE.test(o.note) ? "baseline" : oSide === "v3" ? "v3-refused" : "bc-error";
  if (o.verdict === "no-coverage") return "coverage";
  if (o.verdict === "survived") return kFirst ? "killed-vs-survived" : "survived-vs-killed";
  return "other";
}

export function classify(
  bc: Row,
  v3: Row,
  bcRed: ReadonlySet<string>,
  v3Red: ReadonlySet<string>,
): string {
  if (bc.verdict === v3.verdict) {
    if (bc.verdict !== "killed" || bc.killer === v3.killer) return "equal";
    return "killed-other-test";
  }
  if (bc.verdict === "killed") return oneKilled(bc, v3, v3Red, "v3", true);
  if (v3.verdict === "killed") return oneKilled(v3, bc, bcRed, "bc", false);
  const errBaseline = (r: Row) => r.verdict === "error" && BASELINE_NOTE.test(r.note);
  if (errBaseline(bc) || errBaseline(v3) || refusedOnly(bc) || refusedOnly(v3)) return "baseline";
  const allRed = (tests: readonly string[], red: ReadonlySet<string>) =>
    tests.length > 0 && tests.every((t) => red.has(t));
  if (v3.verdict === "no-coverage") return allRed(bc.covering, v3Red) ? "baseline" : "coverage";
  if (bc.verdict === "no-coverage") return allRed(v3.covering, bcRed) ? "baseline" : "coverage";
  if (v3.verdict === "error") return "v3-refused";
  if (bc.verdict === "error") return "bc-error";
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
     * Over the keys with at least one covering test (either side), none of them red at either baseline, and no baseline
     * note: the comparison neither baseline can disturb. `verdict` counts the same verdict (another killing test
     * included). Keys no test reaches on either side are left out: they agree trivially (`noTestEitherSide`).
     */
    readonly greenBaseline: { readonly both: number; readonly verdict: number };
    readonly noTestEitherSide: number;
  };
  readonly rows: readonly string[];
}

/**
 * The tests that did not pass at a run's baseline, as `<codeunit>.<method>`, from its results store (the LATEST run in
 * it). A report's `notRunAtBaseline` can leave out a test that ran and failed; the store has every baseline row.
 */
export function baselineRedFromStore(path: string): Set<string> {
  const db = new Database(path, { readonly: true });
  try {
    const rows = db
      .query(
        "select codeunit_name as c, method as m from test_results where mutant_row_id is null and outcome <> 'pass' and run_id = (select max(run_id) from test_results where mutant_row_id is null)",
      )
      .all() as { c: string | null; m: string }[];
    return new Set(
      rows.map((r) => {
        if (r.c === null)
          throw new BcV3JoinRefusal(`${path}: a baseline row for ${r.m} has no codeunit name`);
        return `${r.c}.${r.m}`;
      }),
    );
  } finally {
    db.close();
  }
}

const testSet = (r: SessionReport): string =>
  JSON.stringify(
    (
      (r as SessionReport & { testMethods?: { name: string; file: string; line: number }[] })
        .testMethods ?? []
    )
      .map((t) => `${t.file}|${t.line}|${t.name}`)
      .sort(),
  );

export function joinReports(
  bcReports: readonly SessionReport[],
  v3: SessionReport,
  file?: string,
  extraRed: { readonly bc?: ReadonlySet<string>; readonly v3?: ReadonlySet<string> } = {},
): JoinResult {
  const all = [...bcReports, v3];
  if (all.some((r) => typeof r.sourceSha256 !== "string" || r.sourceSha256 === ""))
    throw new BcV3JoinRefusal("a report has no sourceSha256: the source cannot be shown equal");
  const shas = new Set(all.map((r) => r.sourceSha256));
  if (shas.size !== 1)
    throw new BcV3JoinRefusal(
      `the reports were built from different source: ${[...shas].join(", ")}`,
    );
  if (new Set(all.map(testSet)).size !== 1)
    throw new BcV3JoinRefusal("the reports ran different test methods (name, file, line)");
  const red = (r: SessionReport) => JSON.stringify([...(r.notRunAtBaseline ?? [])].sort());
  if (new Set(bcReports.map(red)).size > 1)
    throw new BcV3JoinRefusal("the BC halves have different baselines (notRunAtBaseline)");
  const bc = index(bcReports, file, "bc");
  const v = index([v3], file, "v3");
  if (bc.size === 0 || v.size === 0)
    throw new BcV3JoinRefusal(
      `no mutant in scope on ${bc.size === 0 ? "the BC side" : "the v3 side"}`,
    );
  const bcRed = new Set([...(bcReports[0]?.notRunAtBaseline ?? []), ...(extraRed.bc ?? [])]);
  const v3Red = new Set([...(v3.notRunAtBaseline ?? []), ...(extraRed.v3 ?? [])]);
  const classes: Record<string, number> = {};
  const rows = [
    "key\tbc code\tv3 code\tbc verdict\tv3 verdict\tbc killing test\tv3 killing test\tbc covering\tv3 covering\tclass\tv3 note",
  ];
  const row = (k: string, b: Row | undefined, w: Row | undefined, c: string) =>
    rows.push(
      [
        k,
        b?.code ?? "",
        w?.code ?? "",
        b?.verdict ?? "",
        w?.verdict ?? "",
        b?.killer ?? "",
        w?.killer ?? "",
        b?.covering.length ?? "",
        w?.covering.length ?? "",
        c,
        (w?.note ?? "").slice(0, 300).replace(/[\t\n\r]/g, " "),
      ].join("\t"),
    );
  let answered = 0;
  let answeredVerdict = 0;
  let answeredEqual = 0;
  let green = 0;
  let greenVerdict = 0;
  let noTest = 0;
  for (const [k, b] of bc) {
    const w = v.get(k);
    if (w === undefined) {
      row(k, b, undefined, "only-bc");
      continue;
    }
    const c = classify(b, w, bcRed, v3Red);
    classes[c] = (classes[c] ?? 0) + 1;
    const sameVerdict = c === "equal" || c === "killed-other-test";
    if (ANSWERED.has(b.verdict) && ANSWERED.has(w.verdict)) {
      answered++;
      if (sameVerdict) answeredVerdict++;
      if (c === "equal") answeredEqual++;
    }
    const cover = [...b.covering, ...w.covering];
    const noteRed = BASELINE_NOTE.test(b.note) || BASELINE_NOTE.test(w.note);
    if (cover.length === 0 && !noteRed) noTest++;
    else if (!noteRed && !cover.some((t) => bcRed.has(t) || v3Red.has(t))) {
      green++;
      if (sameVerdict) greenVerdict++;
    }
    if (c !== "equal") row(k, b, w, c);
  }
  for (const [k, w] of v) if (!bc.has(k)) row(k, undefined, w, "only-v3");
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
      noTestEitherSide: noTest,
    },
    rows,
  };
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      bc: { type: "string", multiple: true },
      v3: { type: "string" },
      file: { type: "string" },
      "bc-store": { type: "string", multiple: true },
      "v3-store": { type: "string", multiple: true },
      out: { type: "string" },
    },
  });
  const bcPaths = values.bc ?? [];
  if (bcPaths.length === 0 || values.v3 === undefined || values.out === undefined)
    throw new Error(
      "usage: bc-v3-join.ts --bc <report.json> [--bc ...] --v3 <report.json> [--file <path>] [--bc-store <db> ...] [--v3-store <db>] --out <dir>",
    );
  const fromStores = (paths: readonly string[]) =>
    new Set(paths.flatMap((p) => [...baselineRedFromStore(p)]));
  const result = joinReports(bcPaths.map(loadReport), loadReport(values.v3), values.file, {
    bc: fromStores(values["bc-store"] ?? []),
    v3: fromStores(values["v3-store"] ?? []),
  });
  mkdirSync(values.out, { recursive: true });
  writeFileSync(join(values.out, "joined.tsv"), `${result.rows.join("\n")}\n`);
  writeFileSync(join(values.out, "summary.json"), `${JSON.stringify(result.summary, null, 2)}\n`);
  console.log(JSON.stringify(result.summary, null, 2));
}
