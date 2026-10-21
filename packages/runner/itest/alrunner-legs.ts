/**
 * R-587: the ONE list of `itest:alrunner`'s legs, and the pure rules that decide what a run of them
 * proves. Plan: docs/superpowers/plans/2026-10-21-r587-alrunner-leg-split.md (its r2 header wins).
 *
 * A leg is one LethAL session against al-runner. A GROUP is the legs of one fixture, run in one
 * process, in order. Every cross-leg check compares two legs of the same group, so `--legs` takes
 * group names only and no check can lose its partner.
 *
 * Pure: no IO and no process access, so `scripts/agentflow` can import the id list.
 */
import type { SessionReport } from "../src/report";

/** Registry order is the sequential run order. */
export const ALRUNNER_GROUPS = [
  {
    group: "sandbox",
    legs: ["sandbox-a", "sandbox-b", "sandbox-server", "sandbox-resource", "cli-default"],
  },
  { group: "layout", legs: ["layout-one-shot", "layout-server"] },
  {
    group: "multiobject",
    legs: ["multiobject-one-shot", "multiobject-server", "multiobject-resource"],
  },
  { group: "wrapped", legs: ["wrapped-one-shot", "wrapped-server", "wrapped-resource"] },
  { group: "names", legs: ["names-a1", "names-a2", "names-a3", "names-a4"] },
  {
    group: "symbols-lethala",
    legs: ["symbols-lethala-one-shot", "symbols-lethala-server", "symbols-lethala-resource"],
  },
  {
    group: "symbols-lethalb",
    legs: ["symbols-lethalb-one-shot", "symbols-lethalb-server", "symbols-lethalb-resource"],
  },
] as const;

export type GroupName = (typeof ALRUNNER_GROUPS)[number]["group"];
export type LegId = (typeof ALRUNNER_GROUPS)[number]["legs"][number];

export const GROUP_NAMES: readonly GroupName[] = ALRUNNER_GROUPS.map((g) => g.group);
/** All 23 legs. A full PASS, and its receipt, needs exactly these. */
export const ALRUNNER_LEG_IDS: readonly LegId[] = ALRUNNER_GROUPS.flatMap((g) => g.legs);

export function groupLegs(group: GroupName): readonly LegId[] {
  const g = ALRUNNER_GROUPS.find((x) => x.group === group);
  if (g === undefined) throw new Error(`R-587: no group "${group}"`);
  return g.legs;
}

/** Longest first (measure.md §5: wrapped 1175 s, names 957, sandbox 423, ...), so N = 3 reaches
 *  the wrapped group's critical path. */
const SCHEDULE: readonly GroupName[] = [
  "wrapped",
  "names",
  "sandbox",
  "symbols-lethala",
  "symbols-lethalb",
  "multiobject",
  "layout",
];

/** Throws for a selected group SCHEDULE does not name: never started would read PARTIAL, not failed. */
export function scheduleOrder(groups: readonly GroupName[]): GroupName[] {
  const unscheduled = groups.filter((g) => !SCHEDULE.includes(g));
  if (unscheduled.length > 0) {
    throw new Error(`R-587: group(s) ${unscheduled.join(", ")} missing from SCHEDULE`);
  }
  return SCHEDULE.filter((g) => groups.includes(g));
}

/** `--legs a,b`: group names only, deduplicated, in registry order. Throws on an unknown or empty list. */
export function resolveGroups(spec: string): GroupName[] {
  const asked = spec
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const list = GROUP_NAMES.join(", ");
  if (asked.length === 0) throw new Error(`--legs is empty; give one or more of: ${list}`);
  const unknown = asked.filter((s) => !(GROUP_NAMES as readonly string[]).includes(s));
  if (unknown.length > 0) {
    throw new Error(`--legs: unknown group(s) ${unknown.join(", ")}; the groups are: ${list}`);
  }
  return GROUP_NAMES.filter((g) => asked.includes(g));
}

/** True only for exactly the 23 ids, each once. */
export function isFullRun(ran: readonly string[]): boolean {
  return (
    ran.length === ALRUNNER_LEG_IDS.length &&
    new Set(ran).size === ran.length &&
    ALRUNNER_LEG_IDS.every((id) => ran.includes(id))
  );
}

