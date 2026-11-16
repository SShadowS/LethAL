#!/usr/bin/env bun
/**
 * PR-73: lower a RUNNING heavy job's declared peak, one way only.
 *
 *   bun scripts/heavy-slot-lower.ts <slot> <holder pid> <new peak GiB>
 *
 * Why: a slot's declared peak (`<lock dir>/heavy.<n>.class`, "<class> <pid> <peak>", R952) is what the guard adds up for every
 * later admission. A job that declared far more than it uses blocks others for its whole life (2026-11-16: two serve legs at a
 * declared 8 GiB using 1.3 GiB kept three jobs queued about 2 h at 10 of 32 GiB used). This lets the slot's holder lower it.
 *
 * The rules, each a refusal (exit 1) with its reason on stderr:
 * - the slot's class file must name `<holder pid>`, and that pid must be alive and a heavy-slot.sh (so a slot that changed hands
 *   is never lowered by mistake: every lane runs as the same user here, so naming the pid is the holder's proof);
 * - the new peak must be BELOW the declared one (raising, or an equal value, is refused: a raise would be an admission the guard
 *   never made);
 * - the new peak must be at least the measured tree plus a margin. Measured = the larger of the sampler's peak so far
 *   (`heavy.<n>.peak`, KiB, R992) and the holder's process tree right now (`ps`); margin = the larger of MARGIN_GIB and
 *   MARGIN_SHARE of it.
 * The file is rewritten by a temp file and a rename, keeping the class, the pid and a ` small` mark: a guard reading at the same
 * moment sees the old (higher) value or the new one, never a torn line, so no lock is taken. The guard re-reads every class file
 * on its next admission. Exit 2: bad arguments, or no such slot.
 *
 * Test seams: LETHAL_HEAVY_LOCK_DIR (default /coord/locks); LETHAL_HEAVY_PEAK_PS_FILE, a file of `ps -eo pid=,ppid=,rss=`
 * output, as heavy-slot-peak.ts reads.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { treeRssKb } from "./heavy-slot-peak.ts";

export const MARGIN_GIB = 1;
export const MARGIN_SHARE = 0.25;
const KIB_PER_GIB = 1024 * 1024;

export interface SlotLine {
  readonly cls: string;
  readonly pid: number;
  readonly peakGiB: number;
  readonly small: boolean;
}

/** The class file's line, or undefined when it has no explicit peak (a file written before R952 is not lowered). */
export function parseSlotLine(text: string): SlotLine | undefined {
  const m = /^(baseapp|other) (\d+) (\d+(?:\.\d+)?)( small)?\s*$/.exec(text);
  if (m === null) return undefined;
  return { cls: m[1] ?? "", pid: Number(m[2]), peakGiB: Number(m[3]), small: m[4] !== undefined };
}

/** The smallest peak the holder may declare, given its measured tree in GiB. */
export function floorGiB(measuredGiB: number): number {
  return measuredGiB + Math.max(MARGIN_GIB, MARGIN_SHARE * measuredGiB);
}

/** Why the new peak is refused, or undefined when it may be written. */
export function refusal(
  line: SlotLine,
  holderPid: number,
  newGiB: number,
  measuredGiB: number,
): string | undefined {
  if (line.pid !== holderPid) return `the slot is held by pid ${line.pid}, not ${holderPid}`;
  if (!(newGiB < line.peakGiB))
    return `--peak can only be lowered: ${newGiB} GiB is not below the declared ${line.peakGiB} GiB`;
  const floor = floorGiB(measuredGiB);
  if (newGiB < floor)
    return `${newGiB} GiB is under the measured tree ${measuredGiB.toFixed(2)} GiB plus its margin (at least ${floor.toFixed(2)} GiB)`;
  return undefined;
}

function isHeavySlotSh(pid: number): boolean {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("heavy-slot.sh");
  } catch {
    return false;
  }
}

if (import.meta.main) {
  const [slotArg, pidArg, newArg] = process.argv.slice(2);
  const slot = Number(slotArg);
  const holder = Number(pidArg);
  const newGiB = Number(newArg);
  if (!Number.isInteger(slot) || slot < 1 || !(holder > 0) || !(newGiB > 0)) {
    console.error("usage: heavy-slot-lower.ts <slot 1..6> <holder pid> <new peak GiB, above 0>");
    process.exit(2);
  }
  const dir = process.env.LETHAL_HEAVY_LOCK_DIR ?? "/coord/locks";
  const file = join(dir, `heavy.${slot}.class`);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    console.error(`heavy-slot-lower: slot ${slot} is not held (no ${file})`);
    process.exit(2);
  }
  const line = parseSlotLine(text);
  if (line === undefined) {
    console.error(`heavy-slot-lower: ${file} names no explicit peak; not lowered`);
    process.exit(1);
  }
  if (!isHeavySlotSh(holder)) {
    console.error(`heavy-slot-lower: pid ${holder} is not a live heavy-slot.sh; not lowered`);
    process.exit(1);
  }
  let peakKb = 0;
  try {
    peakKb = Number(readFileSync(join(dir, `heavy.${slot}.peak`), "utf8").trim()) || 0;
  } catch {
    peakKb = 0; // no sample yet: the tree now decides
  }
  const psFile = process.env.LETHAL_HEAVY_PEAK_PS_FILE;
  const ps =
    psFile !== undefined
      ? readFileSync(psFile, "utf8")
      : Bun.spawnSync(["ps", "-eo", "pid=,ppid=,rss="], { stdout: "pipe" }).stdout.toString();
  const measuredGiB = Math.max(peakKb, treeRssKb(ps, holder)) / KIB_PER_GIB;
  const why = refusal(line, holder, newGiB, measuredGiB);
  if (why !== undefined) {
    console.error(`heavy-slot-lower: refused: ${why}`);
    process.exit(1);
  }
  const tmp = `${file}.lower.${process.pid}`;
  writeFileSync(tmp, `${line.cls} ${line.pid} ${newGiB}${line.small ? " small" : ""}\n`);
  renameSync(tmp, file);
  console.error(
    `heavy-slot-lower: slot ${slot} (pid ${holder}): declared peak ${line.peakGiB} -> ${newGiB} GiB ` +
      `(measured ${measuredGiB.toFixed(2)} GiB, floor ${floorGiB(measuredGiB).toFixed(2)} GiB); the guard reads it at its next admission`,
  );
}
