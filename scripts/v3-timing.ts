#!/usr/bin/env bun
/**
 * R774 (coord R-773): a repeatable al-runner-v3 timing run, the per-phase table the owner reads.
 *
 *   bun scripts/v3-timing.ts --out <dir> [--repeat N] [--subjects gc,d1] [--cdo <dir>]
 *                            [--gc-packages <dir>] [--cache-dir <dir>] [--no-lock]
 *
 * `--gc-packages` names a gift-card .alpackages to copy the Microsoft apps from (default
 * examples/gift-card/.alpackages, gitignored, so a fresh worktree passes another worktree's).
 *
 * Subjects:
 *   gc  `lethal run --backend al-runner-v3` on examples/gift-card (+ -tests), coverage on.
 *   d1  the v3 gate's leg D1 slice of the CDO checkout (default /work/lethal-wt/cdo-r396): the same
 *       --only and --tests-only, selector ids and BC build, coverage "none".
 * Every run goes through the CLI with the default transport (serve-entries where proven, R761).
 *
 * It is a heavy job: it re-runs itself under `flock` on the first free /coord/locks/heavy.N, and
 * waits while none is free, under 10 GB is available, or corpus-snapshot's heavy-job count
 * (`heavyVerdict`: held slots plus runner and corpus jobs that take none) is already at the cap.
 * `--no-lock` skips that (a one-off the orchestrator rules on).
 *
 * The cache dir defaults to the v3 gate's (`LETHAL_ALRUNNER_V3_CACHE`, else
 * /work/tools/al-runtime-rs/cache), so d1 matches leg D1 and shares its probe-cache entry.
 *
 * Per run it reads:
 *   - the report's `timings` and the events stream (phase walls, per-mutant durations);
 *   - the CLI's stderr: the contract-probe line (cache or fresh, R762) and the serve-entries
 *     counters line the backend prints on close (R635/R651);
 *   - the processes the run spawns, polled from /proc every 25 ms: the alc compiles and the probe's
 *     al-runner calls. A process shorter than one poll is missed, so those figures are a lower bound.
 *   - the load at start and end: MemAvailable, the load average, the other heavy jobs.
 * It writes <out>/runs/<subject>-<n>/ (report, events, stderr, procs), <out>/timing.json and
 * <out>/timing.md. Timing only: it reads no verdict and gates nothing.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { AL_RUNNER_V3_DEFAULT_PATH } from "../packages/runner/src/al-runner-v3-pin.ts";
import {
  HEAVY_GUARD_EXIT,
  SLOTS,
  heavyVerdict,
  parsePs,
  slotHeld,
  trySlots,
} from "./corpus-snapshot.ts";

export interface LoadSample {
  readonly availGb: number;
  readonly load1: number;
  readonly load5: number;
  /** Heavy jobs besides this run: slots held by others plus runner/corpus jobs in no slot. */
  readonly otherHeavy: number;
}

export interface ServeStats {
  readonly daemons: number;
  readonly warmups: number;
  readonly liveRequests: number;
  readonly coverageRequests: number;
  readonly echoRequests: number;
  readonly pairRequests: number;
  readonly entriesSent: number;
  readonly warmupMs: number;
  readonly prefetchMs: number;
  readonly liveMs: number;
  readonly windowMs: number;
  readonly coverageMs: number;
  readonly echoMs: number;
  readonly boundMs: number;
  readonly boundChecks: number;
}

export interface ProcSpan {
  readonly comm: string;
  readonly argv: string;
  /** ms since the run started, first and last seen. */
  readonly first: number;
  readonly last: number;
}

export interface RunTiming {
  readonly subject: string;
  readonly rep: number;
  readonly exit: number;
  readonly wallMs: number;
  /** `cache`, `fresh` or `unknown`, and the CLI's own words. */
  readonly probe: { readonly kind: "cache" | "fresh" | "unknown"; readonly note: string };
  readonly probeProcMs?: number;
  readonly transport: string;
  readonly phases: Readonly<Record<string, number>>;
  /** alc wall ms by what it compiled: the session's batch and test app, the probe's apps, other. */
  readonly alc: {
    readonly n: number;
    readonly batchMs: number;
    readonly testAppMs: number;
    readonly probeMs: number;
    readonly otherMs: number;
  };
  readonly perMutant: { readonly n: number; readonly medianMs: number; readonly p90Ms: number };
  readonly counts?: Readonly<Record<string, number>>;
  readonly serve?: ServeStats;
  readonly loadStart: LoadSample;
  readonly loadEnd: LoadSample;
}

