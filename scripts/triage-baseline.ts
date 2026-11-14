#!/usr/bin/env bun
/**
 * R-994: the cheap check every corpus window starts with. It runs the WHOLE baseline but only a few small files' mutants
 * (`lethal run --only <file>...`, R-975's re-sweep method), then stops by name when the window would measure nothing:
 *
 *   exit 0   go                  the baseline has green tests, a mutant reached a test, and none of the stops below
 *   exit 10  no-baseline         no baseline rows in the store (read triage.stderr.txt)
 *   exit 11  fallback            the serve-entries default fell back to one-shot (caveat al-runner-v3-serve-default-fallback*)
 *   exit 12  no-license          al-runner refused a test "with no license file loaded" (R956: set alRunnerV3.license)
 *   exit 13  uniform-refusal     every baseline test was refused (notRun) for one and the same cause
 *   exit 14  zero-green          no baseline test passed
 *   exit 16  run-failed          the run itself ended badly: no report, quarantined (3), nothing scored (4), killed by the
 *                                timeout (124/137), or crashed; the baseline rules above come first, as they name the
 *                                cause better
 *   exit 15  fallback-unchecked  no mutant of the --only files reached a test, so serve never ran and the fallback check
 *                                proves nothing (Avalara's warm-up fallback was invisible on a page extension's 2 uncovered
 *                                mutants): pass --only files whose code the tests run
 *   exit 2   usage; exit 1 a failed dry run
 *
 * The run goes through `scripts/heavy-slot.sh --wait --peak <peak> <class>`, is retried only on its exit 75, and is
 * killed by `timeout -k 120 <--timeout-s>` (default 3600). Without `--only`, a dry run lists the files and `pickFiles`
 * takes the smallest codeunits (see there). `--budget-s` (default 900) is passed as `--time-budget`, so a project
 * whose mutants fell back to slow one-shot runs stops early (Avalara without a budget: about 50 min of mutants after
 * its fallback). LethAL's budget counts from the session start, baseline included: a baseline longer than the budget
 * leaves no mutant to run, and fallback-unchecked then says to raise `--budget-s`. Exit 7 is the budget, not a
 * failure. Writes triage.{sqlite,report.json,events.ndjson,stdout.txt,stderr.txt,json} under --dir. Names and
 * counts only; a cause is al-runner's first line with digits masked.
 * Measured 2026-11-14 on al-runner edge-a184cfc79: Service Declaration GO in 5 min; Avalara STOP fallback in 7-9 min
 * (its full R-986 window had spent 4 h before the same fallback showed).
 *
 * usage: bun scripts/triage-baseline.ts --project <dir> --tests <dir> --config <file> --dir <out dir>
 *          [--only <file>]... [--peak serve] [--class baseapp|other] [--timeout-s 3600] [--budget-s 900]
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
    | "fallback-unchecked"
    | "run-failed";
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
  "run-failed": 16,
};

/**
 * What the run left: its exit code, whether it wrote a report, the caveats (the report's, or with no report the
 * fallback codes its stderr printed, so a run killed after its fallback still names it), and its mutants' test rows.
 */
export interface RunFacts {
  readonly rc: number;
  readonly reported: boolean;
  readonly caveats: readonly string[];
  readonly mutantTestRows: number;
}

const RC_MEANING: Record<number, string> = {
  1: "crashed",
  3: "quarantined",
  4: "nothing scored (all-errors)",
  124: "killed by the timeout",
  137: "killed by the timeout (SIGKILL)",
};

const cause = (m: string): string => (m.split("\n")[0] ?? "").replace(/\d+/g, "N").slice(0, 150);
// Both stored forms: al-runner's "NotRun: ..." anywhere (after "Runtime error: ", R639/R675), or the backend's
// "[al-runner v3 did not run this test (notRun) ...]" suffix (also after "<no message>").
const isRefused = (r: BaselineRow): boolean => /NotRun:|\(notRun\)/.test(r.message);

