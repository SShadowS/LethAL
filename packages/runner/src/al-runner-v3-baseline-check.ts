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
export const BASELINE_SAMPLE_EVERY = 10;
export const BASELINE_SAMPLE_CAP = 16;

/**
 * The items re-run one-shot: the 2nd and the LAST baselined, plus every `BASELINE_SAMPLE_EVERY`th
 * (index 10, 20, ...), at most `BASELINE_SAMPLE_CAP` (the 2nd, the last, and an even thinning of the
 * rest). Index 0 is never a sample: it runs on a fresh daemon, which cannot show state a long run
 * builds up. With a single item there is nothing else to compare, so that one is the sample. `ids`
 * is in baseline order. Deterministic: no clock, no randomness. 112 codeunits give 13 samples.
 */
export function baselineSampleIds(
  ids: readonly number[],
  every: number = BASELINE_SAMPLE_EVERY,
  cap: number = BASELINE_SAMPLE_CAP,
): number[] {
  if (ids.length === 0) return [];
  if (ids.length === 1) return [...ids];
  const picked = new Set<number>([1, ids.length - 1]);
  for (let i = every; i < ids.length; i += every) picked.add(i);
  let idx = [...picked].sort((a, b) => a - b);
  if (idx.length > cap) {
    const middle = idx.slice(1, -1);
    const room = Math.max(0, cap - 2);
    const thinned = Array.from({ length: room }, (_, k) =>
      middle.at(Math.floor(((k + 0.5) * middle.length) / room)),
    ).filter((x): x is number => x !== undefined);
    idx = [idx[0] ?? 1, ...thinned, idx.at(-1) ?? 1];
  }
  return [...new Set(idx)].map((i) => ids[i]).filter((x): x is number => x !== undefined);
}

/** R951: the fewest clean compared samples a fill may end with (or fewer when the plan holds fewer). */
export const BASELINE_MIN_CLEAN_SAMPLES = 4;

/**
 * R951 (R2): why a one-shot run gave no answer, and the ones that only SKIP the sample (replaced by
 * another): no process ran or it did not finish. Anything else (an exit outside 0/1/7/8, rows that
 * do not decode) drops the session by name.
 */
export const SKIPPABLE_NO_ANSWER: readonly string[] = ["memory-gate", "spawn-error", "timed-out"];

/** The exit codes a one-shot answer may carry and still be read as rows (`cleanBaselineAnswer`'s). */
export const ONE_SHOT_EXITS: readonly number[] = [0, 1, 7, 8];

/**
 * R951 (R5): the cross-check's sample as a fill walks `order`, with replacements. A skipped sample
 * is replaced by the next item after the loop's position that is not yet sampled (`next`), or, when
 * none is left (the LAST sample), by the last earlier unsampled item that qualifies (`last`).
 * Position 0 is never a sample (a fresh daemon shows no built-up state).
 */
export class SamplePlan<T> {
  private readonly picked: Set<T>;
  constructor(
    private readonly order: readonly T[],
    planned: Iterable<T>,
  ) {
    this.picked = new Set(planned);
  }
  has(k: T): boolean {
    return this.picked.has(k);
  }
  next(pos: number, ok: (k: T) => boolean): T | undefined {
    for (const k of this.order.slice(pos + 1)) {
      if (!this.picked.has(k) && ok(k)) return this.take(k);
    }
    return undefined;
  }
  last(ok: (k: T) => boolean): T | undefined {
    for (const k of this.order.slice(1).reverse()) {
      if (!this.picked.has(k) && ok(k)) return this.take(k);
    }
    return undefined;
  }
  private take(k: T): T {
    this.picked.add(k);
    return k;
  }
}

/** Every `file:line` a statement hit, sorted: the exact coverage set of one coverage list. */
function hitSet(
  files: readonly {
    readonly file: string;
    readonly statements?: readonly { line?: number; hits?: number }[];
  }[],
): Set<string> {
  const out = new Set<string>();
  for (const f of files) {
    for (const s of f.statements ?? []) {
      if ((s.hits ?? 0) > 0) out.add(`${f.file.replace(/\\/g, "/").toLowerCase()}:${s.line}`);
    }
  }
  return out;
}

/** How many differing keys a message names per side. */
const NAMED_KEYS = 5;

