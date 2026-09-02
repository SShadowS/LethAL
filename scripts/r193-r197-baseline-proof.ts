#!/usr/bin/env bun
/**
 * R193 / R197: prove a re-recorded per-mutant baseline is a RELABELLING, not a regression.
 *
 * R193 gives identity twins an ordinal, so a colliding key `K` of size `n` becomes `K`, `K|1`, …,
 * `K|n-1`. R197 changes the order covering tests are tried in, so `killingTest` can change where
 * several tests kill. Neither may move a verdict. This script reads a gate's OLD baseline (the
 * committed `*.baseline.json`) and the NEW run's report, and checks exactly that, key by key.
 *
 *   bun scripts/r193-r197-baseline-proof.ts <old.baseline.json> <new.report.json>
 *
 * Pre-committed in `docs/superpowers/specs/2026-09-02-r193-r197-relabelling-precommitment.md`.
 */
import { normalizeForComparison } from "../packages/runner/itest/mutant-equality";
import type { NormalizedMutant } from "../packages/runner/itest/mutant-equality";
import type { SessionReport } from "../packages/runner/src/report";

export interface ProofResult {
  readonly failures: string[];
  readonly lines: string[];
  readonly killingTestChanges: number;
}

/** The five-part tuple of a key that may carry a sixth ordinal part. */
function tupleOf(key: string): string {
  const parts = key.split("|");
  return parts.length === 6 ? parts.slice(0, 5).join("|") : key;
}

function verdictMultiset(rows: readonly NormalizedMutant[]): string {
  return rows
    .map((r) => r.verdict)
    .sort()
    .join(",");
}

export function prove(
  oldBaseline: readonly NormalizedMutant[],
  newSide: SessionReport | readonly NormalizedMutant[],
): ProofResult {
  const failures: string[] = [];
  const lines: string[] = [];
  const after = Array.isArray(newSide) ? newSide : normalizeForComparison(newSide);
  const oldByKey = new Map<string, NormalizedMutant[]>();
  for (const r of oldBaseline) oldByKey.set(r.key, [...(oldByKey.get(r.key) ?? []), r]);
  const newByTuple = new Map<string, NormalizedMutant[]>();
  for (const r of after) {
    const t = tupleOf(r.key);
    newByTuple.set(t, [...(newByTuple.get(t) ?? []), r]);
  }
  let killingTestChanges = 0;
  let splitGroups = 0;
  let splitMutants = 0;
  for (const [key, group] of oldByKey) {
    const fresh = newByTuple.get(key);
    if (fresh === undefined) {
      failures.push(`old key ${key} has no counterpart in the new report`);
      continue;
    }
    if (fresh.length !== group.length) {
      failures.push(`key ${key}: ${group.length} mutant(s) before, ${fresh.length} after`);
      continue;
    }
    if (group.length > 1) {
      splitGroups += 1;
      splitMutants += group.length;
      const ordinals = fresh
        .map((r) => (r.key.split("|").length === 6 ? Number(r.key.split("|")[5]) : 0))
        .sort((a, b) => a - b);
      const expected = [...Array(group.length).keys()];
      if (ordinals.join(",") !== expected.join(",")) {
        failures.push(
          `key ${key}: ordinals after are ${JSON.stringify(ordinals)}, expected 0..${group.length - 1}`,
        );
      }
    } else if (fresh[0]?.key !== key) {
      failures.push(`key ${key} was relabelled to ${fresh[0]?.key ?? "?"} although it had no twin`);
    }
    if (verdictMultiset(group) !== verdictMultiset(fresh)) {
      failures.push(`key ${key}: verdicts ${verdictMultiset(group)} -> ${verdictMultiset(fresh)}`);
      continue;
    }
    // Killing tests: compared as multisets too, since within a split group the assignment of
    // ordinal to row is by source position and the old baseline has no positions.
    const oldKillers = group
      .map((r) => r.killingTest ?? "")
      .sort()
      .join(",");
    const newKillers = fresh
      .map((r) => r.killingTest ?? "")
      .sort()
      .join(",");
    if (oldKillers !== newKillers) {
      const a = group.map((r) => r.killingTest ?? "").sort();
      const b = fresh.map((r) => r.killingTest ?? "").sort();
      killingTestChanges += a.filter((k, i) => k !== b[i]).length;
      lines.push(`  killingTest moved at ${key}: [${oldKillers}] -> [${newKillers}]`);
    }
  }
  for (const t of newByTuple.keys()) {
    if (!oldByKey.has(t)) failures.push(`new key ${t} has no counterpart in the old baseline`);
  }
  lines.unshift(
    `old ${oldBaseline.length} entries / ${oldByKey.size} keys; new ${after.length} entries / ${new Set(after.map((r) => r.key)).size} keys; ${splitGroups} colliding key(s) split over ${splitMutants} mutant(s); ${killingTestChanges} killingTest change(s)`,
  );
  return { failures, lines, killingTestChanges };
}

if (import.meta.main) {
  const [oldPath, newPath] = process.argv.slice(2);
  if (oldPath === undefined || newPath === undefined) {
    console.error(
      "usage: bun scripts/r193-r197-baseline-proof.ts <old.baseline.json> <new.report.json>",
    );
    process.exit(2);
  }
  const oldBaseline = (await Bun.file(oldPath).json()) as NormalizedMutant[];
  // The new side is a run's report (`--out`) or a re-recorded baseline; both are accepted.
  const newSide = (await Bun.file(newPath).json()) as SessionReport | NormalizedMutant[];
  const { failures, lines } = prove(oldBaseline, newSide);
  for (const l of lines) console.log(l);
  if (failures.length > 0) {
    console.log(`\nNOT A RELABELLING: ${failures.length} finding(s)`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log("\nRELABELLING PROVEN: every verdict unchanged, keys moved only by ordinal");
}