export interface TimingMeta {
  readonly gitSha: string;
  readonly date: string;
  readonly build: string;
  readonly notes: readonly string[];
}

const SERVE_LINE =
  /serve-entries \(R635\): daemons (\d+), cached:false \d+, requests warm-up (\d+) \/ prefetch \d+ \/ live (\d+) \/ coverage (\d+) \/ echo (\d+), entries sent (\d+), echo mismatches \d+, kill pairs (\d+) .*?; wall ms warm-up (\d+) \/ prefetch (\d+) \/ live (\d+) \/ windows (\d+) \(coverage (\d+), echo (\d+)\) \/ bound (\d+) over (\d+) checks/;

/** The serve-entries counters line the backend prints on close, or `undefined` (one-shot). */
export function parseServeStats(stderr: string): ServeStats | undefined {
  const m = SERVE_LINE.exec(stderr);
  if (m === null) return undefined;
  const n = (i: number) => Number(m[i]);
  return {
    daemons: n(1),
    warmups: n(2),
    liveRequests: n(3),
    coverageRequests: n(4),
    echoRequests: n(5),
    entriesSent: n(6),
    pairRequests: n(7),
    warmupMs: n(8),
    prefetchMs: n(9),
    liveMs: n(10),
    windowMs: n(11),
    coverageMs: n(12),
    echoMs: n(13),
    boundMs: n(14),
    boundChecks: n(15),
  };
}

/** The contract-probe line (R762): from cache or ran fresh. */
export function parseProbe(stderr: string): RunTiming["probe"] {
  const m = /al-runner-v3 contract (probe [^\n]*?) \(R762\)/.exec(stderr);
  if (m === null) return { kind: "unknown", note: "no probe line" };
  const note = m[1] ?? "";
  return { kind: note.startsWith("probe from cache") ? "cache" : "fresh", note };
}

/** Nearest-rank percentile of `xs` (sorted copy); 0 for an empty list. */
export function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] ?? 0;
}

/** Verdicts that ran tests against the mutant: their durations are the per-mutant figures. */
const RAN = new Set(["killed", "survived", "timeout-killed"]);

/** Phase walls (summed per phase), per-mutant durations of mutants that ran (`RAN`), and the fallback warning. */
export function summarizeEvents(ndjson: string): {
  phases: Record<string, number>;
  durations: number[];
  fallback?: string;
} {
  const phases: Record<string, number> = {};
  const durations: number[] = [];
  let fallback: string | undefined;
  for (const line of ndjson.split("\n")) {
    if (line.trim() === "") continue;
    const e = JSON.parse(line) as {
      type?: string;
      phase?: string;
      elapsedMs?: number;
      verdict?: unknown;
      durationMs?: number;
      code?: string;
      message?: string;
    };
    if (e.type === "phase-left" && e.phase !== undefined && e.elapsedMs !== undefined)
      phases[e.phase] = (phases[e.phase] ?? 0) + e.elapsedMs;
    else if (e.type === "session-finished" && e.elapsedMs !== undefined)
      phases.session = e.elapsedMs;
    else if (
      e.type === "mutant-scored" &&
      typeof e.verdict === "string" &&
      RAN.has(e.verdict) &&
      e.durationMs !== undefined
    )
      durations.push(e.durationMs);
    else if (e.type === "warning" && e.code === "al-runner-v3-serve-default-fallback")
      fallback = e.message ?? "";
  }
  return { phases, durations, ...(fallback !== undefined ? { fallback } : {}) };
}

