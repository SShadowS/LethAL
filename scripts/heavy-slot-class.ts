/**
 * R905: the class of a held heavy slot. Whoever takes `<lockDir>/heavy.<n>` writes
 * `<lockDir>/heavy.<n>.class` right after the lock, holding `<class> <pid> <peak GiB>` (R952), and
 * removes it on exit. The memory rule (`memoryVerdict`, the only rule under a cgroup limit, R960) reads
 * its peak; the no-cgroup count fallback (`heavyVerdict`) reads its class, because a job over a corpus
 * COPY is invisible to the `ps` scan. The file is stale by pid: a pid that is dead reads as no class.
 * No class counts as BaseApp (the safe side).
 * Shell takers use `scripts/heavy-slot.sh`.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readCgroupMemory } from "../packages/runner/src/al-runner-v3-baseline-check.ts";

export type SlotClass = "baseapp" | "other";

const classFile = (lockDir: string, slot: number): string => join(lockDir, `heavy.${slot}.class`);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, not ours
  }
}

/** The slot's class, or undefined when there is no file, it is unreadable, or its pid is dead. */
export function readSlotClass(lockDir: string, slot: number): SlotClass | undefined {
  return readSlot(lockDir, slot)?.cls;
}

/**
 * R952 (R953): the slot's class and its declared expected peak in GiB (the class default when the
 * file names none, as a file written before R952 does). Undefined as readSlotClass is.
 */
export function readSlot(
  lockDir: string,
  slot: number,
): { readonly cls: SlotClass; readonly peakGiB: number } | undefined {
  let text: string;
  try {
    text = readFileSync(classFile(lockDir, slot), "utf8");
  } catch {
    return undefined;
  }
  const m = /^(baseapp|other) (\d+)(?: (\d+(?:\.\d+)?))?\s*$/.exec(text);
  if (m === null) return undefined;
  const pid = Number(m[2]);
  if (!(pid > 0 && alive(pid))) return undefined;
  const cls = m[1] as SlotClass;
  return { cls, peakGiB: m[3] !== undefined ? Number(m[3]) : DEFAULT_PEAK_GIB[cls] };
}

/** Write our class (and peak) for the slot (pid = this process) and remove it when this process exits. */
export function writeSlotClass(
  lockDir: string,
  slot: number,
  cls: SlotClass,
  peakGiB: number = DEFAULT_PEAK_GIB[cls],
): void {
  const file = classFile(lockDir, slot);
  writeFileSync(file, `${cls} ${process.pid} ${peakGiB}\n`);
  process.once("exit", () => rmSync(file, { force: true }));
}

/**
 * R952 (R953): admission by memory. The container's limit is its cgroup's `memory.max` (32 GiB),
 * shared by every lane, not the host's memory `free` shows. Expected peaks, from R-934's 30 s samples
 * of every held slot's process tree (R952, R948) and the orchestrator's interim table (2026-11-13):
 * a long v3 serve run reached 12.4-15.7 GB with an unbounded daemon; with R948's daemon cap
 * (`daemonMaxRssGb` 6, the default) Subcontracting's 2 h serve run peaked at 7,927 MiB (7.7 GiB: its
 * daemon at 5,988 MiB plus LethAL and the rest; its baseline 7.8 GB) -> 8; a BaseApp-class v3 run
 * 3.8-5.3 GB, a BaseApp instrumentation job about 10.6 GB -> 12 (R-942's DO baseline reached 30.8 GB
 * and was OOM-killed: such a job declares its own, larger peak and runs under a watchdog); the v3 gate
 * about 2.0 GB -> 2; a module pool build 0.37-0.55 GB -> 1. A job that declares nothing gets its
 * class's default: `other` 8 (a capped serve run), `baseapp` 12.
 */
