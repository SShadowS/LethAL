#!/usr/bin/env bun
/**
 * R-994: the cheap check every corpus window starts with. It runs the WHOLE baseline but only a few small files' mutants
 * (`lethal run --only <file>...`, R-975's re-sweep method), then stops by name when the window would measure nothing:
 *
 *   exit 0   go               the baseline has green tests and none of the stops below
 *   exit 10  no-baseline      no report, or no baseline rows in the store (the run failed; read triage.stderr.txt)
 *   exit 11  fallback         the serve-entries default fell back to one-shot (caveat al-runner-v3-serve-default-fallback*)
 *   exit 12  no-license       al-runner refused a test "with no license file loaded" (R956: set alRunnerV3.license)
 *   exit 13  uniform-refusal  every baseline test was refused (notRun) for one and the same cause
 *   exit 14  zero-green       no baseline test passed
 *   exit 15  fallback-unchecked  no mutant of the --only files reached a test, so serve never ran and the fallback check
 *                             proves nothing (Avalara's warm-up fallback was invisible on a page extension's 2 uncovered
 *                             mutants): pass --only files whose code the tests run
 *   exit 2   usage; exit 1 a failed dry run
 *
 * The run goes through `scripts/heavy-slot.sh --wait --peak <peak> <class>` and is retried only on its exit 75.
 * Without `--only`, a dry run lists the files and `pickFiles` takes the smallest codeunits (see there). Writes
 * triage.{sqlite,report.json,events.ndjson,stdout.txt,stderr.txt,json} under --dir. Names and counts only; a cause is
 * al-runner's first line with digits masked. `--budget-s` (default 300) bounds only the mutant phase, which needs just
 * enough mutants to reach serve; the run's own exit 7 then means the budget ran out, not a failure.
 * Measured 2026-11-14 on al-runner edge-a184cfc79: Service Declaration GO in 5 min; Avalara STOP fallback in 7 min
 * (its full R-986 window had spent 4 h before the same fallback showed).
 *
 * usage: bun scripts/triage-baseline.ts --project <dir> --tests <dir> --config <file> --dir <out dir>
 *          [--only <file>]... [--peak serve] [--class baseapp|other] [--budget-s 300]
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

export interface BaselineRow {
  readonly test: string;
  readonly outcome: string;
  readonly message: string;
}

export interface Triage {
  readonly stop:
    | "go"
    | "no-baseline"
    | "fallback"
    | "no-license"
    | "uniform-refusal"
    | "zero-green"
    | "fallback-unchecked";
  readonly detail: string;
  readonly tests: number;
  readonly green: number;
  readonly refused: number;
}

export const EXIT: Record<Triage["stop"], number> = {
  go: 0,
  "no-baseline": 10,
  fallback: 11,
  "no-license": 12,
  "uniform-refusal": 13,
  "zero-green": 14,
  "fallback-unchecked": 15,
};

/** What the run's report says; undefined when none was written. */
export interface ReportFacts {
  readonly caveats: readonly string[];
  readonly mutants: number;
  readonly noCoverage: number;
}

const cause = (m: string): string => (m.split("\n")[0] ?? "").replace(/\d+/g, "N").slice(0, 150);
const isRefused = (r: BaselineRow): boolean => r.message.startsWith("NotRun");

/** The stop rule, first match wins. */
export function classify(rows: readonly BaselineRow[], report: ReportFacts | undefined): Triage {
  const green = rows.filter((r) => r.outcome === "pass").length;
  const refusedRows = rows.filter(isRefused);
  const counts = { tests: rows.length, green, refused: refusedRows.length };
  const say = (stop: Triage["stop"], detail: string): Triage => ({ stop, detail, ...counts });
  if (report === undefined) return say("no-baseline", "no report was written");
  if (rows.length === 0) return say("no-baseline", "the store holds no baseline rows");
  const fb = report.caveats.filter((c) => c.startsWith("al-runner-v3-serve-default-fallback"));
  if (fb.length > 0) return say("fallback", fb.join(", "));
  const lic = rows.filter((r) => r.message.includes("with no license file loaded"));
  if (lic.length > 0)
    return say("no-license", `${lic.length} test(s) refused with no license file loaded`);
  const causes = new Set(refusedRows.map((r) => cause(r.message)));
  if (refusedRows.length === rows.length && causes.size === 1)
    return say("uniform-refusal", `all ${rows.length} refused: ${[...causes][0]}`);
  if (green === 0)
    return say("zero-green", `0 of ${rows.length} green; ${refusedRows.length} refused`);
  if (report.mutants === report.noCoverage)
    return say(
      "fallback-unchecked",
      `${green} of ${rows.length} green, but 0 of ${report.mutants} mutant(s) reached a test, so serve never ran: pass --only a file the tests cover`,
    );
  return say("go", `${green} of ${rows.length} green; ${refusedRows.length} refused`);
}

/** The latest run's baseline rows (a warm-up fallback abandons its run and starts a new one). */
export function baselineRows(dbPath: string): BaselineRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .query(
        `select codeunit_name || '.' || method as test, outcome, coalesce(failure_message, '') as message
           from test_results where mutant_row_id is null and run_id = (select max(id) from runs) order by id`,
      )
      .all() as BaselineRow[];
    // A test baselined twice in the run (isolation auto's method re-baseline, R921) keeps its last row.
    return [...new Map(rows.map((r) => [r.test, r])).values()];
  } finally {
    db.close();
  }
}

