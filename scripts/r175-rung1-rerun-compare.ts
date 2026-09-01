#!/usr/bin/env bun
/**
 * R175: compare a re-run of `do rung1` against the committed rung1 report, per mutant, and check
 * the prediction that was written down BEFORE the re-run.
 *
 * Why not `campaign compare`: R166 (2026-08-19) changed every `astSubtreeHash`, so rung1's
 * identity keys cannot match today's. The source is unchanged (R187 fingerprint
 * `9a8e8831449208cc...` on both days), so a mutant is matched by its START OFFSET in the file plus
 * operator name and major version, which is unique in both reports (checked, and asserted below).
 * The end offset is NOT used: `empty-block`'s span end moved by one character since rung1, a
 * relabelling that would otherwise read as 31 mutants removed and 31 added.
 *
 * Pre-committed in `docs/superpowers/specs/2026-09-02-r175-rung1-rerun-precommitment.md`. The
 * constants below ARE that pre-commitment; the document explains them.
 *
 *   bun scripts/r175-rung1-rerun-compare.ts <rung1.report.json> <rerun.report.json>
 */

interface MutantRow {
  readonly mutantCode: string;
  readonly startIndex: number;
  readonly operatorName: string;
  readonly operatorMajor: number;
  readonly verdict: string;
  readonly procedureName?: string;
  readonly triggerName?: string;
  readonly coverageAttribution?: string;
  readonly killingTest?: string;
  readonly coveringTests?: readonly string[];
}

interface ReportDoc {
  readonly mutants: readonly MutantRow[];
  readonly baselineGreen: boolean;
  readonly mutationScore: number | null;
  readonly counts: Record<string, number>;
  readonly validity: {
    readonly baselineTests: { readonly total: number; readonly failing: number };
  };
  readonly unplaceableCount?: number;
  readonly unplaceableMutants?: readonly string[];
}

/** Pre-committed: the four rung1 mutants today's operator refuses (`until X.Next() = 0`, R164). */
export const EXPECTED_REMOVED_CODES: readonly string[] = ["M0013", "M0040", "M0089", "M0102"];

/** Pre-committed: sites today's operators claim that rung1's did not, by start offset. */
export const EXPECTED_ADDED_KEYS: readonly string[] = [
  "239|lethal.void-method-call|1",
  "294|lethal.void-method-call|1",
  "673|lethal.void-method-call|1",
  "2753|lethal.void-method-call|1",
  "3008|lethal.remove-setrange|1",
  "3191|lethal.remove-setrange|1",
  "3750|lethal.void-method-call|1",
  "6129|lethal.void-method-call|1",
  "9862|lethal.empty-block|1",
  "10953|lethal.void-method-call|1",
  "12283|lethal.void-method-call|1",
];

/** Pre-committed partition of the 144 shared mutants, and the verdict each class must show. */
export const EXPECTED_CLASSES = {
  killed: { count: 25, verdict: "killed" },
  "exact-survived": { count: 19, verdict: "survived" },
  "trigger-object-survived": { count: 1, verdict: "survived" },
  widened: { count: 85, verdict: "no-coverage" },
  "no-coverage": { count: 14, verdict: "no-coverage" },
} as const;

export type MutantClass = keyof typeof EXPECTED_CLASSES;

/** Pre-committed: `unplaceableCount` is one of exactly two values, and anything else is a finding. */
export const EXPECTED_UNPLACEABLE: readonly number[] = [0, 99];

/** Pre-committed: the score on the shared mutants alone. */
export const EXPECTED_SHARED_SCORE = { killed: 25, survived: 20 };

export function keyOf(m: MutantRow): string {
  return `${m.startIndex}|${m.operatorName}|${m.operatorMajor}`;
}

/** Which class a rung1 mutant is in, from the rung1 report alone. */
export function classify(m: MutantRow): MutantClass {
  if (m.verdict === "killed") return "killed";
  if (m.verdict === "no-coverage") return "no-coverage";
  if (m.verdict === "survived" && m.coverageAttribution === "object") {
    return m.triggerName !== undefined ? "trigger-object-survived" : "widened";
  }
  if (m.verdict === "survived" && m.coverageAttribution === "exact") return "exact-survived";
  throw new Error(
    `rung1 mutant ${m.mutantCode} fits no pre-committed class: ${m.verdict}/${m.coverageAttribution}`,
  );
}

function indexByKey(rows: readonly MutantRow[], label: string): Map<string, MutantRow> {
  const out = new Map<string, MutantRow>();
  for (const m of rows) {
    const k = keyOf(m);
    if (out.has(k)) throw new Error(`${label}: start-offset key is not unique: ${k}`);
    out.set(k, m);
  }
  return out;
}

export interface Comparison {
  readonly failures: string[];
  readonly lines: string[];
}