export const PEAK_GIB = { serve: 8, baseline: 12, gate: 2, build: 1 } as const;
export const DEFAULT_PEAK_GIB: Readonly<Record<SlotClass, number>> = { baseapp: 12, other: 8 };
/** GiB kept free below `memory.max` for the sessions, caches and non-heavy work the cgroup also counts. */
export const MEMORY_RESERVE_GIB = 4;

/** `serve`, `baseline`, `gate`, `build` or a number of GiB; undefined when it is none of these. */
export function parsePeak(arg: string): number | undefined {
  if (Object.hasOwn(PEAK_GIB, arg)) return PEAK_GIB[arg as keyof typeof PEAK_GIB];
  const n = Number(arg);
  return /^\d+(\.\d+)?$/.test(arg) && n > 0 ? n : undefined;
}

const GIB = 2 ** 30;

/**
 * The container's memory for the admission rule: /sys/fs/cgroup, or LETHAL_HEAVY_CGROUP_DIR (the test
 * seam; scripts/test-preload.ts points it at a folder that does not exist, so no test reads the real
 * cgroup and a test that sets nothing sees the rule off).
 */
export function readContainerMemory(): ReturnType<typeof readCgroupMemory> {
  return readCgroupMemory(undefined, process.env.LETHAL_HEAVY_CGROUP_DIR ?? "/sys/fs/cgroup");
}

/**
 * Admit a job of `peakGiB` when BOTH hold: (1) what the container uses now, plus the job's peak and
 * the reserve, fits under `memory.max`; (2) the peaks the held slots declared, plus the job's peak and
 * the reserve, fit too: jobs that are small now still grow to their peak, so (1) alone would let two
 * young serve runs start together and outgrow the limit. With no cgroup limit to read there is
 * nothing to bound against: the job is admitted and the message says the memory rule is off.
 * R991: a job whose peak plus the reserve is over `memory.max` itself can NEVER be admitted, however
 * the queue drains: `never` says so, and the guard fails it by name instead of letting it wait.
 */
export function memoryVerdict(
  sample:
    | { readonly usedBytes: number; readonly maxBytes?: number; readonly source: string }
    | undefined,
  heldPeaksGiB: readonly number[],
  peakGiB: number,
  reserveGiB: number = MEMORY_RESERVE_GIB,
): {
  readonly refuse: boolean;
  readonly message: string;
  readonly off?: true;
  readonly never?: true;
} {
  if (sample?.maxBytes === undefined)
    return {
      refuse: false,
      off: true,
      message: `memory rule off: ${sample === undefined ? "no cgroup v2 memory.current can be read" : `${sample.source} names no limit`}`,
    };
  const max = sample.maxBytes / GIB;
  const used = sample.usedBytes / GIB;
  const held = heldPeaksGiB.reduce((s, p) => s + p, 0);
  if (peakGiB + reserveGiB > max) {
    const f = (n: number) => n.toFixed(1);
    return {
      refuse: true,
      never: true,
      message: `memory: this job's peak ${f(peakGiB)} GiB + reserve ${f(reserveGiB)} = ${f(peakGiB + reserveGiB)} > max ${f(max)} GiB -> NEVER FITS, whatever else runs: lower --peak or raise the limit (R991)`,
    };
  }
  const nowFits = used + peakGiB + reserveGiB <= max;
  const peaksFit = held + peakGiB + reserveGiB <= max;
  const f = (n: number) => n.toFixed(1);
  const why = !nowFits
    ? `used + peak + reserve = ${f(used + peakGiB + reserveGiB)}`
    : `held peaks + peak + reserve = ${f(held + peakGiB + reserveGiB)}`;
  const outcome = nowFits && peaksFit ? "admitted" : `REFUSED (${why} > ${f(max)})`;
  const message = `memory: max ${f(max)} GiB, used ${f(used)}, held slots' peaks ${f(held)} (${heldPeaksGiB.length}), this job's peak ${f(peakGiB)}, reserve ${f(reserveGiB)} -> ${outcome}`;
  return { refuse: !(nowFits && peaksFit), message };
}
