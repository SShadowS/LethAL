#!/usr/bin/env bun
/**
 * R546: bucket a bcdev report and an al-runner report of the SAME slice, per mutant, into the
 * classes fixed by `docs/superpowers/specs/2026-10-09-r546-alrunner-bc-agreement-method.md`.
 *
 * `report-diff.ts` is the gate view; it is not enough here: it scores error/error and timeout/timeout
 * as identical and never compares the mutated text. This script refuses (exit 2) unless every key
 * occurs exactly once per side and both sides mutated the same span the same way.
 *
 *   bun scripts/r546-bucket.ts <bcdev report.json> <al-runner report.json> [--json <out>]
 */
import { keyOf } from "../packages/runner/itest/mutant-equality";
import type { MutantOutcome, SessionReport } from "../packages/runner/src/report";
import { loadReport } from "./report-summary.ts";

export type R546Class =
  | "agree"
  | "kill-vs-survive"
  | "verdict-vs-no-coverage"
  | "error-timeout"
  | "one-side-only";

const PLAIN = new Set(["killed", "survived", "no-coverage"]);

/** The method's verdict-pair table. `undefined` = the key is absent on that side. */
export function classify(bc: string | undefined, ar: string | undefined): R546Class {
  if (bc === undefined || ar === undefined) return "one-side-only";
  if (bc === "known-survivor" || ar === "known-survivor") {
    throw new Error("known-survivor is refused by the R546 method (no suppression file is used)");
  }
  if (!PLAIN.has(bc) || !PLAIN.has(ar)) return "error-timeout";
  if (bc === ar) return "agree";
  if (bc === "no-coverage" || ar === "no-coverage") return "verdict-vs-no-coverage";
  return "kill-vs-survive";
}

export interface R546Row {
  readonly key: string;
  readonly file: string;
  readonly line: number;
  readonly operator: string;
  readonly procedure: string;
  readonly cls: R546Class;
  readonly bc: string | null;
  readonly ar: string | null;
  readonly bcKillingTest: string | null;
  readonly arKillingTest: string | null;
  readonly bcKillPosition: number | null;
  readonly arKillPosition: number | null;
}

function byKey(mutants: readonly MutantOutcome[], side: string): Map<string, MutantOutcome> {
  const map = new Map<string, MutantOutcome>();
  for (const m of mutants) {
    const k = keyOf(m);
    if (map.has(k)) throw new Error(`${side}: key occurs more than once (group size > 1): ${k}`);
    map.set(k, m);
  }
  return map;
}

const SAME_MUTANT = ["file", "startIndex", "endIndex", "originalText", "mutatedText"] as const;

export function bucket(
  bcMutants: readonly MutantOutcome[],
  arMutants: readonly MutantOutcome[],
): R546Row[] {
  // Empty against empty "agrees" perfectly, which is this project's signature bug: refuse it.
  if (bcMutants.length === 0 || arMutants.length === 0) {
    throw new Error("a side has no mutants: nothing to compare");
  }
  const bc = byKey(bcMutants, "bcdev");
  const ar = byKey(arMutants, "al-runner");
  const keys = [...new Set([...bc.keys(), ...ar.keys()])].sort();
  return keys.map((key) => {
    const b = bc.get(key);
    const a = ar.get(key);
    if (b !== undefined && a !== undefined) {
      for (const f of SAME_MUTANT) {
        if (b[f] !== a[f])
          throw new Error(`LethAL defect: ${key} differs in ${f} between the two sides`);
      }
    }
    const any = b ?? a;
    if (any === undefined) throw new Error(`unreachable: ${key} on neither side`);
    return {
      key,
      file: any.file,
      line: any.line,
      operator: any.operatorName,
      procedure: any.procedureName || any.triggerName || "",
      cls: classify(b?.verdict, a?.verdict),
      bc: b?.verdict ?? null,
      ar: a?.verdict ?? null,
      bcKillingTest: b?.killingTest ?? null,
      arKillingTest: a?.killingTest ?? null,
      bcKillPosition: b?.killPosition ?? null,
      arKillPosition: a?.killPosition ?? null,
    };
  });
}

/** The two reports must be one bcdev run and one al-runner run, in that order. */
export function bucketReports(bcReport: SessionReport, arReport: SessionReport): R546Row[] {
  if (bcReport.backend !== "bcdev" || arReport.backend !== "al-runner") {
    throw new Error(
      `expected a bcdev report then an al-runner report, got ${bcReport.backend} then ${arReport.backend}`,
    );
  }
  return bucket(bcReport.mutants, arReport.mutants);
}

if (import.meta.main) {
  const [bcPath, arPath, flag, out] = process.argv.slice(2);
  const badJson = flag !== undefined && (flag !== "--json" || out === undefined);
  if (bcPath === undefined || arPath === undefined || badJson) {
    console.error(
      "usage: bun scripts/r546-bucket.ts <bcdev report.json> <al-runner report.json> [--json <out>]",
    );
    process.exit(1);
  }
  let rows: R546Row[];
  try {
    rows = bucketReports(loadReport(bcPath), loadReport(arPath));
  } catch (e) {
    console.error(`REFUSED: ${(e as Error).message}`);
    process.exit(2);
  }
  const count = (c: R546Class) => rows.filter((r) => r.cls === c).length;
  const agree = rows.filter((r) => r.cls === "agree");
  const bothScored = rows.filter(
    (r) => (r.bc === "killed" || r.bc === "survived") && (r.ar === "killed" || r.ar === "survived"),
  );
  console.log(`mutants (union of keys): ${rows.length}`);
  const classes: readonly R546Class[] = [
    "agree",
    "kill-vs-survive",
    "verdict-vs-no-coverage",
    "error-timeout",
    "one-side-only",
  ];
  for (const c of classes) console.log(`  ${c}: ${count(c)}`);
  const killerDiffers = agree.filter(
    (r) => r.bc === "killed" && r.bcKillingTest !== r.arKillingTest,
  );
  const bothNoCov = agree.filter((r) => r.bc === "no-coverage");
  console.log(
    `  agree sub-counts: killingTest differs ${killerDiffers.length}, both no-coverage ${bothNoCov.length}`,
  );
  console.log(`rate 1 (agree / all): ${count("agree")}/${rows.length}`);
  const agreeScored = bothScored.filter((r) => r.cls === "agree").length;
  console.log(
    `rate 2 (agree / scored killed-or-survived on both): ${agreeScored}/${bothScored.length}`,
  );
  const at = (p: number | null) => (p !== null ? `@${p}` : "");
  for (const r of rows.filter((x) => x.cls !== "agree")) {
    const sides = `bc ${r.bc ?? "-"}${at(r.bcKillPosition)} ar ${r.ar ?? "-"}${at(r.arKillPosition)}`;
    console.log(`  ${r.cls}: ${r.file}:${r.line} ${r.operator} ${r.procedure} | ${sides}`);
  }
  if (out !== undefined) await Bun.write(out, `${JSON.stringify(rows, null, 2)}\n`);
}