const CLI = resolve(import.meta.dir, "../packages/runner/src/cli.ts");
const SLOT = resolve(import.meta.dir, "heavy-slot.sh");

function smallestFiles(project: string, tests: string, config: string, dir: string): string[] {
  const out = join(dir, "triage.dry.json");
  const r = Bun.spawnSync(
    [
      "bun",
      CLI,
      "run",
      "--dry-run",
      "--project",
      project,
      "--tests",
      tests,
      "--config",
      config,
      "--backend",
      "al-runner-v3",
      "--db",
      join(dir, "triage.dry.sqlite"),
      "--allow-large-run",
      "--out",
      out,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  if (r.exitCode !== 0)
    throw new Error(`dry run failed (exit ${r.exitCode}): ${r.stderr.toString().slice(-500)}`);
  const perFile = (
    JSON.parse(readFileSync(out, "utf8")) as { perFile: { file: string; deployed: number }[] }
  ).perFile;
  const files = pickFiles(perFile);
  if (files.length === 0)
    throw new Error("the dry run lists no file with a deployed mutant: nothing to run --only on");
  return files;
}

/**
 * The smallest codeunit files (fewest deployed mutants, ties by name), skipping upgrade and install codeunits, until
 * they hold 100 mutants or 8 files; the smallest file of any kind when there is no such codeunit. Several files,
 * because one is often uncovered (Service Declaration's two smallest codeunits: 0 of 23 and 0 of 30) and serve then
 * never runs; the time budget still caps the mutant phase.
 * shortcut: a name heuristic; the fallback-unchecked stop catches a pick it gets wrong.
 */
export function pickFiles(perFile: readonly { file: string; deployed: number }[]): string[] {
  const ranked = perFile
    .filter((f) => f.deployed > 0)
    .sort((a, b) => a.deployed - b.deployed || a.file.localeCompare(b.file));
  const codeunits = ranked.filter(
    (f) => /\.codeunit\.al$/i.test(f.file) && !/(upgrade|install)[^/]*$/i.test(f.file),
  );
  const picked: string[] = [];
  let mutants = 0;
  for (const f of codeunits) {
    if (mutants >= 100 || picked.length >= 8) break;
    picked.push(f.file);
    mutants += f.deployed;
  }
  const first = ranked[0];
  return picked.length > 0 ? picked : first !== undefined ? [first.file] : [];
}

async function main(): Promise<number> {
  const { values: v } = parseArgs({
    options: {
      project: { type: "string" },
      tests: { type: "string" },
      config: { type: "string" },
      dir: { type: "string" },
      only: { type: "string", multiple: true },
      peak: { type: "string", default: "serve" },
      class: { type: "string", default: "other" },
      "budget-s": { type: "string", default: "300" },
    },
  });
  const { project, tests, config, dir } = v;
  const budget = Number(v["budget-s"]);
  if (
    project === undefined ||
    tests === undefined ||
    config === undefined ||
    dir === undefined ||
    !(budget > 0)
  ) {
    console.error(
      "usage: bun scripts/triage-baseline.ts --project <dir> --tests <dir> --config <file> --dir <out dir> [--only <file>]... [--peak serve] [--class baseapp|other] [--budget-s 300]",
    );
    return 2;
  }
  mkdirSync(dir, { recursive: true });
  const only = v.only ?? smallestFiles(project, tests, config, dir);
  const p = (s: string) => join(dir, `triage.${s}`);
  for (const f of ["sqlite", "sqlite-shm", "sqlite-wal", "report.json"])
    rmSync(p(f), { force: true });
  let rc: number;
  for (;;) {
    rc =
      Bun.spawnSync(
        [
          "bash",
          SLOT,
          "--wait",
          "--peak",
          v.peak ?? "serve",
          v.class ?? "other",
          "timeout",
          String(budget + 600),
          "bun",
          CLI,
          "run",
          "--project",
          project,
          "--tests",
          tests,
          "--backend",
          "al-runner-v3",
          "--config",
          config,
          "--db",
          p("sqlite"),
          ...only.flatMap((f) => ["--only", f]),
          "--time-budget",
          String(budget),
          "--allow-large-run",
          "--out",
          p("report.json"),
          "--progress-out",
          p("events.ndjson"),
        ],
        { stdout: Bun.file(p("stdout.txt")), stderr: Bun.file(p("stderr.txt")) },
      ).exitCode ?? 1;
    if (rc !== 75) break;
    await Bun.sleep(60_000);
  }
  let facts: ReportFacts | undefined;
  if (existsSync(p("report.json"))) {
    const r = JSON.parse(readFileSync(p("report.json"), "utf8")) as {
      validity: { caveats: string[] };
      mutants: unknown[];
      counts: { noCoverage: number };
    };
    facts = {
      caveats: r.validity.caveats,
      mutants: r.mutants.length,
      noCoverage: r.counts.noCoverage,
    };
  }
  const t = classify(existsSync(p("sqlite")) ? baselineRows(p("sqlite")) : [], facts);
  writeFileSync(p("json"), `${JSON.stringify({ project, only, runExit: rc, ...t }, null, 2)}\n`);
  console.log(
    `TRIAGE ${t.stop === "go" ? "GO" : `STOP ${t.stop}`}: ${t.detail} (run exit ${rc}; --only ${only.join(" ")})`,
  );
  return EXIT[t.stop];
}

if (import.meta.main) process.exit(await main());