/** `daemon only 3: a:1, b:2, c:3; one-shot only 0`, or `undefined` when the sets are equal. Keys are `file:line` only. */
function keyDiff(daemon: ReadonlySet<string>, oneShot: ReadonlySet<string>): string | undefined {
  const onlyD = [...daemon].filter((k) => !oneShot.has(k)).sort();
  const onlyO = [...oneShot].filter((k) => !daemon.has(k)).sort();
  if (onlyD.length === 0 && onlyO.length === 0) return undefined;
  const side = (name: string, keys: readonly string[]) =>
    `${name} only ${keys.length}${keys.length > 0 ? `: ${keys.slice(0, NAMED_KEYS).join(", ")}${keys.length > NAMED_KEYS ? ", ..." : ""}` : ""}`;
  return `${side("daemon", onlyD)}; ${side("one-shot", onlyO)}`;
}

/**
 * The text compared: a refusal's first line only, as R678's verdict for a refusal keys on notRun plus the first
 * line (R1007); the rest of a refusal's text can differ by path. Any other row's whole text.
 */
const textOf = (r: ComparableRow): string =>
  r.notRun ? ((r.message ?? "").split("\n")[0] ?? "") : (r.message ?? "");

const describeRow = (r: ComparableRow): string =>
  `${r.status}${r.notRun ? ", not run" : ""}${r.flagged === true ? ", flagged" : ""}`;

/**
 * Differences between a daemon answer and a fresh process's answer for ONE codeunit, per test:
 * status, notRun, the fail text (NOT `flagged`: serve cannot report it, R949), and the exact per-test coverage set (and the whole
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
    // Which field differs, by name (never the text itself).
    const fields = [
      ...(a.status !== b.status ? ["status"] : []),
      ...(a.notRun !== b.notRun ? ["notRun"] : []),
      // R949: `flagged` is never compared: serve rows cannot carry it (upstream issue 7954).
      ...(textOf(a) !== textOf(b) ? ["failText"] : []),
    ];
    if (fields.length > 0) {
      why.push(
        `${m}: differs in ${fields.join(", ")} (daemon ${describeRow(a)}; one-shot ${describeRow(b)})`,
      );
    }
  }
  if (daemon.coverage.kind !== oneShot.coverage.kind) {
    why.push(`coverage: daemon ${daemon.coverage.kind}, one-shot ${oneShot.coverage.kind}`);
  } else if (daemon.coverage.kind === "doc" && oneShot.coverage.kind === "doc") {
    const whole = keyDiff(hitSet(daemon.coverage.coverage), hitSet(oneShot.coverage.coverage));
    if (whole !== undefined) why.push(`coverage: the whole call differs (${whole})`);
    const per = (c: V3CoverageRead) =>
      new Map(
        c.kind === "doc"
          ? c.perTestCoverage.map((e) => [e.test.toLowerCase(), hitSet(e.coverage)])
          : [],
      );
    const pd = per(daemon.coverage);
    const po = per(oneShot.coverage);
    for (const t of [...new Set([...pd.keys(), ...po.keys()])].sort()) {
      const diff = keyDiff(pd.get(t) ?? new Set(), po.get(t) ?? new Set());
      if (diff !== undefined) why.push(`${t}: coverage differs (${diff})`);
      else if (pd.has(t) !== po.has(t)) {
        why.push(`${t}: coverage entry only in the ${pd.has(t) ? "daemon" : "one-shot"} answer`);
      }
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

/**
 * A budget is `max(2 x duration, floor)`, and the duration it reads is the verdict's: the row's own
 * `durationMs`, else the call's wall time. A warm daemon shortens both, so an answer may stand only
 * when `2 x duration < floor` for every row, on that same duration (R790's rule). True: re-run that
 * codeunit (or test) one-shot and use its answer.
 */
export function durationCouldMoveBudget(
  rows: readonly { readonly durationMs?: number }[],
  wallMs: number,
  floorMs: number,
): boolean {
  return rows.some((r) => 2 * (r.durationMs ?? wallMs) >= floorMs);
}

/**
 * R952 (R948): a process's resident memory in bytes (`VmRSS` of `/proc/<pid>/status`), or undefined
 * when it cannot be read (no /proc, a dead pid). `read` is injectable: tests never read `/proc`.
 */
export function readProcessRssBytes(
  pid: number,
  read: (path: string) => string = (p) => readFileSync(p, "utf8"),
): number | undefined {
  try {
    const m = /^VmRSS:\s+(\d+)\s+kB$/m.exec(read(`/proc/${pid}/status`));
    return m?.[1] === undefined ? undefined : Number(m[1]) * 1024;
  } catch {
    return undefined;
  }
}

/** The most bytes in use before no new call starts: the limit less the headroom. */
export function memoryBoundBytes(maxBytes: number, headroomGb: number): number {
  return Math.max(0, maxBytes - Math.round(headroomGb * 2 ** 30));
}
