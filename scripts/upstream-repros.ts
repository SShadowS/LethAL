#!/usr/bin/env bun
/**
 * R-996: our invented upstream repros as a regression set on every al-runner build.
 *
 *   bun scripts/upstream-repros.ts --candidate <al-runner> [--current <al-runner>] [--out <report.json>]
 *
 * Every repro in `scripts/upstream-repros/manifest.json` is an invented AL app (no corpus source text) with the result BC gives
 * for each of its tests (`tests`: status, and the message or a part of it). Each repro runs on the candidate and on `current`
 * (`al-runner test --output-json`), and each test is compared with BC on both:
 *   - `flipped`: matches BC on the candidate, not on current: al-runner fixed it, so the repro's `rerun` projects are re-run;
 *   - `regressed`: matched BC on current, not on the candidate: a finding;
 *   - `still-differs` / `still-matches`: no change.
 * A repro that does not run (no JSON) is `error` on that build, never read as a match. The daily update (`al-runner-v3-update.ts`,
 * `gateOne`) runs it for each candidate and logs the report; it never decides the gate.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** What BC gives for one test. `message` is the whole message; `messageIncludes` a part of it. */
export interface BcResult {
  readonly status: "pass" | "fail" | "error";
  readonly message?: string;
  readonly messageIncludes?: string;
}

export interface Repro {
  /** The folder under `scripts/upstream-repros/`. */
  readonly id: string;
  readonly issue: string;
  /** Where BC's results were measured (a probe result, an issue comment). */
  readonly bcEvidence: string;
  /** What to re-run when it flips to BC (projects, roadmap items). */
  readonly rerun: readonly string[];
  /** `Codeunit<id>.<method>` -> BC's result. */
  readonly tests: Readonly<Record<string, BcResult>>;
}

export interface Manifest {
  readonly repros: readonly Repro[];
}

/** One test's row as `al-runner test --output-json` gives it. */
export interface Row {
  readonly name: string;
  readonly status: string;
  readonly message?: string;
  readonly notRun?: boolean;
}

/** A build's rows per repro, or why the repro did not run. */
export type BuildRows = ReadonlyMap<string, ReadonlyMap<string, Row> | { readonly error: string }>;

export type Change = "flipped" | "regressed" | "still-differs" | "still-matches" | "error";

export interface TestChange {
  readonly repro: string;
  readonly test: string;
  readonly change: Change;
  /** The candidate's row, for the report; `undefined` when it gave none. */
  readonly candidate?: Row;
  readonly rerun: readonly string[];
  readonly why?: string;
}

/** BC's result for a test against one row. A missing row, or a test al-runner did not run, never matches. */
export function matchesBc(bc: BcResult, row: Row | undefined): boolean {
  if (row === undefined || row.notRun === true || row.status !== bc.status) return false;
  const msg = (row.message ?? "").trim();
  if (bc.message !== undefined && msg !== bc.message.trim()) return false;
  if (bc.messageIncludes !== undefined && !msg.includes(bc.messageIncludes)) return false;
  return true;
}

/** Every manifest test, compared with BC on the candidate and on current. */
export function compare(
  manifest: Manifest,
  candidate: BuildRows,
  current: BuildRows,
): TestChange[] {
  const out: TestChange[] = [];
  for (const r of manifest.repros) {
    const cand = candidate.get(r.id);
    const cur = current.get(r.id);
    for (const [test, bc] of Object.entries(r.tests)) {
      const base = { repro: r.id, test, rerun: r.rerun };
      if (cand === undefined || "error" in cand) {
        out.push({
          ...base,
          change: "error",
          why: `candidate: ${cand === undefined ? "not run" : String(cand.error)}`,
        });
        continue;
      }
      const row = (cand as ReadonlyMap<string, Row>).get(test);
      const now = matchesBc(bc, row);
      // Current that did not run is not "differs": the change cannot be known, so it is an error too.
      if (cur === undefined || "error" in cur) {
        out.push({
          ...base,
          change: "error",
          ...(row !== undefined ? { candidate: row } : {}),
          why: `current: ${cur === undefined ? "not run" : String(cur.error)}`,
        });
        continue;
      }
      const before = matchesBc(bc, (cur as ReadonlyMap<string, Row>).get(test));
      const change: Change = now
        ? before
          ? "still-matches"
          : "flipped"
        : before
          ? "regressed"
          : "still-differs";
      out.push({ ...base, change, ...(row !== undefined ? { candidate: row } : {}) });
    }
  }
  return out;
}