export function compare(rung1: ReportDoc, rerun: ReportDoc): Comparison {
  const failures: string[] = [];
  const lines: string[] = [];
  const then = indexByKey(rung1.mutants, "rung1");
  const now = indexByKey(rerun.mutants, "rerun");

  // Preconditions: not R175's claim, but the run is not a valid comparison without them.
  if (!rerun.baselineGreen) failures.push("precondition: baselineGreen is false");
  const bt = rerun.validity.baselineTests;
  if (bt.total !== 56 || bt.failing !== 0) {
    failures.push(`precondition: baseline tests ${bt.total}/${bt.failing} failing, expected 56/0`);
  }
  lines.push(`baseline: green=${rerun.baselineGreen} tests=${bt.total} failing=${bt.failing}`);

  // The mutant set: removed and added, each pinned by name.
  const removed = [...then.keys()].filter((k) => !now.has(k)).map((k) => then.get(k));
  const removedCodes = removed.flatMap((m) => (m === undefined ? [] : [m.mutantCode])).sort();
  if (removedCodes.join(",") !== [...EXPECTED_REMOVED_CODES].sort().join(",")) {
    failures.push(
      `removed mutants ${JSON.stringify(removedCodes)} != expected ${JSON.stringify(EXPECTED_REMOVED_CODES)}`,
    );
  }
  const added = [...now.keys()].filter((k) => !then.has(k)).sort();
  if (added.join(",") !== [...EXPECTED_ADDED_KEYS].sort().join(",")) {
    failures.push(
      `added mutants ${JSON.stringify(added)} != expected ${JSON.stringify(EXPECTED_ADDED_KEYS)}`,
    );
  }
  lines.push(
    `mutants: rung1=${then.size} rerun=${now.size} shared=${then.size - removed.length} removed=${removed.length} added=${added.length}`,
  );
  for (const k of added) {
    const m = now.get(k);
    if (m !== undefined) {
      lines.push(
        `  added ${m.mutantCode} ${k} ${m.procedureName ?? m.triggerName ?? ""}: ${m.verdict} [${m.coverageAttribution ?? "-"}] (not predicted)`,
      );
    }
  }

  // The shared mutants, class by class.
  const seen: Record<MutantClass, number> = {
    killed: 0,
    "exact-survived": 0,
    "trigger-object-survived": 0,
    widened: 0,
    "no-coverage": 0,
  };
  const moved: string[] = [];
  const rerunCodesOfUncovered: string[] = [];
  let sharedKilled = 0;
  let sharedSurvived = 0;
  for (const [k, before] of then) {
    const after = now.get(k);
    if (after === undefined) continue;
    const cls = classify(before);
    seen[cls]++;
    const want = EXPECTED_CLASSES[cls].verdict;
    if (after.verdict !== want) {
      moved.push(
        `${before.mutantCode}->${after.mutantCode} ${cls} ${before.procedureName ?? ""}: ${before.verdict} -> ${after.verdict}, expected ${want}`,
      );
    }
    if (
      cls === "killed" &&
      after.verdict === "killed" &&
      after.killingTest !== before.killingTest
    ) {
      lines.push(
        `  note ${before.mutantCode}->${after.mutantCode}: killing test ${before.killingTest ?? "?"} -> ${after.killingTest ?? "?"}`,
      );
    }
    if (cls === "widened" || cls === "no-coverage") rerunCodesOfUncovered.push(after.mutantCode);
    if (after.verdict === "killed") sharedKilled++;
    if (after.verdict === "survived") sharedSurvived++;
  }
  for (const cls of Object.keys(EXPECTED_CLASSES) as MutantClass[]) {
    const want = EXPECTED_CLASSES[cls].count;
    lines.push(
      `  class ${cls}: ${seen[cls]} shared (expected ${want}) -> ${EXPECTED_CLASSES[cls].verdict}`,
    );
    if (seen[cls] !== want)
      failures.push(`class ${cls} has ${seen[cls]} shared mutants, expected ${want}`);
  }
  for (const m of moved) failures.push(`moved: ${m}`);
  lines.push(
    `shared score: ${sharedKilled}/${sharedKilled + sharedSurvived} (expected ${EXPECTED_SHARED_SCORE.killed}/${EXPECTED_SHARED_SCORE.killed + EXPECTED_SHARED_SCORE.survived})`,
  );
  if (
    sharedKilled !== EXPECTED_SHARED_SCORE.killed ||
    sharedSurvived !== EXPECTED_SHARED_SCORE.survived
  ) {
    failures.push(`shared score ${sharedKilled}/${sharedKilled + sharedSurvived} != expected`);
  }

  // R175's own mechanism claim: unplaceable is all-or-nothing for a single object.
  const unplaceable = rerun.unplaceableCount ?? 0;
  lines.push(
    `unplaceableCount: ${unplaceable} (expected one of ${JSON.stringify(EXPECTED_UNPLACEABLE)})`,
  );
  if (!EXPECTED_UNPLACEABLE.includes(unplaceable))
    failures.push(`unplaceableCount ${unplaceable} is neither 0 nor 99`);
  if (unplaceable === 99) {
    const listed = [...(rerun.unplaceableMutants ?? [])].sort().join(",");
    const expected = [...rerunCodesOfUncovered].sort().join(",");
    if (listed !== expected)
      failures.push("unplaceableMutants is not exactly the 85 widened plus the 14 no-coverage");
    else lines.push("  unplaceableMutants is exactly the 85 widened plus the 14 no-coverage");
  }
  lines.push(`whole-run: score=${rerun.mutationScore} counts=${JSON.stringify(rerun.counts)}`);
  return { failures, lines };
}

if (import.meta.main) {
  const [rung1Path, rerunPath] = process.argv.slice(2);
  if (rung1Path === undefined || rerunPath === undefined) {
    console.error(
      "usage: bun scripts/r175-rung1-rerun-compare.ts <rung1.report.json> <rerun.report.json>",
    );
    process.exit(2);
  }
  const rung1 = (await Bun.file(rung1Path).json()) as ReportDoc;
  const rerun = (await Bun.file(rerunPath).json()) as ReportDoc;
  const { failures, lines } = compare(rung1, rerun);
  for (const l of lines) console.log(l);
  if (failures.length > 0) {
    console.log(`\nREFUTED: ${failures.length} pre-committed claim(s) failed`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log("\nPASS: every pre-committed claim held");
}