/** The alc compiles, the contract probe's span and the serve daemons among the polled processes. */
export function summarizeProcs(procs: readonly ProcSpan[]): {
  alc: RunTiming["alc"];
  probeProcMs?: number;
  serveDaemons: number;
} {
  const ms = (p: ProcSpan) => p.last - p.first;
  const sum = (ps: readonly ProcSpan[]) => ps.reduce((a, p) => a + ms(p), 0);
  // On Linux alc runs as `dotnet .../alc.dll`; a native alc shows as `alc`.
  const alc = procs.filter((p) => p.comm === "alc" || p.argv.includes("alc.dll"));
  const isProbe = (p: ProcSpan) => p.argv.includes("lethal-r586-contract");
  const probe = procs.filter(isProbe);
  const batch = alc.filter((p) => !isProbe(p) && p.argv.includes("v3-batch."));
  const testApp = alc.filter((p) => !isProbe(p) && p.argv.includes("v3-testapp."));
  const first = Math.min(...probe.map((p) => p.first));
  const last = Math.max(...probe.map((p) => p.last));
  return {
    alc: {
      n: alc.length,
      batchMs: sum(batch),
      testAppMs: sum(testApp),
      probeMs: sum(alc.filter(isProbe)),
      otherMs: sum(alc) - sum(batch) - sum(testApp) - sum(alc.filter(isProbe)),
    },
    ...(probe.length > 0 ? { probeProcMs: last - first } : {}),
    serveDaemons: procs.filter((p) => p.comm === "al-runner" && / serve /.test(` ${p.argv} `))
      .length,
  };
}

const s1 = (ms: number | undefined) => (ms === undefined ? "-" : (ms / 1000).toFixed(1));
const loadCell = (l: LoadSample) =>
  `load ${l.load1.toFixed(1)}/${l.load5.toFixed(1)}, ${l.availGb.toFixed(0)} GB free, ${l.otherHeavy} other heavy`;

/** The markdown the owner reads: one row per run, seconds unless marked, the load beside it. */
export function buildTimingMarkdown(meta: TimingMeta, runs: readonly RunTiming[]): string {
  const head = [
    "run",
    "exit",
    "wall s",
    "probe",
    "generate s",
    "deploy s",
    "alc s: batch / test app / probe (n)",
    "baseline s",
    "mutant loop s",
    "warm-up s",
    "live s (n)",
    "windows s (coverage / echo)",
    "bound s (n)",
    "kill pairs",
    "loop other s",
    "per mutant median / p90 ms (n)",
    "transport",
    "load at start",
    "load at end",
  ];
  const rows = runs.map((r) => {
    const s = r.serve;
    const loop = r.phases.mutants;
    const named =
      s === undefined ? undefined : s.warmupMs + s.prefetchMs + s.liveMs + s.windowMs + s.boundMs;
    return [
      `${r.subject} #${r.rep}`,
      String(r.exit),
      s1(r.wallMs),
      r.probe.kind === "fresh" && r.probeProcMs !== undefined
        ? `fresh ${s1(r.probeProcMs)} s`
        : r.probe.kind,
      s1(r.phases.generate),
      s1(r.phases.deploy),
      `${s1(r.alc.batchMs)} / ${s1(r.alc.testAppMs)} / ${s1(r.alc.probeMs)} (${r.alc.n})${r.alc.otherMs > 0 ? ` + other ${s1(r.alc.otherMs)}` : ""}`,
      s1(r.phases.baseline),
      s1(loop),
      s === undefined ? "-" : s1(s.warmupMs),
      s === undefined ? "-" : `${s1(s.liveMs)} (${s.liveRequests})`,
      s === undefined ? "-" : `${s1(s.windowMs)} (${s1(s.coverageMs)} / ${s1(s.echoMs)})`,
      s === undefined ? "-" : `${s1(s.boundMs)} (${s.boundChecks})`,
      s === undefined ? "-" : String(s.pairRequests),
      loop === undefined || named === undefined ? "-" : s1(loop - named),
      `${r.perMutant.medianMs} / ${r.perMutant.p90Ms} (${r.perMutant.n})`,
      r.transport,
      loadCell(r.loadStart),
      loadCell(r.loadEnd),
    ];
  });
  const line = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
  return [
    `# al-runner-v3 timing at ${meta.gitSha} (${meta.date})`,
    "",
    `Build: ${meta.build}`,
    ...meta.notes.map((n) => `- ${n}`),
    "",
    line(head),
    line(head.map(() => "---")),
    ...rows.map(line),
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// The run itself (not unit-tested: it spawns al-runner, alc and flock).

const REPO = resolve(dirname(import.meta.path), "..");
const LOCKS = "/coord/locks";
const MY_SLOT = Number(process.env.V3_TIMING_SLOT ?? 0);

function availGb(): number {
  const m = /MemAvailable:\s+(\d+) kB/.exec(readFileSync("/proc/meminfo", "utf8"));
  return m === null ? 0 : Number(m[1]) / 1024 / 1024;
}

/** corpus-snapshot's count: other held slots plus runner/corpus jobs in no slot (ours excluded). */
function otherHeavy(): { n: number; refuse: boolean } {
  const held = SLOTS.filter((s) => s !== MY_SLOT && slotHeld(LOCKS, s));
  const pids = held
    .map((s) => Number(readFileSync(join(LOCKS, `heavy.${s}`), "utf8").trim()))
    .filter((p) => !Number.isNaN(p));
  const ps = spawnSync("ps", ["-eo", "pid,ppid,pgid,args"], { encoding: "utf8" }).stdout;
  const v = heavyVerdict(parsePs(ps), process.pid, pids, held.length);
  return { n: held.length + v.foreign.length, refuse: v.refuse };
}

function sampleLoad(): LoadSample {
  const [l1, l5] = readFileSync("/proc/loadavg", "utf8").split(" ").map(Number);
  return { availGb: availGb(), load1: l1 ?? 0, load5: l5 ?? 0, otherHeavy: otherHeavy().n };
}

function procStat(pid: number): { ppid: number; comm: string } | undefined {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, "utf8");
    const r = s.lastIndexOf(")");
    return { comm: s.slice(s.indexOf("(") + 1, r), ppid: Number(s.slice(r + 2).split(" ")[1]) };
  } catch {
    return undefined; // exited between listing and reading
  }
}

