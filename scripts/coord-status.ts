/**
 * One-call view of the LethAL coord run.
 *
 *   bun scripts/coord-status.ts
 *
 * Prints: pause state, open question count, the stale list, the Doing list with each doing task's
 * latest run checkpoint (phase + first 200 chars of note, read from
 * `<root>/tasks/<id>/runs/<latest>/checkpoint.json`), and who holds the Cronus28 and Cronus284
 * leases. Everything except the checkpoints comes from the coord CLI via `scripts/coord.sh`.
 *
 * The root is `LETHAL_COORD_ROOT`; else `CG_COORD_ROOT` when `KRAKEN_PROJECT` is set (inside a
 * kraken container it is the project's own /coord); else `H:\lethal-coord`. On the host an
 * inherited `CG_COORD_ROOT` is ignored on purpose: the machine-wide one can point at CentralGauge's
 * root (see scripts/coord.sh). The leased containers are read from
 * `<root>/machine/allocation.json` inside kraken, and are Cronus28 and Cronus284 on the host.
 * A coord call that fails, or prints something that is not the expected shape, exits non-zero.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const COORD_SH = join(import.meta.dir, "coord.sh");
export const DEFAULT_ROOT = "H:\\lethal-coord";
export const LEASED_CONTAINERS = ["Cronus28", "Cronus284"] as const;
const NOTE_CHARS = 200;

type Env = Readonly<Record<string, string | undefined>>;

/** Which coord root to read: see the file header. */
export function resolveRoot(env: Env): string {
  if (env.LETHAL_COORD_ROOT) return env.LETHAL_COORD_ROOT;
  if (env.KRAKEN_PROJECT && env.CG_COORD_ROOT) return env.CG_COORD_ROOT;
  return DEFAULT_ROOT;
}

/**
 * The containers this project may lease. Inside kraken: this campaign's list in
 * `<root>/machine/allocation.json` (a missing or unreadable file is an error, not an empty
 * list: strict allocation means no file, no container). On the host: the fixed pair.
 */
export function leasedContainers(root: string, env: Env): readonly string[] {
  if (!env.KRAKEN_PROJECT) return LEASED_CONTAINERS;
  const file = join(root, "machine", "allocation.json");
  if (!existsSync(file)) throw new CoordStatusError(`${file} does not exist`);
  const alloc = readJsonFile(file) as Record<string, unknown>;
  const campaign = readCampaign(root) ?? env.KRAKEN_PROJECT;
  const mine = alloc[campaign];
  if (!Array.isArray(mine) || !mine.every((c) => typeof c === "string"))
    throw new CoordStatusError(`${file}: no string list for '${campaign}'`);
  return mine as string[];
}

/** JSON.parse that names the file on failure and never echoes its content. */
function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new CoordStatusError(`${file}: not valid JSON`);
  }
}

function readCampaign(root: string): string | null {
  const file = join(root, "coord.json");
  if (!existsSync(file)) return null;
  const meta = readJsonFile(file) as { campaign?: unknown };
  return typeof meta.campaign === "string" ? meta.campaign : null;
}

export class CoordStatusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoordStatusError";
  }
}

export interface Checkpoint {
  readonly runId: string;
  readonly phase: string;
  readonly note: string | null;
}

/** The latest run's checkpoint for a task, or null when that run has none yet. */
export function latestCheckpoint(root: string, taskId: string): Checkpoint | null {
  const runsDir = join(root, "tasks", taskId, "runs");
  if (!existsSync(runsDir)) throw new CoordStatusError(`${runsDir} does not exist`);
  const runs = readdirSync(runsDir)
    .filter((r) => /^\d+$/.test(r))
    .sort();
  const runId = runs.at(-1);
  if (runId === undefined) return null;
  const file = join(runsDir, runId, "checkpoint.json");
  if (!existsSync(file)) return null;
  const cp = JSON.parse(readFileSync(file, "utf8")) as { phase?: unknown; note?: unknown };
  if (typeof cp.phase !== "string") throw new CoordStatusError(`${file}: no string 'phase'`);
  return { runId, phase: cp.phase, note: typeof cp.note === "string" ? cp.note : null };
}

