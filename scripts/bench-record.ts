/**
 * Append a run's measured cost to `docs/benchmarks/runs.jsonl`, and compare runs.
 *
 * Why a durable file rather than reading the console: a mutation run's cost is only meaningful
 * against other runs. "163 mutants in 4 minutes" answers nothing on its own — the questions are
 * "what would 11,777 cost" (needs the per-mutant figure separated from the fixed deploy toll) and
 * "did this get slower" (needs the same shape measured before). Both need history, and a session
 * ledger under `.superpowers/` is scratch that gets archived.
 *
 *   bun scripts/bench-record.ts add --report <report.json> --label <name> [--note "..."]
 *                                   [--env-kind container|envtool] [--env-id <id>]
 *                                   [--phase <name> --phase-ms <n>]...
 *   bun scripts/bench-record.ts list [--label <name>]
 *   bun scripts/bench-record.ts compare --label <name>     # newest two runs of that label
 *
 * `--phase` records costs the runner cannot see because they happen outside it — environment
 * provisioning, prerequisite publishing. They are kept separate from `timings` for exactly that
 * reason: folding a 191s environment create into a mutation-run total would make the run look
 * slow and would poison every later comparison.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import type { SessionReport } from "../packages/runner/src/report";

const LEDGER = join(import.meta.dir, "..", "docs", "benchmarks", "runs.jsonl");

/** One recorded run. Flat and additive on purpose — a reader three months from now compares
 *  columns, and a renamed field silently breaks that comparison. */
interface BenchRecord {
  readonly ts: string;
  readonly label: string;
  readonly note?: string;
  readonly git: { readonly commit: string; readonly dirty: boolean };
  readonly backend: string;
  readonly authoritative: boolean;
  readonly envKind?: string;
  readonly envId?: string;
  readonly scope: {
    readonly onlyPatterns?: readonly string[];
    readonly excludedFileCount?: number;
    readonly totalAlFiles: number;
    readonly notInstrumentedFiles: number;
    readonly notInstrumentedSites: number;
  };
  readonly result: {
    readonly batches: number;
    readonly mutants: number;
    readonly killed: number;
    readonly survived: number;
    readonly noCoverage: number;
    readonly errors: number;
    readonly mutationScore: number | null;
    readonly baselineGreen: boolean;
  };
  readonly timings: SessionReport["timings"];
  /** Costs measured OUTSIDE the runner — environment create/start, prerequisite publishing. */
  readonly externalPhasesMs?: Readonly<Record<string, number>>;
}

async function sh(cmd: string[]): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim();
}

async function readLedger(): Promise<BenchRecord[]> {
  try {
    const text = await readFile(LEDGER, "utf8");
    return text
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as BenchRecord);
  } catch {
    return [];
  }
}

function perMutantSummary(r: BenchRecord): string {
  const t = r.timings;
  const overhead = Math.max(0, t.totalMs - t.deployMs - t.baselineMs - t.mutantsMs);
  return (
    `total ${(t.totalMs / 1000).toFixed(1)}s | deploy ${(t.deployMs / 1000).toFixed(1)}s | ` +
    `baseline ${(t.baselineMs / 1000).toFixed(1)}s | mutants ${(t.mutantsMs / 1000).toFixed(1)}s | ` +
    `overhead ${(overhead / 1000).toFixed(1)}s | per-mutant mean ${t.perMutant.meanMs}ms ` +
    `median ${t.perMutant.medianMs}ms p95 ${t.perMutant.p95Ms}ms (n=${t.perMutant.count})`
  );
}

/**
 * What a bigger run would cost, from this one. Deploy and baseline are treated as FIXED (they
 * scale with project size and test count, not with mutant count) and only the per-mutant term is
 * multiplied — the whole reason the phases are recorded apart. Stated as an estimate, never
 * folded into the record: an extrapolation stored beside measurements is eventually read as one.
 */
function extrapolate(r: BenchRecord, targetMutants: number): string {
  const t = r.timings;
  if (t.perMutant.count === 0) return "no mutants ran — nothing to extrapolate from";
  const fixedMs = t.deployMs + t.baselineMs + t.generateMutationSetMs;
  const overheadPerMutantMs =
    Math.max(0, t.totalMs - t.deployMs - t.baselineMs - t.mutantsMs) / t.perMutant.count;
  const estMs = fixedMs + targetMutants * (t.perMutant.meanMs + overheadPerMutantMs);
  const hours = estMs / 3_600_000;
  return `${targetMutants} mutants ~= ${hours.toFixed(1)}h (fixed ${(fixedMs / 1000).toFixed(0)}s + ${targetMutants} x ${Math.round(t.perMutant.meanMs + overheadPerMutantMs)}ms)`;
}

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    report: { type: "string" },
    label: { type: "string" },
    note: { type: "string" },
    "env-kind": { type: "string" },
    "env-id": { type: "string" },
    phase: { type: "string", multiple: true },
    "phase-ms": { type: "string", multiple: true },
    extrapolate: { type: "string" },
  },
});

const command = positionals[0] ?? "list";

