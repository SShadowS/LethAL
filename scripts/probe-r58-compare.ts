#!/usr/bin/env bun
/**
 * Applies R58's gate rules to two `probe-r58-differential.ts` dumps of the SAME project.
 *
 * Reports, in the order the spec asks for them — cheapest and most localised first:
 *
 *  1. **The cheap oracle.** Per-test coverage-set diff. A member-level entry the fence produces and
 *     the hub does not is a mapping bug, named as a `(test, object, procedure)` triple rather than
 *     laundered through a verdict. On Continia Document Output the EXPECTED difference is exactly
 *     the 12 hub-failing tests' coverage: those tests execute a different branch on the two
 *     runners (R55/R57), so their coverage legitimately differs. Anything else is a defect.
 *  2. **Per-mutant.** Joined on `mutantCode`, with the join VERIFIED (same file, line and operator
 *     at the same code) before any verdict is compared — an unverified join would silently pair
 *     different mutants and report nonsense with confidence.
 *  3. **Aggregate counts**, last, because they are the weakest signal.
 *
 * BLOCKING (exit 1):
 *  - any mutant moving `killed` -> `survived` — fenced coverage lost a killing test, which is R59
 *  - any `mutantCode` identity mismatch — the join itself is unsafe
 *  - a fenced baseline that is not green while the hub's was
 *
 * REPORTED but not blocking, because each is a known-shaped GAIN or a bounded loss the operator
 * must read: `no-coverage` -> `survived`/`killed` (the 14 DO mutants R55 measured), `survived` ->
 * `killed` (the hub was under-reporting), covering-set and `attribution` changes, moves to `error`.
 */
import { readFile } from "node:fs/promises";

interface MutantDump {
  readonly mutantCode: string;
  readonly file: string;
  readonly line: number;
  readonly operatorName: string;
  readonly verdict: string;
  readonly attribution: string | null;
  readonly coveringTests: readonly string[];
}

interface Dump {
  readonly mode: string;
  readonly project: string;
  readonly durationMs: number;
  readonly counts: Record<string, number>;
  readonly baselineGreen: boolean;
  readonly baselineOutcomes: Record<string, string>;
  readonly baselineCoverage: Record<string, readonly string[]>;
  readonly mutants: readonly MutantDump[];
}

const [aPath, bPath] = process.argv.slice(2);
if (aPath === undefined || bPath === undefined) {
  throw new Error("usage: probe-r58-compare.ts <baseline-dump.json> <candidate-dump.json>");
}
/**
 * Accepts EITHER a `probe-r58-differential.ts` dump or a plain `lethal run --out` `SessionReport`.
 *
 * The two carry the same per-mutant fields under one different name (`coverageAttribution` vs
 * `attribution`), and a real project reached through an environment tool is driven by the CLI, not
 * by the probe — so refusing the report shape would mean the largest target could not be gated at
 * all. A report simply has no per-test coverage, and the oracle section then says so rather than
 * silently reporting "0 differences", which is the shape this project treats as its signature bug.
 */
async function load(path: string, label: string): Promise<Dump> {
  const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  if (raw.baselineCoverage !== undefined) return raw as unknown as Dump;
  const mutants = (raw.mutants ?? []) as Array<Record<string, unknown>>;
  return {
    mode: label,
    project: String(raw.projectDir ?? path),
    durationMs: Number((raw.timings as { totalMs?: number } | undefined)?.totalMs ?? 0),
    counts: (raw.counts ?? {}) as Record<string, number>,
    baselineGreen: raw.baselineGreen === true,
    baselineOutcomes: {},
    baselineCoverage: {},
    mutants: mutants.map((m) => ({
      mutantCode: String(m.mutantCode),
      file: String(m.file),
      line: Number(m.line),
      operatorName: String(m.operatorName),
      verdict: String(m.verdict),
      attribution: (m.coverageAttribution ?? null) as string | null,
      coveringTests: [...((m.coveringTests ?? []) as string[])].sort(),
    })),
  };
}

const a = await load(aPath, "A");
const b = await load(bPath, "B");
const blocking: string[] = [];

console.log(`# R58 differential — ${a.mode} (A) vs ${b.mode} (B) on ${a.project}\n`);