/** Polls /proc every 25 ms for descendants of `root` until `done()`; spans in ms since `t0`. */
async function pollProcs(root: number, t0: number, done: () => boolean): Promise<ProcSpan[]> {
  const seen = new Map<number, { comm: string; argv: string; first: number; last: number }>();
  while (!done()) {
    const now = Date.now() - t0;
    const info = new Map<number, { ppid: number; comm: string }>();
    for (const d of readdirSync("/proc")) {
      const pid = Number(d);
      if (!Number.isInteger(pid)) continue;
      const st = procStat(pid);
      if (st !== undefined) info.set(pid, st);
    }
    for (const [pid, st] of info) {
      let p: number | undefined = st.ppid;
      for (let depth = 0; p !== undefined && p !== root && p > 1 && depth < 50; depth++)
        p = info.get(p)?.ppid;
      if (p !== root) continue;
      const prev = seen.get(pid);
      if (prev !== undefined) {
        prev.last = now;
        continue;
      }
      let argv = "";
      try {
        argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").slice(0, 400);
      } catch {}
      seen.set(pid, { comm: st.comm, argv, first: now, last: now });
    }
    await Bun.sleep(25);
  }
  return [...seen.values()];
}

interface Subject {
  readonly name: string;
  readonly args: readonly string[];
  readonly config: unknown;
}

function subjects(o: {
  which: readonly string[];
  cdo: string;
  gcPackages: string;
  cacheDir: string | undefined;
}): Subject[] {
  const v3 = (packagesDir: string, bcVersion: string, coverage: "al-runner" | "none") => ({
    path: AL_RUNNER_V3_DEFAULT_PATH,
    packagesDir,
    bcVersion,
    coverage,
    ...(o.cacheDir !== undefined ? { cacheDir: o.cacheDir } : {}),
  });
  const all: Subject[] = [
    {
      name: "gc",
      args: ["--project", "examples/gift-card", "--tests", "examples/gift-card-tests"],
      config: {
        alRunnerV3: v3(o.gcPackages, "28.0.46665.47126", "al-runner"),
        selectorIds: { selectorId: 90199, controlId: 90198, tableId: 90197 },
      },
    },
    {
      // Leg D1 (al-runner-v3.itest.ts `legD`): the same slice, ids, BC build and coverage.
      name: "d1",
      args: [
        "--project",
        join(o.cdo, "Cloud"),
        "--tests",
        join(o.cdo, "Test"),
        "--only",
        ".dependencies/CDO/Codeunit/CDORecipientMgt.Codeunit.al",
        "--tests-only",
        "Src/Recipients/CDORecipientMgtTests.Codeunit.al",
      ],
      config: {
        alRunnerV3: v3(join(o.cdo, "Test", ".alpackages"), "28.4.53241.53758", "none"),
        selectorIds: { selectorId: 6175460, controlId: 6175459, tableId: 6175458 },
      },
    },
  ];
  return all.filter((s) => o.which.includes(s.name));
}