/** The stop rule, first match wins. */
export function classify(rows: readonly BaselineRow[], run: RunFacts): Triage {
  const green = rows.filter((r) => r.outcome === "pass").length;
  const refusedRows = rows.filter(isRefused);
  const counts = { tests: rows.length, green, refused: refusedRows.length };
  const say = (stop: Triage["stop"], detail: string): Triage => ({ stop, detail, ...counts });
  const exit = `run exit ${run.rc}${RC_MEANING[run.rc] !== undefined ? ` (${RC_MEANING[run.rc]})` : ""}`;
  if (rows.length === 0) return say("no-baseline", `the store holds no baseline rows; ${exit}`);
  const fb = run.caveats.filter((c) => c.startsWith("al-runner-v3-serve-default-fallback"));
  if (fb.length > 0) return say("fallback", fb.join(", "));
  const lic = rows.filter((r) => r.message.includes("with no license file loaded"));
  if (lic.length > 0)
    return say("no-license", `${lic.length} test(s) refused with no license file loaded`);
  const causes = new Set(refusedRows.map((r) => cause(r.message)));
  if (refusedRows.length === rows.length && causes.size === 1)
    return say("uniform-refusal", `all ${rows.length} refused: ${[...causes][0]}`);
  if (green === 0)
    return say("zero-green", `0 of ${rows.length} green; ${refusedRows.length} refused`);
  if (!run.reported) return say("run-failed", `no report was written; ${exit}`);
  if (run.rc !== 0 && run.rc !== 7) return say("run-failed", exit);
  if (run.mutantTestRows === 0)
    return say(
      "fallback-unchecked",
      run.caveats.includes("time-budget-reached")
        ? `${green} of ${rows.length} green, but the time budget ran out before any mutant reached a test (it counts the baseline too): raise --budget-s`
        : `${green} of ${rows.length} green, but no mutant reached a test, so serve never ran: pass --only files the tests cover`,
    );
  return say("go", `${green} of ${rows.length} green; ${refusedRows.length} refused`);
}

/** The latest run's baseline rows (a warm-up fallback abandons its run and starts a new one) and its mutants' test rows. */
export function readStore(dbPath: string): { rows: BaselineRow[]; mutantTestRows: number } {
  const db = new Database(dbPath, { readonly: true });
  try {
    const latest = "run_id = (select max(id) from runs)";
    const rows = db
      .query(
        `select codeunit_name || '.' || method as test, outcome, coalesce(failure_message, '') as message
           from test_results where mutant_row_id is null and ${latest} order by id`,
      )
      .all() as BaselineRow[];
    const m = db
      .query(`select count(*) as n from test_results where mutant_row_id is not null and ${latest}`)
      .get() as { n: number };
    // A test baselined twice in the run (isolation auto's method re-baseline, R921) keeps its last row.
    return { rows: [...new Map(rows.map((r) => [r.test, r])).values()], mutantTestRows: m.n };
  } finally {
    db.close();
  }
}

const CLI = resolve(import.meta.dir, "../packages/runner/src/cli.ts");
const SLOT = resolve(import.meta.dir, "heavy-slot.sh");

function smallestFiles(project: string, tests: string, config: string, dir: string): string[] {
  const out = join(dir, "triage.dry.json");
  for (const f of ["dry.sqlite", "dry.sqlite-shm", "dry.sqlite-wal", "dry.json"])
    rmSync(join(dir, `triage.${f}`), { force: true });
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
  const files = pickFiles(perFile, (file) => kindOf(readFileSync(join(project, file), "utf8")));
  if (files.length === 0)
    throw new Error("the dry run lists no file with a deployed mutant: nothing to run --only on");
  return files;
}