interface PauseState {
  readonly paused: boolean;
  readonly reason?: string;
  readonly doing: readonly { readonly id: string; readonly lane: string }[];
}

export interface CoordView {
  readonly pause: PauseState;
  readonly openQuestions: number;
  readonly stale: readonly string[];
  readonly checkpoints: ReadonlyMap<string, Checkpoint | null>;
  readonly holders: ReadonlyMap<string, string | null>;
}

/** Runs one coord command and returns its stdout. Injected so tests need no deno. */
export type CoordRunner = (args: readonly string[]) => Promise<string>;

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new CoordStatusError(`coord ${what} did not print JSON: ${text.slice(0, 200)}`);
  }
}

export async function gather(
  root: string,
  coord: CoordRunner,
  containers: readonly string[] = LEASED_CONTAINERS,
): Promise<CoordView> {
  const [pauseText, questionsText, staleText, ...holderTexts] = await Promise.all([
    coord(["pause-state"]),
    coord(["questions"]),
    coord(["stale"]),
    ...containers.map((c) => coord(["holder", c])),
  ]);
  const pause = parseJson(pauseText ?? "", "pause-state") as PauseState;
  if (typeof pause?.paused !== "boolean" || !Array.isArray(pause.doing)) {
    throw new CoordStatusError(`coord pause-state: unexpected shape: ${pauseText}`);
  }
  const questions = parseJson(questionsText ?? "", "questions");
  if (!Array.isArray(questions)) throw new CoordStatusError("coord questions: not an array");
  const stale = (staleText ?? "")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "" && l.trim() !== "(nothing stale)");
  const holders = new Map<string, string | null>();
  containers.forEach((c, i) => {
    const h = parseJson(holderTexts[i] ?? "", `holder ${c}`) as { lane?: unknown } | null;
    holders.set(c, h === null ? null : String(h.lane));
  });
  const checkpoints = new Map(pause.doing.map((t) => [t.id, latestCheckpoint(root, t.id)]));
  return { pause, openQuestions: questions.length, stale, checkpoints, holders };
}

export function formatView(v: CoordView): string {
  const out: string[] = [];
  out.push(
    `pause: ${v.pause.paused ? `PAUSED${v.pause.reason ? ` (${v.pause.reason})` : ""}` : "running"}`,
  );
  out.push(`open questions: ${v.openQuestions}`);
  out.push(`stale: ${v.stale.length === 0 ? "none" : v.stale.length}`);
  for (const s of v.stale) out.push(`  ${s}`);
  out.push(`doing: ${v.pause.doing.length === 0 ? "none" : v.pause.doing.length}`);
  for (const t of v.pause.doing) {
    const cp = v.checkpoints.get(t.id) ?? null;
    const detail =
      cp === null
        ? "no checkpoint"
        : `run ${cp.runId} ${cp.phase}${cp.note === null ? "" : `: ${cp.note.replace(/\s+/g, " ").slice(0, NOTE_CHARS)}`}`;
    out.push(`  ${t.id} (${t.lane}) ${detail}`);
  }
  for (const [c, lane] of v.holders) out.push(`lease ${c}: ${lane ?? "free"}`);
  return out.join("\n");
}

function spawnCoord(root: string): CoordRunner {
  return async (args) => {
    const p = Bun.spawn(["bash", COORD_SH, ...args], {
      env: { ...process.env, LETHAL_COORD_ROOT: root },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (code !== 0)
      throw new CoordStatusError(`coord ${args.join(" ")} exited ${code}: ${stderr.trim()}`);
    return stdout;
  };
}

if (import.meta.main) {
  const root = resolveRoot(process.env);
  try {
    const containers = leasedContainers(root, process.env);
    console.log(formatView(await gather(root, spawnCoord(root), containers)));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
