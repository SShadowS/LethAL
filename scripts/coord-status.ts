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
 * The root is `CG_COORD_ROOT` (the variable coord itself reads), default `H:\lethal-coord`.
 * A coord call that fails, or prints something that is not the expected shape, exits non-zero.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const COORD_SH = join(import.meta.dir, "coord.sh");
export const DEFAULT_ROOT = "H:\\lethal-coord";
export const LEASED_CONTAINERS = ["Cronus28", "Cronus284"] as const;
const NOTE_CHARS = 200;

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

export async function gather(root: string, coord: CoordRunner): Promise<CoordView> {
  const [pauseText, questionsText, staleText, ...holderTexts] = await Promise.all([
    coord(["pause-state"]),
    coord(["questions"]),
    coord(["stale"]),
    ...LEASED_CONTAINERS.map((c) => coord(["holder", c])),
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
  LEASED_CONTAINERS.forEach((c, i) => {
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
      env: { ...process.env, CG_COORD_ROOT: root },
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
  const root = process.env.CG_COORD_ROOT ?? DEFAULT_ROOT;
  try {
    console.log(formatView(await gather(root, spawnCoord(root))));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