/** A file's object kind from its text, not its name (`Cod50100.al` is a codeunit too). */
export function kindOf(text: string): "codeunit" | "setup" | "other" {
  if (!/^\s*codeunit\s+\d+/im.test(text)) return "other";
  return /\bSubtype\s*=\s*(Upgrade|Install)\s*;/i.test(text) ? "setup" : "codeunit";
}

/**
 * The smallest codeunit files (fewest deployed mutants, ties by name), skipping install and upgrade codeunits, which
 * tests rarely run, until they hold 100 mutants or 8 files; the file that crosses 100 is taken unless it would pass
 * 300 (there is no time budget, so this bounds the mutant phase). The smallest file of any kind when there is no
 * such codeunit. Several files, because small ones are often uncovered: Service Declaration's two smallest
 * codeunits had 0 of 23 and 0 of 30 covered, and only its third (134 mutants, the one crossing 100) reached serve.
 * A path holding a glob character is skipped: `--only` reads it as a pattern.
 * shortcut: "small codeunit" only guesses at coverage; the fallback-unchecked stop catches a pick it gets wrong.
 */
export function pickFiles(
  perFile: readonly { file: string; deployed: number }[],
  kind: (file: string) => "codeunit" | "setup" | "other",
): string[] {
  const ranked = perFile
    .filter((f) => f.deployed > 0 && !/[[\]{}*?]/.test(f.file))
    .sort((a, b) => a.deployed - b.deployed || a.file.localeCompare(b.file));
  const picked: string[] = [];
  let mutants = 0;
  for (const f of ranked) {
    if (kind(f.file) !== "codeunit") continue;
    if (picked.length > 0 && (picked.length >= 8 || mutants >= 100 || mutants + f.deployed > 300))
      break;
    picked.push(f.file);
    mutants += f.deployed;
  }
  const first = ranked[0];
  return picked.length > 0 ? picked : first !== undefined ? [first.file] : [];
}

/** The fallback caveat codes a run printed on stderr (its notice names the code), for a run that wrote no report. */
export function stderrFallbacks(stderr: string): string[] {
  return [...new Set(stderr.match(/al-runner-v3-serve-default-fallback(?:-warmup)?/g) ?? [])];
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
      "timeout-s": { type: "string", default: "3600" },
      "budget-s": { type: "string", default: "900" },
    },
  });
  const { project, tests, config, dir } = v;
  const timeoutS = Number(v["timeout-s"]);
  const budget = v["budget-s"] ?? "900";
  if (
    project === undefined ||
    tests === undefined ||
    config === undefined ||
    dir === undefined ||
    !(timeoutS > 0) ||
    !(Number(budget) > 0)
  ) {
    console.error(
      "usage: bun scripts/triage-baseline.ts --project <dir> --tests <dir> --config <file> --dir <out dir> [--only <file>]... [--peak serve] [--class baseapp|other] [--timeout-s 3600] [--budget-s 900]",
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
          "-k",
          "120",
          String(timeoutS),
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
          budget,
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
  const reported = existsSync(p("report.json"));
  const caveats = reported
    ? (JSON.parse(readFileSync(p("report.json"), "utf8")) as { validity: { caveats: string[] } })
        .validity.caveats
    : existsSync(p("stderr.txt"))
      ? stderrFallbacks(readFileSync(p("stderr.txt"), "utf8"))
      : [];
  const store = existsSync(p("sqlite")) ? readStore(p("sqlite")) : { rows: [], mutantTestRows: 0 };
  const t = classify(store.rows, { rc, reported, caveats, mutantTestRows: store.mutantTestRows });
  writeFileSync(p("json"), `${JSON.stringify({ project, only, runExit: rc, ...t }, null, 2)}\n`);
  console.log(
    `TRIAGE ${t.stop === "go" ? "GO" : `STOP ${t.stop}`}: ${t.detail} (run exit ${rc}; --only ${only.join(" ")})`,
  );
  return EXIT[t.stop];
}

if (import.meta.main) process.exit(await main());