async function runOne(s: Subject, rep: number, out: string, scratch: string): Promise<RunTiming> {
  const dir = join(out, "runs", `${s.name}-${rep}`);
  mkdirSync(dir, { recursive: true });
  const cfg = join(scratch, `${s.name}-${rep}.config.json`);
  writeFileSync(cfg, JSON.stringify(s.config, null, 2));
  const report = join(dir, "report.json");
  const events = join(dir, "events.ndjson");
  const loadStart = sampleLoad();
  const t0 = Date.now();
  const child = spawn(
    process.execPath,
    [
      "packages/runner/src/cli.ts",
      "run",
      ...s.args,
      "--backend",
      "al-runner-v3",
      "--config",
      cfg,
      "--db",
      join(scratch, `${s.name}-${rep}.sqlite`),
      "--out",
      report,
      "--progress-out",
      events,
    ],
    { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (b: Buffer) => {
    stdout += b.toString();
  });
  child.stderr.on("data", (b: Buffer) => {
    stderr += b.toString();
  });
  let exit: number | undefined;
  const ended = new Promise<number>((res) => child.on("close", (c) => res(c ?? 1)));
  ended.then((c) => {
    exit = c;
  });
  const procs = await pollProcs(child.pid ?? -1, t0, () => exit !== undefined);
  const code = await ended;
  const wallMs = Date.now() - t0;
  const loadEnd = sampleLoad();
  writeFileSync(join(dir, "stdout.txt"), stdout);
  writeFileSync(join(dir, "stderr.txt"), stderr);
  writeFileSync(join(dir, "procs.json"), `${JSON.stringify(procs, null, 1)}\n`);
  const ev = existsSync(events) ? summarizeEvents(readFileSync(events, "utf8")) : undefined;
  const counts = existsSync(report)
    ? (JSON.parse(readFileSync(report, "utf8")) as { counts?: Record<string, number> }).counts
    : undefined;
  const serve = parseServeStats(stderr);
  const p = summarizeProcs(procs);
  const durations = ev?.durations ?? [];
  return {
    subject: s.name,
    rep,
    exit: code,
    wallMs,
    probe: parseProbe(stderr),
    ...(p.probeProcMs !== undefined ? { probeProcMs: p.probeProcMs } : {}),
    transport:
      serve !== undefined
        ? "serve-entries"
        : p.serveDaemons > 0
          ? "serve-entries (no counters line: a build before R775, or close() failed)"
          : `one-shot${ev?.fallback !== undefined ? ` (fallback: ${ev.fallback.slice(0, 120)})` : ""}`,
    phases: ev?.phases ?? {},
    alc: p.alc,
    perMutant: {
      n: durations.length,
      medianMs: percentile(durations, 50),
      p90Ms: percentile(durations, 90),
    },
    ...(counts !== undefined ? { counts } : {}),
    ...(serve !== undefined ? { serve } : {}),
    loadStart,
    loadEnd,
  };
}

/**
 * Runs this script again under `flock` on the first free heavy slot (corpus-snapshot's `trySlots`).
 * Waits while none is free, under 10 GB is available, or the in-slot guard exits HEAVY_GUARD_EXIT.
 */
async function underHeavySlot(argv: readonly string[]): Promise<never> {
  for (;;) {
    if (availGb() >= 10) {
      const r = trySlots(
        LOCKS,
        (slot) => ["env", `V3_TIMING_SLOT=${slot}`, process.execPath, import.meta.path, ...argv],
        true,
      );
      if (r !== null && r.code !== HEAVY_GUARD_EXIT) process.exit(r.code);
    }
    console.error(
      "v3-timing: no free heavy slot, under 10 GB available, or the heavy-job cap reached; waiting 30 s",
    );
    await Bun.sleep(30_000);
  }
}

async function main(argv: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      out: { type: "string" },
      repeat: { type: "string", default: "1" },
      subjects: { type: "string", default: "gc,d1" },
      cdo: { type: "string", default: "/work/lethal-wt/cdo-r396" },
      "gc-packages": { type: "string" },
      "cache-dir": {
        type: "string",
        default: process.env.LETHAL_ALRUNNER_V3_CACHE ?? "/work/tools/al-runtime-rs/cache",
      },
      "no-lock": { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.out === undefined) throw new Error("v3-timing: --out <dir> is required");
  const repeat = Number(values.repeat);
  if (!Number.isInteger(repeat) || repeat < 1)
    throw new Error(`v3-timing: bad --repeat ${values.repeat}`);
  const which = values.subjects.split(",");
  for (const w of which)
    if (w !== "gc" && w !== "d1") throw new Error(`v3-timing: unknown subject "${w}" (gc, d1)`);
  if (!values["no-lock"]) {
    if (process.env.V3_TIMING_SLOT === undefined) await underHeavySlot(argv);
    // In the slot: an inherited V3_TIMING_SLOT names a slot we do not hold, so refuse it.
    if (!SLOTS.some((s) => s === MY_SLOT) || !slotHeld(LOCKS, MY_SLOT))
      throw new Error(`v3-timing: V3_TIMING_SLOT=${process.env.V3_TIMING_SLOT} is not a held slot`);
    const g = otherHeavy();
    if (g.refuse) {
      console.error(`v3-timing: ${g.n} other heavy job(s), at the cap; giving the slot back`);
      process.exit(HEAVY_GUARD_EXIT);
    }
  }

  const out = resolve(values.out);
  mkdirSync(out, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), "v3-timing-"));
  // The gift card's packages: the Microsoft apps only, as v3 reads them (examples' .alpackages is gitignored).
  let gcPackages: string | undefined;
  if (which.includes("gc")) {
    const src = values["gc-packages"] ?? join(REPO, "examples", "gift-card", ".alpackages");
    if (!existsSync(src))
      throw new Error(
        `v3-timing: ${src} is missing (gitignored): pass --gc-packages <a gift-card .alpackages>`,
      );
    // Copied with the source mtimes: the probe-cache key hashes each app's name, size and mtime,
    // not the folder's path (packagesFingerprint, R776), so this per-run copy still hits.
    gcPackages = join(scratch, "gc-packages");
    mkdirSync(gcPackages);
    for (const f of readdirSync(src).filter((n) => n.startsWith("Microsoft_"))) {
      copyFileSync(join(src, f), join(gcPackages, f));
      const st = statSync(join(src, f));
      utimesSync(join(gcPackages, f), st.atime, st.mtime);
    }
  }
  const notes: string[] = [];
  if (which.includes("d1")) {
    const git = (...a: string[]) =>
      spawnSync("git", ["-C", values.cdo, ...a], { encoding: "utf8" }).stdout.trim();
    const dirty = git("status", "--porcelain")
      .split("\n")
      .filter((l) => l !== "").length;
    notes.push(
      `d1: CDO ${values.cdo} at ${git("rev-parse", "--short", "HEAD")}, ${dirty} uncommitted path(s)`,
    );
  }
  notes.push(
    `heavy slot ${values["no-lock"] ? "none (--no-lock)" : MY_SLOT}; cache dir ${values["cache-dir"]}`,
  );
  notes.push("alc and probe process times are polled every 25 ms: a lower bound");
  notes.push(
    "per-mutant ms are the report's durations; under serve-entries they overlap (they sum past the loop wall), so read the mutant-loop wall for cost",
  );
  const meta: TimingMeta = {
    gitSha: spawnSync("git", ["-C", REPO, "rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
    }).stdout.trim(),
    date: new Date().toISOString(),
    build: spawnSync(AL_RUNNER_V3_DEFAULT_PATH, ["--version"], { encoding: "utf8" }).stdout.trim(),
    notes,
  };
  const runs: RunTiming[] = [];
  const subs = subjects({
    which,
    cdo: values.cdo,
    gcPackages: gcPackages ?? "",
    cacheDir: values["cache-dir"],
  });
  for (let rep = 1; rep <= repeat; rep++) {
    for (const s of subs) {
      console.error(`v3-timing: ${s.name} #${rep} ...`);
      const r = await runOne(s, rep, out, scratch);
      console.error(`v3-timing: ${s.name} #${rep} exit ${r.exit}, wall ${s1(r.wallMs)} s`);
      runs.push(r);
    }
  }
  writeFileSync(join(out, "timing.json"), `${JSON.stringify({ meta, runs }, null, 2)}\n`);
  const md = buildTimingMarkdown(meta, runs);
  writeFileSync(join(out, "timing.md"), md);
  console.log(md);
  if (runs.some((r) => r.exit !== 0)) process.exit(1);
}

if (import.meta.main) await main(process.argv.slice(2));
