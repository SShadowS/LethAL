/**
 * PR-100: where a run's time went, folded from its event stream. One fold serves `lethal run` (its
 * stderr at the session's end) and `lethal explain <report> --events <events.ndjson>`, on any backend.
 * Timing only: nothing here is read by a verdict.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { RunEvent } from "./events";

const PHASE_ORDER = ["generate", "deploy", "baseline", "mutants", "teardown"] as const;
const KINDS = [
  ["baseline", "baseline"],
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
  /** PR-113: al-runner's own timings, summed per request kind. */
  const inside = new Map<string, Map<string, number>>();
  /** PR-113: baseline one-shot calls, by reason. */
  const oneShots = new Map<string, { n: number; ms: number }>();
  const restarts = new Map<string, number>();
  let selectedOnly = 0;
  let restartTotal = 0;
  let cuts = 0;
  /** The LAST verdict per mutant (a `batch-invalidated` batch scores its mutants again). */
  const verdicts = new Map<string, string>();
  /** PR-108: the last verdict of each mutant whose walk the 3rd-hang cap ended. */
  const capped = new Map<string, string>();
  const lanes = new Set<number>();
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
          verdicts.set(`${e.batchIndex}/${e.mutant.mutantId}`, e.verdict);
          // PR-108: a walk the 3rd-hang cap ended carries this note (the same text the orchestrator writes).
          if (e.failureNote?.includes("(PR-108, R1057's cap)") === true)
            capped.set(`${e.batchIndex}/${e.mutant.mutantId}`, e.verdict);
          else capped.delete(`${e.batchIndex}/${e.mutant.mutantId}`);
          break;
        case "serve-request-timed":
          lanes.add(e.lane);
          bump(kinds, e.kind, e.wallMs);
          if (e.selectedOnly === true) selectedOnly += 1;
          if (e.cut === true) cuts += 1;
          if (e.kind === "warmup" && e.cause !== undefined) bump(causes, e.cause, e.wallMs);
          if (e.timings !== undefined) {
            const sums = inside.get(e.kind) ?? new Map<string, number>();
            inside.set(e.kind, sums);
            for (const [k] of INSIDE) {
              const v = e.timings[k];
              if (v !== undefined) sums.set(k, (sums.get(k) ?? 0) + v);
            }
          }
          break;
        case "baseline-one-shot-timed":
          bump(oneShots, e.reason, e.wallMs);
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
        // PR-113: one line per request kind that carried timings.
        for (const [kind, kindLabel] of KINDS) {
          const sums = inside.get(kind);
          if (sums === undefined) continue;
          const parts = INSIDE.filter(([k]) => sums.has(k)).map(
            ([k, label]) => `${label} ${secs(sums.get(k) ?? 0)}`,
          );
          if (parts.length > 0)
            lines.push(`    al-runner inside ${kindLabel}: ${parts.join(", ")}`);
        }
      }

      let oneShotN = 0;
      let oneShotMs = 0;
      for (const v of oneShots.values()) {
        oneShotN += v.n;
        oneShotMs += v.ms;
      }
      if (oneShotN > 0) {
        const by = (r: string): number => oneShots.get(r)?.n ?? 0;
        lines.push(
          `  baseline one-shots: ${oneShotN} (${secs(oneShotMs)}; cross-check ${by("cross-check")}, too-slow ${by("too-slow")}, other ${by("other")})`,
        );
      }

      if (restartTotal > 0) {
        const parts = [...restarts.entries()]
          .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, n]) => `${k} ${n}`);
        lines.push(`  daemon restarts: ${restartTotal} — ${parts.join(", ")}`);
      }

      let timeoutKilled = 0;
      let covered = 0;
      for (const v of verdicts.values()) {
        if (v === "timeout-killed") timeoutKilled += 1;
        if (v !== "no-coverage" && v !== "known-survivor") covered += 1;
      }
      const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;
      if (timeoutKilled > 0 || cuts > 0)
        lines.push(
          `  timeouts: ${plural(timeoutKilled, "mutant")} timeout-killed, ${plural(cuts, "answer")} cut at a timeout row`,
        );

      if (capped.size > 0) {
        const byVerdict = new Map<string, number>();
        for (const v of capped.values()) byVerdict.set(v, (byVerdict.get(v) ?? 0) + 1);
        const parts = [...byVerdict.entries()]
          .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
          .map(([v, n]) => `${v} ${n}`);
        lines.push(`  capped walks: ${capped.size} (${parts.join(", ")})`);
      }

      const mutantsMs = phaseMs.get("mutants");
      if (mutantsMs !== undefined && covered > 0)
        lines.push(
          `  per covered mutant: ${(mutantsMs / 1000 / covered).toFixed(2)} s (${covered} scored with coverage over the mutants phase)`,
        );

      if (lines.length === 0) return undefined;
      const head = !finished
        ? "TIMING (partial: the run did not finish)"
        : lanes.size > 1
          ? "TIMING (serve times are summed over lanes)"
          : "TIMING";
      return [head, ...lines].join("\n");
    },
  };
}

/**
 * PR-100: the events of a `--progress-out` NDJSON file. The header line (`ndjsonHeader`) and lines
 * without a string `type` are skipped. A last line that does not parse is a killed run's cut write
 * and is skipped; any other unparsable line is a corrupt file and throws.
 */
export async function foldTimingFile(path: string): Promise<string | undefined> {
  const fold = createTimingFold();
  const feed = (line: string, no: number, last: boolean): void => {
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      if (last) return;
      throw new Error(`events file line ${no} is not valid JSON.`);
    }
    if (typeof v !== "object" || v === null) return;
    const r = v as Record<string, unknown>;
    if (r.ndjsonHeader === true || typeof r.type !== "string") return;
    fold.add(v as RunEvent);
  };
  // One line of lookahead: the last non-blank line is the only one allowed to be a cut write.
  let pending: { readonly line: string; readonly no: number } | undefined;
  let no = 0;
  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of rl) {
    no += 1;
    if (line.trim() === "") continue;
    if (pending !== undefined) feed(pending.line, pending.no, false);
    pending = { line, no };
  }
  if (pending !== undefined) feed(pending.line, pending.no, true);
  return fold.render();
}

/** PR-100: the TIMING section for a whole event list (any backend); `undefined` when nothing is in it. */
export function foldTiming(events: readonly RunEvent[]): string | undefined {
  const f = createTimingFold();
  for (const e of events) f.add(e);
  return f.render();
}
