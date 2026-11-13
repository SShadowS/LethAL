/**
 * R948: pure pieces of the daemon baseline and the memory guard, kept apart so a test reads them
 * without a backend.
 *
 * - `baselineSampleIds`, `compareBaselineAnswers`: the in-session cross-check. A daemon baseline
 *   removes the only daemon-versus-fresh-process check, so a few codeunits are also run one-shot and
 *   compared test by test. Any difference drops the daemon baseline for the whole session.
 * - `readCgroupMemory`, `memoryBoundBytes`: the memory guard reads the CONTAINER's cgroup, because
 *   that is what the OOM killer reads (the host is far bigger and shared by every lane).
 */
import { readFileSync } from "node:fs";
import type { V3CoverageRead } from "./al-runner-v3-sleep";

/** One call's answer, as far as the comparison reads it (a `V3Row` subset, so no import cycle). */
export interface ComparableRow {
  readonly method: string;
  readonly status: string;
  readonly message?: string;
  readonly notRun: boolean;
  readonly flagged?: true;
}

/** How many codeunits apart the sample is, and the most it holds (each one-shot run costs a minute). */
export const BASELINE_SAMPLE_EVERY = 25;
export const BASELINE_SAMPLE_CAP = 8;

/**
 * The codeunits re-run one-shot: the first and the last baselined, plus every
 * `BASELINE_SAMPLE_EVERY`th between, at most `BASELINE_SAMPLE_CAP` (the first, the last, and an even
 * thinning of the rest). `ids` is in baseline order. Deterministic: no clock, no randomness.
 */
export function baselineSampleIds(
  ids: readonly number[],
  every: number = BASELINE_SAMPLE_EVERY,
  cap: number = BASELINE_SAMPLE_CAP,
): number[] {
  if (ids.length === 0) return [];
  const picked = new Set<number>([0, ids.length - 1]);
  for (let i = 0; i < ids.length; i += every) picked.add(i);
  let idx = [...picked].sort((a, b) => a - b);
  if (idx.length > cap) {
    const middle = idx.slice(1, -1);
    const room = Math.max(0, cap - 2);
    const thinned = Array.from({ length: room }, (_, k) =>
      middle.at(Math.floor(((k + 0.5) * middle.length) / room)),
    ).filter((x): x is number => x !== undefined);
    idx = [idx[0] ?? 0, ...thinned, idx.at(-1) ?? 0];
  }
  return [...new Set(idx)].map((i) => ids[i]).filter((x): x is number => x !== undefined);
}

/** Every `file:line` a statement hit, sorted: the exact coverage set of one coverage list. */
function hitSet(
  files: readonly {
    readonly file: string;
    readonly statements?: readonly { line?: number; hits?: number }[];
  }[],
): string {
  const out: string[] = [];
  for (const f of files) {
    for (const s of f.statements ?? []) {
      if ((s.hits ?? 0) > 0) out.push(`${f.file.replace(/\\/g, "/").toLowerCase()}:${s.line}`);
    }
  }
  return [...new Set(out)].sort().join("|");
}

/**
 * Differences between a daemon answer and a fresh process's answer for ONE codeunit, per test:
 * status, notRun, `flagged`, the fail text, and the exact per-test coverage set (and the whole
 * call's). Empty: they agree. Durations are not compared (a warm daemon is faster by design; the
 * budget rule handles that).
 */
export function compareBaselineAnswers(
  daemon: { readonly rows: readonly ComparableRow[]; readonly coverage: V3CoverageRead },
  oneShot: { readonly rows: readonly ComparableRow[]; readonly coverage: V3CoverageRead },
): string[] {
  const why: string[] = [];
  const byMethod = (rows: readonly ComparableRow[]) =>
    new Map(rows.map((r) => [r.method.toLowerCase(), r]));
  const d = byMethod(daemon.rows);
  const o = byMethod(oneShot.rows);
  for (const m of [...new Set([...d.keys(), ...o.keys()])].sort()) {
    const a = d.get(m);
    const b = o.get(m);
    if (a === undefined || b === undefined) {
      why.push(`${m}: a row only the ${a === undefined ? "one-shot" : "daemon"} answer has`);
      continue;
    }
    if (a.status !== b.status || a.notRun !== b.notRun || a.flagged !== b.flagged) {
      why.push(
        `${m}: daemon ${a.status}${a.notRun ? " (not run)" : ""}, one-shot ${b.status}${b.notRun ? " (not run)" : ""}`,
      );
    } else if ((a.message ?? "") !== (b.message ?? "")) {
      why.push(`${m}: the fail text differs`);
    }
  }
  if (daemon.coverage.kind !== oneShot.coverage.kind) {
    why.push(`coverage: daemon ${daemon.coverage.kind}, one-shot ${oneShot.coverage.kind}`);
  } else if (daemon.coverage.kind === "doc" && oneShot.coverage.kind === "doc") {
    if (hitSet(daemon.coverage.coverage) !== hitSet(oneShot.coverage.coverage)) {
      why.push("coverage: the whole call's hit set differs");
    }
    const per = (c: V3CoverageRead) =>
      new Map(
        c.kind === "doc"
          ? c.perTestCoverage.map((e) => [e.test.toLowerCase(), hitSet(e.coverage)])
          : [],
      );
    const pd = per(daemon.coverage);
    const po = per(oneShot.coverage);
    for (const t of [...new Set([...pd.keys(), ...po.keys()])].sort()) {
      if (pd.get(t) !== po.get(t)) why.push(`${t}: the per-test coverage set differs`);
    }
  }
  return why;
}

/** What the guard reads: bytes in use, the limit when there is one, and where both came from. */
export interface MemorySample {
  readonly usedBytes: number;
  /** Absent: the cgroup names no limit (`memory.max` is `max`), so there is nothing to bound against. */
  readonly maxBytes?: number;
  /** The file the limit came from, for the guard's first line. */
  readonly source: string;
}

/** R948: how many GiB of headroom the guard keeps below the cgroup limit unless the config says. */
export const MEMORY_HEADROOM_GB_DEFAULT = 4;

/**
 * The container's memory as cgroup v2 reports it: `memory.current` minus `inactive_file` (the page
 * cache the kernel gives back before it kills anything, which is what `docker stats` subtracts too)
 * against `memory.max`. `undefined` when no cgroup v2 file can be read, so the caller says the guard
 * is off, by name. `read` is injectable: tests never read the real `/sys`.
 */
export function readCgroupMemory(
  read: (path: string) => string = (p) => readFileSync(p, "utf8"),
  dir = "/sys/fs/cgroup",
): MemorySample | undefined {
  const num = (p: string): number | undefined => {
    try {
      const n = Number(read(`${dir}/${p}`).trim());
      return Number.isFinite(n) ? n : undefined;
    } catch {
      return undefined;
    }
  };
  const current = num("memory.current");
  if (current === undefined) return undefined;
  let inactive = 0;
  try {
    const m = /^inactive_file (\d+)$/m.exec(read(`${dir}/memory.stat`));
    inactive = m?.[1] === undefined ? 0 : Number(m[1]);
  } catch {
    inactive = 0;
  }
  const max = num("memory.max"); // "max" is not a number: no limit
  return {
    usedBytes: Math.max(0, current - inactive),
    ...(max !== undefined ? { maxBytes: max } : {}),
    source: `${dir}/memory.max`,
  };
}

/** The most bytes in use before no new call starts: the limit less the headroom. */
export function memoryBoundBytes(maxBytes: number, headroomGb: number): number {
  return Math.max(0, maxBytes - Math.round(headroomGb * 2 ** 30));
}