if (command === "add") {
  const reportPath = values.report;
  const label = values.label;
  if (reportPath === undefined || label === undefined) {
    throw new Error("add requires --report <path> and --label <name>");
  }
  const report = JSON.parse(await readFile(reportPath, "utf8")) as SessionReport;
  if (report.timings === undefined) {
    throw new Error(
      `${reportPath} has no "timings" block — it was produced by a build predating the cost instrumentation. Recording it would put a row with no measurements into the ledger.`,
    );
  }

  const phases = values.phase ?? [];
  const phaseMs = values["phase-ms"] ?? [];
  if (phases.length !== phaseMs.length) {
    throw new Error(
      `--phase given ${phases.length} time(s) but --phase-ms ${phaseMs.length} time(s); each --phase needs exactly one --phase-ms, in the same order`,
    );
  }
  const externalPhasesMs: Record<string, number> = {};
  for (const [i, name] of phases.entries()) {
    const raw = phaseMs[i];
    const ms = Number(raw);
    if (!Number.isFinite(ms)) throw new Error(`--phase-ms for "${name}" is not a number: ${raw}`);
    externalPhasesMs[name] = ms;
  }

  const record: BenchRecord = {
    ts: new Date().toISOString(),
    label,
    ...(values.note !== undefined ? { note: values.note } : {}),
    git: {
      commit: await sh(["git", "rev-parse", "--short", "HEAD"]),
      dirty: (await sh(["git", "status", "--porcelain"])) !== "",
    },
    backend: report.backend,
    authoritative: report.authoritative,
    ...(values["env-kind"] !== undefined ? { envKind: values["env-kind"] } : {}),
    ...(values["env-id"] !== undefined ? { envId: values["env-id"] } : {}),
    scope: {
      ...(report.only !== undefined
        ? { onlyPatterns: report.only.patterns, excludedFileCount: report.only.excludedFileCount }
        : {}),
      totalAlFiles: report.notInstrumented.totalFiles,
      notInstrumentedFiles: report.notInstrumented.fileCount,
      notInstrumentedSites: report.notInstrumented.siteCount,
    },
    result: {
      batches: report.batches,
      mutants: report.mutants.length,
      killed: report.counts.killed,
      survived: report.counts.survived,
      noCoverage: report.counts.noCoverage,
      errors: report.counts.errors,
      mutationScore: report.mutationScore,
      baselineGreen: report.baselineGreen,
    },
    timings: report.timings,
    ...(Object.keys(externalPhasesMs).length > 0 ? { externalPhasesMs } : {}),
  };

  await mkdir(dirname(LEDGER), { recursive: true });
  await appendFile(LEDGER, `${JSON.stringify(record)}\n`, "utf8");
  console.log(`recorded "${label}" -> ${LEDGER}`);
  console.log(`  ${perMutantSummary(record)}`);
  if (values.extrapolate !== undefined) {
    console.log(`  extrapolated: ${extrapolate(record, Number(values.extrapolate))}`);
  }
} else if (command === "list") {
  const rows = (await readLedger()).filter(
    (r) => values.label === undefined || r.label === values.label,
  );
  if (rows.length === 0) {
    console.log("no runs recorded");
  }
  for (const r of rows) {
    console.log(
      `${r.ts}  ${r.label.padEnd(24)} ${r.git.commit}${r.git.dirty ? "*" : " "}  ` +
        `${r.result.mutants} mutants (${r.result.killed}/${r.result.survived}/${r.result.noCoverage})`,
    );
    console.log(`    ${perMutantSummary(r)}`);
  }
} else if (command === "compare") {
  const label = values.label;
  const rows = (await readLedger()).filter((r) => label === undefined || r.label === label);
  if (rows.length < 2) {
    console.log(`need at least 2 runs${label ? ` labelled "${label}"` : ""} to compare`);
  } else {
    const b = rows[rows.length - 1];
    const a = rows[rows.length - 2];
    if (a === undefined || b === undefined) throw new Error("unreachable");
    const delta = (x: number, y: number) => {
      // A percentage against a zero baseline is not "infinite growth", it is "no baseline". Say so.
      if (x === 0) return y === 0 ? "0" : `+${y} (no baseline)`;
      const pct = ((y - x) / x) * 100;
      return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
    };
    console.log(`${a.ts} (${a.git.commit})  ->  ${b.ts} (${b.git.commit})`);
    console.log(`  mutants:      ${a.result.mutants} -> ${b.result.mutants}`);
    console.log(
      `  verdicts:     ${a.result.killed}/${a.result.survived}/${a.result.noCoverage} -> ${b.result.killed}/${b.result.survived}/${b.result.noCoverage}${
        a.result.killed !== b.result.killed || a.result.survived !== b.result.survived
          ? "   <-- VERDICTS DIFFER"
          : ""
      }`,
    );
    console.log(
      `  total:        ${(a.timings.totalMs / 1000).toFixed(1)}s -> ${(b.timings.totalMs / 1000).toFixed(1)}s  (${delta(a.timings.totalMs, b.timings.totalMs)})`,
    );
    console.log(
      `  deploy:       ${(a.timings.deployMs / 1000).toFixed(1)}s -> ${(b.timings.deployMs / 1000).toFixed(1)}s  (${delta(a.timings.deployMs, b.timings.deployMs)})`,
    );
    console.log(
      `  per-mutant:   ${a.timings.perMutant.meanMs}ms -> ${b.timings.perMutant.meanMs}ms  (${delta(a.timings.perMutant.meanMs, b.timings.perMutant.meanMs)})`,
    );
  }
} else {
  throw new Error(`unknown command "${command}" (expected add | list | compare)`);
}