/** The receipt's `sublegs`. Throws unless `ran` is the full run. */
export function fullRunSublegs(ran: readonly string[]): readonly LegId[] {
  if (!isFullRun(ran)) {
    throw new Error(
      `R-587: a receipt names all ${ALRUNNER_LEG_IDS.length} legs, and this run ran ${ran.length}: ${ran.join(", ")}`,
    );
  }
  return ALRUNNER_LEG_IDS;
}

/** The gate's last line. Only a full run says PASS; a partial run never contains "itest: PASS". */
export function finalLine(ran: readonly string[]): string {
  if (isFullRun(ran)) return "al-runner itest: PASS";
  const ids = ALRUNNER_LEG_IDS.filter((id) => ran.includes(id));
  return `al-runner itest: PARTIAL, ${ids.length} of ${ALRUNNER_LEG_IDS.length} legs ran green (${ids.join(", ")}); NOT a gate pass, run without --legs for submit and merge`;
}

/** 0 = full PASS only; 4 = partial with no failure. (1 failure, 2 refused, 3 record are set elsewhere.) */
export function exitCodeFor(ran: readonly string[]): 0 | 4 {
  return isFullRun(ran) ? 0 : 4;
}

/** The end of a group with collected checks: throws `<label>: N <what> check(s) failed` when any did. */
export function throwCollected(label: string, what: string, failures: readonly string[]): void {
  if (failures.length > 0) {
    throw new Error(
      `${label}: ${failures.length} ${what} check(s) failed:\n${failures.map((f) => `  - ${f}`).join("\n")}`,
    );
  }
}

/** What a group's run must have recorded: exactly its own legs. Empty means it did. */
export function groupRanFailures(group: GroupName, ran: readonly string[]): string[] {
  const want = groupLegs(group);
  const missing = want.filter((id) => !ran.includes(id));
  const extra = ran.filter((id) => !(want as readonly string[]).includes(id));
  const failures: string[] = [];
  if (missing.length > 0) failures.push(`group ${group}: legs not run: ${missing.join(", ")}`);
  if (extra.length > 0) failures.push(`group ${group}: legs of another group: ${extra.join(", ")}`);
  if (new Set(ran).size !== ran.length) failures.push(`group ${group}: a leg ran twice`);
  return failures;
}

/**
 * B1: the one place a leg is skipped or counted. `fn` is never called for an unselected id, and the
 * id is recorded only after `fn` resolves with a report holding at least one mutant. Each
 * cross-leg check lives inside its checker leg's `fn`.
 */
export class LegRunner {
  private readonly done: LegId[] = [];
  private stopReason: string | undefined;

  constructor(
    private readonly selected: ReadonlySet<LegId>,
    private readonly hooks: {
      /** Called after `fn` passed, before the id is recorded (writes `<id>.json`). */
      readonly onDone?: (id: LegId, report: SessionReport) => Promise<void> | void;
      readonly log?: (line: string) => void;
      readonly now?: () => number;
    } = {},
  ) {}

  get ran(): readonly LegId[] {
    return this.done;
  }

  /** I5: a signal arrived; every later leg throws instead of starting. */
  stop(reason: string): void {
    this.stopReason ??= reason;
  }

  /**
   * `failures` is the group's collected-check list, when it has one. A leg during which that list
   * grew is NOT recorded (no `<id>.json`, no `done` line), but its report is still returned so the
   * group's later legs and checks run as before; the group then throws (`throwCollected`).
   */
  async leg(
    id: LegId,
    fn: () => Promise<SessionReport>,
    failures?: readonly unknown[],
  ): Promise<SessionReport> {
    if (!this.selected.has(id)) {
      throw new Error(`R-587: leg ${id} is not selected; a group ran a leg it does not own`);
    }
    if (this.stopReason !== undefined) {
      throw new Error(`R-587: leg ${id} not started: ${this.stopReason}`);
    }
    const log = this.hooks.log ?? console.log;
    const now = this.hooks.now ?? Date.now;
    const t0 = now();
    log(`leg ${id}: start`);
    const mark = failures?.length ?? 0;
    const report = await fn();
    if (report.mutants.length === 0) {
      throw new Error(`R-587: leg ${id} returned a report with no mutant, so it measured nothing`);
    }
    const failed = (failures?.length ?? 0) - mark;
    if (failed > 0) {
      log(`leg ${id}: FAILED ${failed} check(s); not recorded`);
      return report;
    }
    await this.hooks.onDone?.(id, report);
    this.done.push(id);
    log(`leg ${id}: done in ${((now() - t0) / 1000).toFixed(1)}s`);
    return report;
  }
}

