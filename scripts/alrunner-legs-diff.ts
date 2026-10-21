#!/usr/bin/env bun
/**
 * R-587: compare two runs of `itest:alrunner`, leg by leg, from their `--reports` directories.
 * Built for the S (sequential) against P (`--parallel`) equality gate.
 *
 *   bun scripts/alrunner-legs-diff.ts <S reports dir> <P reports dir>
 *
 * Each directory must hold the run's `run.json` (its nonce and al-runner build line), a
 * `<group>.done.json` for all 7 groups and a `<legId>.json` for each leg, every one carrying that
 * run's nonce. Per leg it runs `compareReports` (scripts/report-diff.ts: per `keyOf`, verdict,
 * killingTest, coverageFiltered, errorClass, mutated-text hash) and, on the names and wrapped legs,
 * also requires the same `killingTestFailure` per mutant code.
 *
 * Exit codes: 0 IDENTICAL; 1 DIFFERENT (any difference, or a leg missing on one side); 2 REFUSED
 * (a file absent, unreadable or from another run); 3 VOID (the two runs used different al-runner
 * build lines (I2), or a leg had a row whose mutated text could not be checked (I3), so equality
 * cannot be claimed).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALRUNNER_LEG_IDS,
  GROUP_NAMES,
  type LegId,
  groupLegs,
} from "../packages/runner/itest/alrunner-legs.ts";
import type { SessionReport } from "../packages/runner/src/report";
import { compareReports } from "./report-diff.ts";

export class LegsDiffRefusal extends Error {}

export interface RunDir {
  readonly dir: string;
  readonly nonce: string;
  readonly buildLine: string;
  readonly legs: ReadonlyMap<LegId, SessionReport>;
}

function readJson(path: string): Record<string, unknown> {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new LegsDiffRefusal(`${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof data !== "object" || data === null)
    throw new LegsDiffRefusal(`${path}: not an object`);
  return data as Record<string, unknown>;
}

/** Reads one run's directory, refusing anything that is not this run's evidence (B2). */
export function readRunDir(dir: string): RunDir {
  const run = readJson(join(dir, "run.json"));
  const nonce = run.runNonce;
  const buildLine = run.buildLine;
  if (typeof nonce !== "string" || nonce === "" || typeof buildLine !== "string") {
    throw new LegsDiffRefusal(`${dir}/run.json has no runNonce or buildLine`);
  }
  for (const g of GROUP_NAMES) {
    const path = join(dir, `${g}.done.json`);
    if (!existsSync(path))
      throw new LegsDiffRefusal(`${path} is missing: group ${g} did not finish in this run`);
    if (readJson(path).runNonce !== nonce)
      throw new LegsDiffRefusal(`${path} is from another run (nonce)`);
  }
  const legs = new Map<LegId, SessionReport>();
  for (const id of ALRUNNER_LEG_IDS) {
    const path = join(dir, `${id}.json`);
    if (!existsSync(path)) continue;
    const file = readJson(path);
    if (file.runNonce !== nonce) throw new LegsDiffRefusal(`${path} is from another run (nonce)`);
    const report = file.report as SessionReport | undefined;
    if (!Array.isArray(report?.mutants)) throw new LegsDiffRefusal(`${path} has no report.mutants`);
    legs.set(id, report);
  }
  return { dir, nonce, buildLine, legs };
}

const KILL_TEXT_LEGS: readonly string[] = [...groupLegs("names"), ...groupLegs("wrapped")];

function killTexts(r: SessionReport): string[] {
  return r.mutants.map((m) => `${m.mutantCode}\t${m.killingTestFailure ?? ""}`).sort();
}

export function diffRunDirs(
  s: RunDir,
  p: RunDir,
): { verdict: "IDENTICAL" | "DIFFERENT" | "VOID"; lines: string[] } {
  const lines = [`S ${s.dir} nonce ${s.nonce}`, `P ${p.dir} nonce ${p.nonce}`];
  if (s.buildLine !== p.buildLine) {
    lines.push(`al-runner build differs: S "${s.buildLine}", P "${p.buildLine}" (I2)`, "VOID");
    return { verdict: "VOID", lines };
  }
  let different = false;
  let unverified = false;
  for (const id of ALRUNNER_LEG_IDS) {
    const a = s.legs.get(id);
    const b = p.legs.get(id);
    if (a === undefined || b === undefined) {
      lines.push(
        `leg ${id}: missing in ${a === undefined ? "S" : ""}${a === undefined && b === undefined ? " and " : ""}${b === undefined ? "P" : ""}`,
      );
      different = true;
      continue;
    }
    const cmp = compareReports(a, b);
    const diffs = [...cmp.differences];
    if (KILL_TEXT_LEGS.includes(id)) {
      const ka = killTexts(a);
      const kb = killTexts(b);
      ka.forEach((t, i) => {
        if (t !== kb[i])
          diffs.push(`killingTestFailure: S ${JSON.stringify(t)} P ${JSON.stringify(kb[i])}`);
      });
      if (kb.length > ka.length)
        diffs.push(`killingTestFailure: P has ${kb.length - ka.length} more row(s)`);
    }
    if (diffs.length > 0) different = true;
    if (cmp.textUnverified > 0) unverified = true;
    lines.push(
      `leg ${id}: ${diffs.length === 0 ? "IDENTICAL" : `DIFFERENT (${diffs.length})`}, ${a.mutants.length} mutants${cmp.textUnverified > 0 ? `, ${cmp.textUnverified} text-UNVERIFIED (I3)` : ""}`,
    );
    for (const d of diffs) lines.push(`  ${d}`);
  }
  const verdict = different ? "DIFFERENT" : unverified ? "VOID" : "IDENTICAL";
  lines.push(verdict);
  return { verdict, lines };
}

if (import.meta.main) {
  const [sDir, pDir, ...extra] = process.argv.slice(2);
  if (sDir === undefined || pDir === undefined || extra.length > 0) {
    console.error("usage: bun scripts/alrunner-legs-diff.ts <S reports dir> <P reports dir>");
    process.exit(2);
  }
  try {
    const { verdict, lines } = diffRunDirs(readRunDir(sDir), readRunDir(pDir));
    console.log(lines.join("\n"));
    process.exit(verdict === "IDENTICAL" ? 0 : verdict === "DIFFERENT" ? 1 : 3);
  } catch (e) {
    console.error(`REFUSED: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
