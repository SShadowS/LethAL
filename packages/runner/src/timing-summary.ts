/**
 * PR-100: where a run's time went, folded from its event stream. One fold serves `lethal run` (its
 * stderr at the session's end) and `lethal explain <report> --events <events.ndjson>`, on any backend.
 * Timing only: nothing here is read by a verdict.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { SUSPEND_SECONDS } from "./clock";
import type { RunEvent } from "./events";

/** PR-303: the `reach-prune` warning text; the TIMING fold reads both counts back with `REACH_PRUNE_COUNTS`. */
export const reachPruneMessage = (batch: number, entries: number, survived: number): string =>
  `[lethal] reach pruning (PR-303), batch ${batch}: ${entries} mutant entries left out, ${survived} mutant(s) recorded pruned-survived without running`;
const REACH_PRUNE_COUNTS = /: (\d+) mutant entries left out, (\d+) mutant\(s\) recorded/;

const PHASE_ORDER = ["generate", "deploy", "baseline", "mutants", "teardown", "recheck"] as const;
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

/** R1119 (PR-150): a gap between one lane's requests longer than this counts as waiting at a window boundary. */
const LANE_GAP_MS = 5000;

/**
 * `now`: the in-process clock (ms) for events that carry no `atMs` (`lethal run`'s own fold; the
 * `--progress-out` file stamps `atMs`, PR-121a). Without either, the lane line says it has no times.
 */