/** The four receipt-challenge variables (`gate-receipt.ts`). */
export const GATE_KEYS = [
  "LETHAL_GATE_NONCE",
  "LETHAL_GATE_SHA",
  "LETHAL_GATE_GENERATION",
  "LETHAL_GATE_RECEIPT",
] as const;

export const MAX_PARALLEL = 3;

export interface GateArgs {
  /** Absent means every group. */
  readonly groups?: readonly GroupName[];
  readonly parallel?: number;
  readonly reports?: string;
  readonly worker: boolean;
  readonly nonce?: string;
}

/** A refused start: exit 2. */
export class GateArgsRefusal extends Error {}

type Env = Readonly<Record<string, string | undefined>>;

const set = (env: Env, k: string) => env[k] !== undefined && env[k] !== "";

/** Parses the gate's own argv (after `--`) and refuses every combination the plan refuses. */
export function parseGateArgs(argv: readonly string[], env: Env): GateArgs {
  let legs: string | undefined;
  let parallel: string | undefined;
  let reports: string | undefined;
  let nonce: string | undefined;
  let worker = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    const eq = a.indexOf("=");
    const name = eq >= 0 ? a.slice(0, eq) : a;
    const inline = eq >= 0 ? a.slice(eq + 1) : undefined;
    const value = (): string => {
      if (inline !== undefined) return inline;
      const v = argv[++i];
      if (v === undefined) throw new GateArgsRefusal(`${name} needs a value`);
      return v;
    };
    if (name === "--legs") legs = value();
    else if (name === "--reports") reports = value();
    else if (name === "--nonce") nonce = value();
    else if (name === "--parallel") {
      if (inline === undefined && /^\d+$/.test(argv[i + 1] ?? "")) {
        throw new GateArgsRefusal(`--parallel ${argv[i + 1]}: write --parallel=${argv[i + 1]}`);
      }
      parallel = inline ?? String(MAX_PARALLEL);
    } else if (a === "--worker") worker = true;
    else throw new GateArgsRefusal(`unknown argument ${JSON.stringify(a)}`);
  }

  let groups: GroupName[] | undefined;
  if (legs !== undefined) {
    try {
      groups = resolveGroups(legs);
    } catch (e) {
      throw new GateArgsRefusal(e instanceof Error ? e.message : String(e));
    }
  }
  let n: number | undefined;
  if (parallel !== undefined) {
    n = Number(parallel);
    if (!Number.isInteger(n) || n < 1 || n > MAX_PARALLEL) {
      throw new GateArgsRefusal(
        `--parallel=${parallel}: N must be an integer from 1 to ${MAX_PARALLEL} (two heavy jobs per container)`,
      );
    }
  }
  const challenged = GATE_KEYS.filter((k) => set(env, k));
  const recording =
    set(env, "LETHAL_ITEST_RECORD_BASELINE") || env.LETHAL_ITEST_RECORD_SYMBOL_BASELINES === "1";

  if (worker) {
    if (groups?.length !== 1)
      throw new GateArgsRefusal("--worker needs --legs with exactly one group");
    if (reports === undefined || nonce === undefined) {
      throw new GateArgsRefusal("--worker needs --reports and --nonce");
    }
    if (n !== undefined) throw new GateArgsRefusal("--worker and --parallel together");
    if (challenged.length > 0) {
      throw new GateArgsRefusal(
        `--worker with ${challenged.join(", ")} set: only the supervisor writes the receipt`,
      );
    }
  } else if (nonce !== undefined) {
    throw new GateArgsRefusal("--nonce is the supervisor's, for --worker only");
  }
  if (!/^[0-9a-f]{32}$/.test(nonce ?? "0".repeat(32))) {
    throw new GateArgsRefusal("--nonce must be 32 lowercase hex");
  }
  if (groups !== undefined && challenged.length > 0 && !worker) {
    throw new GateArgsRefusal(
      "--legs while a gate receipt is demanded: a partial run can never answer a challenge",
    );
  }
  if (recording && (groups !== undefined || n !== undefined || worker)) {
    throw new GateArgsRefusal(
      "a baseline record run is full and sequential only (R332): drop --legs and --parallel",
    );
  }
  return {
    ...(groups !== undefined ? { groups } : {}),
    ...(n !== undefined ? { parallel: n } : {}),
    ...(reports !== undefined ? { reports } : {}),
    worker,
    ...(nonce !== undefined ? { nonce } : {}),
  };
}

