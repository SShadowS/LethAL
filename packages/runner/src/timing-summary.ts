/**
 * PR-100: where a run's time went, folded from its event stream. One fold serves `lethal run` (its
 * stderr at the session's end) and `lethal explain <report> --events <events.ndjson>`, on any backend.
 * Timing only: nothing here is read by a verdict.
 */
import type { RunEvent } from "./events";

const PHASE_ORDER = ["generate", "deploy", "baseline", "mutants", "teardown"] as const;
const KINDS = [
  ["warmup", "warm-up"],
  ["prefetch", "prefetch"],
  ["live", "live"],
] as const;
const INSIDE = [
  ["setupMs", "setup"],
  ["compileMs", "compile"],
  ["engineMs", "engine"],
  ["baselineMs", "baseline"],
  ["testsMs", "tests"],
  ["coverageMs", "coverage"],
  ["otherMs", "other"],
] as const;
const FAMILY_CUT = 40;

const secs = (ms: number): string =>
  `${(ms / 1000).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;

export type TimingFold = {
  add(event: RunEvent): void;
  /** The section, or `undefined` when the stream held nothing to show. */
  render(): string | undefined;
};

export function createTimingFold(): TimingFold {
  const phaseMs = new Map<string, number>();
  const kinds = new Map<string, { n: number; ms: number }>();
  const causes = new Map<string, { n: number; ms: number }>();
  const inside = new Map<string, number>();
  const restarts = new Map<string, number>();
  let selectedOnly = 0;
  let restartTotal = 0;
  let timeoutKilled = 0;
  let cuts = 0;
  let covered = 0;
  let finished = false;

  const bump = (m: Map<string, { n: number; ms: number }>, k: string, ms: number): void => {
    const cur = m.get(k) ?? { n: 0, ms: 0 };
    m.set(k, { n: cur.n + 1, ms: cur.ms + ms });
  };

  return {
    add(e) {
      switch (e.type) {
        case "phase-left":
          phaseMs.set(e.phase, (phaseMs.get(e.phase) ?? 0) + e.elapsedMs);
          break;
        case "session-finished":
          finished = true;
          break;
        case "mutant-scored":
          if (e.verdict !== "no-coverage") covered += 1;
          if (e.verdict === "timeout-killed") timeoutKilled += 1;
          break;
        case "serve-request-timed":
          bump(kinds, e.kind, e.wallMs);
          if (e.selectedOnly === true) selectedOnly += 1;
          if (e.cut === true) cuts += 1;
          if (e.kind === "warmup" && e.cause !== undefined) bump(causes, e.cause, e.wallMs);
          if (e.timings !== undefined) {
            for (const [k] of INSIDE) {
              const v = e.timings[k];
              if (v !== undefined) inside.set(k, (inside.get(k) ?? 0) + v);
            }
          }
          break;
        case "serve-daemon-closed": {
          const label =
            e.family !== undefined ? `${e.reason}/${e.family.slice(0, FAMILY_CUT)}` : e.reason;
          const key =
            e.phase !== undefined && e.phase !== "idle" ? `${label} in ${e.phase}` : label;
          restarts.set(key, (restarts.get(key) ?? 0) + 1);
          restartTotal += 1;
          break;
        }
        default:
          break;
      }
    },

    render() {
      const lines: string[] = [];
      const phases = PHASE_ORDER.filter((p) => phaseMs.has(p)).map(
        (p) => `${p} ${secs(phaseMs.get(p) ?? 0)}`,
      );
      if (phases.length > 0) lines.push(`  phases: ${phases.join(", ")}`);

      const served = KINDS.filter(([k]) => kinds.has(k)).map(([k, label]) => {
        const v = kinds.get(k);
        return `${label} ${v?.n ?? 0} (${secs(v?.ms ?? 0)})`;
      });
      if (served.length > 0) {
        lines.push(
          `  serve requests: ${served.join(", ")}${selectedOnly > 0 ? `; selected-only ${selectedOnly}` : ""}`,
        );
        if (causes.size > 0) {
          const ordered = [...causes.entries()].sort(([a], [b]) =>
            a === "first" ? -1 : b === "first" ? 1 : a < b ? -1 : a > b ? 1 : 0,
          );
          lines.push(
            `    warm-ups by cause: ${ordered.map(([c, v]) => `${c} ${v.n} (${secs(v.ms)})`).join(", ")}`,
          );
        }
        const parts = INSIDE.filter(([k]) => inside.has(k)).map(
          ([k, label]) => `${label} ${secs(inside.get(k) ?? 0)}`,
        );
        if (parts.length > 0) lines.push(`    al-runner inside them: ${parts.join(", ")}`);
      }

      if (restartTotal > 0) {
        const parts = [...restarts.entries()]
          .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, n]) => `${k} ${n}`);
        lines.push(`  daemon restarts: ${restartTotal} — ${parts.join(", ")}`);
      }

      if (timeoutKilled > 0 || cuts > 0)
        lines.push(
          `  timeouts: ${timeoutKilled} mutants timeout-killed, ${cuts} answers cut at a timeout row`,
        );

      const mutantsMs = phaseMs.get("mutants");
      if (mutantsMs !== undefined && covered > 0)
        lines.push(
          `  per covered mutant: ${(mutantsMs / 1000 / covered).toFixed(2)} s (${covered} scored with coverage over the mutants phase)`,
        );

      if (lines.length === 0) return undefined;
      const head = finished ? "TIMING (wall clock)" : "TIMING (partial: the run did not finish)";
      return [head, ...lines].join("\n");
    },
  };
}

/**
 * PR-100: the events of a `--progress-out` NDJSON file. The header line (`ndjsonHeader`) and lines
 * without a string `type` are skipped. A last line that does not parse is a killed run's cut write
 * and is skipped; any other unparsable line is a corrupt file and throws.
 */
export function parseEventsNdjson(text: string): RunEvent[] {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  const out: RunEvent[] = [];
  for (const [i, line] of lines.entries()) {
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      if (i === lines.length - 1) continue;
      throw new Error(`events file line ${i + 1} is not valid JSON.`);
    }
    if (typeof v !== "object" || v === null) continue;
    const r = v as Record<string, unknown>;
    if (r.ndjsonHeader === true || typeof r.type !== "string") continue;
    out.push(v as RunEvent);
  }
  return out;
}

/** PR-100: the TIMING section for a whole event list (any backend); `undefined` when nothing is in it. */
export function foldTiming(events: readonly RunEvent[]): string | undefined {
  const f = createTimingFold();
  for (const e of events) f.add(e);
  return f.render();
}