export function createTimingFold(opts: { readonly now?: () => number } = {}): TimingFold {
  const phaseMs = new Map<string, number>();
  let recheckDetail: string | undefined;
  // R1119: the mutants phase's edges and each lane's requests in it, for the lane line.
  type Req = { start: number; end: number };
  let mutantsFrom: number | undefined;
  let mutantsTo: number | undefined;
  /** Phase seen (entered / left), whether or not a time came with it. */
  let inMutants = false;
  let mutantsSeen = false;
  let phaseReqs = new Map<number, Req[]>();
  const mutantPhases: { from: number; to: number; reqs: Map<number, Req[]> }[] = [];
  let untimed = false;
  let memoryHolds = 0;
  /** PR-252: `run-suspended` warnings and their total seconds. */
  let suspends = 0;
  let suspendedS = 0;
  let idleCloses = 0;
  /** PR-303: `reach-prune` warnings: entries left out, and mutants recorded pruned-survived, summed over batches. */
  let prunedEntries = 0;
  let prunedSurvived = 0;
  let prunedSeen = false;
  const prunedKeys = new Set<string>();
  const timeOf = (e: RunEvent): number | undefined => e.atMs ?? opts.now?.();
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
        case "phase-entered":
          if (e.phase === "mutants") {
            inMutants = true;
            mutantsSeen = true;
            mutantsFrom = timeOf(e);
            if (mutantsFrom === undefined) untimed = true;
          }
          break;
        case "phase-left":
          phaseMs.set(e.phase, (phaseMs.get(e.phase) ?? 0) + e.elapsedMs);
          // PR-370: the recheck phase's nested split, printed under the phases line.
          if (e.phase === "recheck" && e.detail !== undefined) recheckDetail = e.detail;
          if (e.phase === "mutants" && inMutants) {
            inMutants = false;
            mutantsTo = timeOf(e);
            // R1119: one mutants phase per batch; each is its own interval
            if (mutantsFrom !== undefined && mutantsTo !== undefined)
              mutantPhases.push({ from: mutantsFrom, to: mutantsTo, reqs: phaseReqs });
            else untimed = true;
            phaseReqs = new Map();
          }
          break;
        case "warning":
          if (e.code === "al-runner-v3-lane-memory-hold") memoryHolds += 1;
          if (e.code === "reach-prune") {
            const c = REACH_PRUNE_COUNTS.exec(e.message);
            prunedSeen = true;
            prunedEntries += Number(c?.[1] ?? 0);
            prunedSurvived += Number(c?.[2] ?? 0);
          }
          if (e.code === "run-suspended") {
            suspends += 1;
            suspendedS += Number(SUSPEND_SECONDS.exec(e.message)?.[1] ?? 0);
          }
          break;
        case "session-finished":
          finished = true;
          break;
        case "mutant-scored":
          verdicts.set(`${e.batchIndex}/${e.mutant.mutantId}`, e.verdict);
          // PR-303: a pruned survivor ran nothing, so it is not a covered mutant of the per-mutant figure.
          if (e.failureNote?.startsWith("pruned:") === true)
            prunedKeys.add(`${e.batchIndex}/${e.mutant.mutantId}`);
          // PR-108: a walk the 3rd-hang cap ended carries this note (the same text the orchestrator writes).
          if (e.failureNote?.includes("(PR-108, R1057's cap)") === true)
            capped.set(`${e.batchIndex}/${e.mutant.mutantId}`, e.verdict);
          else capped.delete(`${e.batchIndex}/${e.mutant.mutantId}`);
          break;
        case "serve-request-timed":
          lanes.add(e.lane);
          // R1119: a request of the mutants phase, on its lane's timeline (baseline requests are not lane work)
          if (e.kind !== "baseline" && inMutants) {
            const end = timeOf(e);
            if (end === undefined) untimed = true;
            else {
              const list = phaseReqs.get(e.lane) ?? [];
              list.push({ start: end - e.wallMs, end });
              phaseReqs.set(e.lane, list);
            }
          }
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
          // PR-410 build review FIX: only a refusal close is labelled by its family. A carry walk's unkept-row close
          // now carries a family too (event only), and its restart line must not move.
          const label =
            e.family !== undefined && e.reason === "refusal"
              ? `${e.reason}/${e.family.slice(0, FAMILY_CUT)}`
              : e.reason;
          const key =
            e.phase !== undefined && e.phase !== "idle" ? `${label} in ${e.phase}` : label;
          restarts.set(key, (restarts.get(key) ?? 0) + 1);
          restartTotal += 1;
          if (e.reason === "lane-idle") idleCloses += 1; // R1119: PR-140's idle-lane closes
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
      if (recheckDetail !== undefined)
        lines.push(`  recheck (withheld kills, PR-144): ${recheckDetail}`);

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
            lines.push(`    al-runner inside ${kindLabel} requests: ${parts.join(", ")}`);
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
      for (const [key, v] of verdicts) {
        if (v === "timeout-killed") timeoutKilled += 1;
        if (v !== "no-coverage" && v !== "known-survivor" && !prunedKeys.has(key)) covered += 1;
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

      // R1119 (PR-150): per lane over the mutants phase: busy, waiting between requests at a window
      // boundary (gaps over 5 s), and after its last request (no work left for it, or held). A lane that
      // made no request in the phase is idle for all of it. The phase's edges come from the same clock.
      if (lanes.size > 1 && mutantsSeen) {
        if (untimed || inMutants || mutantPhases.length === 0)
          lines.push(
            "  lanes: no per-lane times (the events carry no atMs, or the mutants phase did not end)",
          );
        else {
          // summed over every batch's mutants phase
          const total = Math.max(
            1,
            mutantPhases.reduce((t, p) => t + (p.to - p.from), 0),
          );
          const pct = (ms: number): string => `${((100 * ms) / total).toFixed(1)}%`;
          const parts = [...lanes]
            .sort((a, b) => a - b)
            .map((lane) => {
              let busy = 0;
              let gapN = 0;
              let gapMs = 0;
              let after = 0;
              let any = false;
              for (const p of mutantPhases) {
                const mine = (p.reqs.get(lane) ?? []).slice().sort((a, b) => a.start - b.start);
                const last = mine[mine.length - 1];
                if (last === undefined) {
                  after += p.to - p.from; // no request in this batch's phase
                  continue;
                }
                any = true;
                let reach = p.from;
                for (const r of mine) {
                  const s0 = Math.max(r.start, reach, p.from);
                  const s1 = Math.min(r.end, p.to);
                  if (s1 > s0) busy += s1 - s0;
                  const gap = r.start - reach;
                  if (reach > p.from && gap > LANE_GAP_MS) {
                    gapN += 1;
                    gapMs += gap;
                  }
                  reach = Math.max(reach, r.end);
                }
                after += Math.max(0, p.to - last.end);
              }
              if (!any) return `lane ${lane} no request (idle ${secs(total)})`;
              return `lane ${lane} busy ${secs(busy)} (${pct(busy)}), waiting at window boundaries ${gapN} (${secs(gapMs)}), after its last request ${secs(after)} (${pct(after)})`;
            });
          lines.push(`  lanes over the mutants phase (${secs(total)}): ${parts.join("; ")}`);
          lines.push(
            `    lane memory holds ${memoryHolds} (printed once per session), idle daemons closed ${idleCloses}`,
          );
        }
      }

      const mutantsMs = phaseMs.get("mutants");
      if (mutantsMs !== undefined && covered > 0)
        lines.push(
          `  per covered mutant: ${(mutantsMs / 1000 / covered).toFixed(2)} s (${covered} scored with coverage over the mutants phase)`,
        );

      if (prunedSeen)
        lines.push(
          `  reach pruning (PR-303): ${prunedEntries.toLocaleString("en-US")} mutant entries left out, ${prunedSurvived.toLocaleString("en-US")} mutant(s) recorded pruned-survived without running`,
        );

      if (suspends > 0 && lines.length > 0)
        lines.push(
          `  suspended ${suspends} time(s), ${suspendedS.toLocaleString("en-US")} s (the machine slept; durations exclude it)`,
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