/** A worker's environment: no receipt keys, and the al-runner path pinned to the supervisor's realpath (I2). */
export function workerEnv(env: Env, alRunnerRealpath: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && !(GATE_KEYS as readonly string[]).includes(k)) out[k] = v;
  }
  out.LETHAL_ALRUNNER_PATH = alRunnerRealpath;
  return out;
}

/**
 * M8: a RELEASE build at or below 2.12.0 carries R345 (concurrent sessions crash), so `--parallel`
 * is refused on it. `line` is `al-runner --version`'s output, e.g. `al-runner v2.12.0-main.f06ee78c`
 * (a source build, allowed) or `al-runner v2.12.0` (a release, refused).
 */
export function parallelVersionRefusal(line: string): string | undefined {
  const m = /v?(\d+)\.(\d+)\.(\d+)(?:\.\d+)?(\S*)/.exec(line);
  if (m === null) return `cannot read a version from ${JSON.stringify(line)}; --parallel refused`;
  const [, a = "0", b = "0", c = "0", suffix = ""] = m;
  if (suffix !== "") return undefined;
  const v = [Number(a), Number(b), Number(c)];
  const atOrBelow =
    v[0] !== 2 ? (v[0] ?? 0) < 2 : v[1] !== 12 ? (v[1] ?? 0) < 12 : (v[2] ?? 0) <= 0;
  return atOrBelow
    ? `al-runner ${m[0]} is a release at or below 2.12.0, which has R345 (concurrent sessions crash); --parallel refused`
    : undefined;
}

/** What a worker writes last, after every check of its group passed. */
export interface DoneFile {
  readonly runNonce: string;
  readonly group: string;
  readonly ran: readonly string[];
  readonly buildLine: string;
}

export interface WorkerResult {
  readonly group: GroupName;
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** The parsed `<group>.done.json`, or undefined when absent or unreadable. */
  readonly done?: unknown;
}

/**
 * B2/I2/I4: the supervisor's verdict on its workers. A worker counts only when it exited 4 on its
 * own, wrote a done-file carrying this run's nonce, its group, its group's exact legs, and the
 * supervisor's build line. Any other outcome is a failure naming the group.
 */
export function combineWorkers(
  results: readonly WorkerResult[],
  expect: { readonly nonce: string; readonly buildLine: string; readonly interrupted?: string },
): { ran: LegId[]; failures: string[] } {
  const failures: string[] = [];
  const ran = new Set<string>();
  if (expect.interrupted !== undefined) {
    failures.push(`interrupted by ${expect.interrupted}; signal forwarded to the workers`);
  }
  for (const r of results) {
    const g = r.group;
    const own: string[] = [];
    if (r.signal === "not-started") own.push(`worker ${g}: not started`);
    else if (r.signal !== null) own.push(`worker ${g}: killed by ${r.signal}`);
    else if (r.exitCode !== 4) {
      own.push(
        `worker ${g}: exited ${r.exitCode} (a worker exits 4 when its group is green; 0 is never a worker's pass)`,
      );
    }
    const d = r.done as Partial<DoneFile> | undefined;
    if (d === undefined || typeof d !== "object" || d === null) {
      own.push(`worker ${g}: wrote no ${g}.done.json`);
    } else {
      if (d.runNonce !== expect.nonce)
        own.push(`worker ${g}: done-file nonce ${d.runNonce} is not this run's`);
      if (d.group !== g) own.push(`worker ${g}: done-file names group ${d.group}`);
      if (d.buildLine !== expect.buildLine) {
        own.push(
          `worker ${g}: ran al-runner "${d.buildLine}", the supervisor "${expect.buildLine}" (I2)`,
        );
      }
      const legs = Array.isArray(d.ran) ? d.ran.map(String) : [];
      own.push(...groupRanFailures(g, legs).map((f) => `worker ${f}`));
      if (own.length === 0) for (const id of legs) ran.add(id);
    }
    failures.push(...own);
  }
  return { ran: ALRUNNER_LEG_IDS.filter((id) => ran.has(id)), failures };
}