/** The report's lines: one per flipped or regressed test, errors, then the counts. */
export function reportLines(changes: readonly TestChange[]): string[] {
  const n = (c: Change) => changes.filter((x) => x.change === c).length;
  const lines: string[] = [];
  for (const c of changes) {
    if (c.change === "flipped")
      lines.push(
        `FLIPPED to BC: ${c.repro} ${c.test}: re-run ${c.rerun.length > 0 ? c.rerun.join(", ") : "(nothing named)"}`,
      );
    else if (c.change === "regressed")
      lines.push(
        `REGRESSED (a finding): ${c.repro} ${c.test}: candidate ${c.candidate?.status ?? "no row"} ${c.candidate?.message ?? ""}`.trimEnd(),
      );
    else if (c.change === "error") lines.push(`ERROR: ${c.repro} ${c.test}: ${c.why ?? "?"}`);
  }
  lines.push(
    `upstream repros: ${changes.length} test(s): flipped ${n("flipped")}, regressed ${n("regressed")}, still differ ${n("still-differs")}, still match ${n("still-matches")}, error ${n("error")}`,
  );
  return lines;
}

export const REPRO_ROOT = join(import.meta.dir, "upstream-repros");

export function readManifest(root = REPRO_ROOT): Manifest {
  const m = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as Manifest;
  if (!Array.isArray(m.repros) || m.repros.length === 0)
    throw new Error("upstream-repros: the manifest lists no repro");
  for (const r of m.repros) {
    if (!existsSync(join(root, r.id, "app.json")))
      throw new Error(`upstream-repros: ${r.id} has no app.json`);
    if (Object.keys(r.tests).length === 0)
      throw new Error(`upstream-repros: ${r.id} names no test`);
  }
  return m;
}

/** Runs every repro on `bin`; a repro whose run gives no readable JSON is `{ error }`. */
export async function runAll(
  bin: string,
  manifest: Manifest,
  root = REPRO_ROOT,
): Promise<BuildRows> {
  const out = new Map<string, ReadonlyMap<string, Row> | { readonly error: string }>();
  for (const r of manifest.repros) {
    const p = Bun.spawn([bin, "test", "--bc-version", "28", "--output-json", r.id], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ALRUNNER_SEED: "1" },
    });
    const timer = setTimeout(() => p.kill(), 300_000);
    const [stdout, stderr] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    await p.exited;
    clearTimeout(timer);
    try {
      const j = JSON.parse(stdout) as { tests?: Row[] };
      if (!Array.isArray(j.tests)) throw new Error("no tests[]");
      out.set(r.id, new Map(j.tests.map((t) => [t.name, t])));
    } catch (err) {
      out.set(r.id, { error: `exit ${p.exitCode}: ${String(err)}; ${stderr.slice(-200).trim()}` });
    }
  }
  return out;
}

/** The whole check, for the daily update: run on both builds, compare, report. */
export async function checkBuild(
  candidate: string,
  current: string,
  root = REPRO_ROOT,
): Promise<{ lines: string[]; changes: TestChange[] }> {
  const manifest = readManifest(root);
  const changes = compare(
    manifest,
    await runAll(candidate, manifest, root),
    await runAll(current, manifest, root),
  );
  return { lines: reportLines(changes), changes };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const candidate = opt("--candidate");
  if (candidate === undefined)
    throw new Error(
      "usage: upstream-repros.ts --candidate <al-runner> [--current <al-runner>] [--out <report.json>]",
    );
  const current = opt("--current") ?? "/work/tools/al-runner-v3/current/al-runner";
  const { lines, changes } = await checkBuild(candidate, current);
  for (const l of lines) console.log(l);
  const outFile = opt("--out");
  if (outFile !== undefined) writeFileSync(outFile, `${JSON.stringify(changes, null, 2)}\n`);
}