// ---------------------------------------------------------------- 1. the cheap oracle
console.log("## Per-test coverage sets (the cheap oracle)\n");
const tests = [
  ...new Set([...Object.keys(a.baselineCoverage), ...Object.keys(b.baselineCoverage)]),
].sort();
let identicalTests = 0;
for (const t of tests) {
  const av = new Set(a.baselineCoverage[t] ?? []);
  const bv = new Set(b.baselineCoverage[t] ?? []);
  const onlyA = [...av].filter((x) => !bv.has(x));
  const onlyB = [...bv].filter((x) => !av.has(x));
  const outcomeA = a.baselineOutcomes[t] ?? "<absent>";
  const outcomeB = b.baselineOutcomes[t] ?? "<absent>";
  if (onlyA.length === 0 && onlyB.length === 0 && outcomeA === outcomeB) {
    identicalTests++;
    continue;
  }
  console.log(`  ${t}  [A ${outcomeA} / B ${outcomeB}]`);
  for (const x of onlyA) console.log(`      only A: ${x}`);
  for (const x of onlyB) console.log(`      only B: ${x}`);
}
console.log(`  ${identicalTests}/${tests.length} tests identical in outcome AND coverage set\n`);

// ------------------------------------------------------- 2. per-mutant, on a verified join
console.log("## Per-mutant\n");
const byCode = new Map(a.mutants.map((m) => [m.mutantCode, m]));
const moves = new Map<string, number>();
let identityMismatches = 0;
let coveringChanged = 0;
let attributionChanged = 0;
for (const mb of b.mutants) {
  const ma = byCode.get(mb.mutantCode);
  if (ma === undefined) {
    identityMismatches++;
    console.log(`  ${mb.mutantCode}: present in B only`);
    continue;
  }
  // Verify the join BEFORE comparing anything that depends on it.
  if (ma.file !== mb.file || ma.line !== mb.line || ma.operatorName !== mb.operatorName) {
    identityMismatches++;
    console.log(
      `  ${mb.mutantCode}: IDENTITY MISMATCH — A ${ma.file}:${ma.line} ${ma.operatorName} vs ` +
        `B ${mb.file}:${mb.line} ${mb.operatorName}`,
    );
    continue;
  }
  if (ma.verdict !== mb.verdict) {
    const move = `${ma.verdict} -> ${mb.verdict}`;
    moves.set(move, (moves.get(move) ?? 0) + 1);
    console.log(`  ${mb.mutantCode} ${mb.file}:${mb.line} ${mb.operatorName}: ${move}`);
    if (ma.verdict === "killed" && mb.verdict === "survived") {
      blocking.push(`${mb.mutantCode} moved killed -> survived (a killing test was lost — R59)`);
    }
  }
  const av = ma.coveringTests.join(",");
  const bv = mb.coveringTests.join(",");
  if (av !== bv) {
    coveringChanged++;
    const onlyA = ma.coveringTests.filter((t) => !mb.coveringTests.includes(t));
    const onlyB = mb.coveringTests.filter((t) => !ma.coveringTests.includes(t));
    console.log(
      `  ${mb.mutantCode} covering set changed (${ma.coveringTests.length} -> ${mb.coveringTests.length})` +
        `${onlyA.length > 0 ? ` | only A: ${onlyA.join(", ")}` : ""}` +
        `${onlyB.length > 0 ? ` | only B: ${onlyB.join(", ")}` : ""}`,
    );
  }
  if (ma.attribution !== mb.attribution) {
    attributionChanged++;
    console.log(`  ${mb.mutantCode} attribution ${ma.attribution} -> ${mb.attribution}`);
  }
}
for (const ma of a.mutants) {
  if (!b.mutants.some((m) => m.mutantCode === ma.mutantCode)) {
    identityMismatches++;
    console.log(`  ${ma.mutantCode}: present in A only`);
  }
}
if (identityMismatches > 0) {
  blocking.push(`${identityMismatches} mutantCode identity mismatch(es) — the join is not safe`);
}
console.log(`\n  verdict moves: ${moves.size === 0 ? "none" : ""}`);
for (const [move, n] of [...moves].sort()) console.log(`    ${n} x ${move}`);
console.log(`  covering-set changes: ${coveringChanged}`);
console.log(`  attribution changes:  ${attributionChanged}`);
console.log(`  identity mismatches:  ${identityMismatches}\n`);

// ------------------------------------------------------------------- 3. aggregate, last
console.log("## Counts (weakest signal, reported last)\n");
console.log(`  A ${a.mode}: ${JSON.stringify(a.counts)} baselineGreen=${a.baselineGreen}`);
console.log(`  B ${b.mode}: ${JSON.stringify(b.counts)} baselineGreen=${b.baselineGreen}`);
console.log(
  `  A took ${(a.durationMs / 1000).toFixed(1)}s, B took ${(b.durationMs / 1000).toFixed(1)}s\n`,
);
if (a.baselineGreen && !b.baselineGreen) {
  blocking.push("the candidate baseline is RED where the reference baseline was green");
}

if (blocking.length > 0) {
  console.log("BLOCKED:");
  for (const x of blocking) console.log(`  - ${x}`);
  process.exit(1);
}
console.log("PASS — no blocking difference.");
