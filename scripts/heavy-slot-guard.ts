#!/usr/bin/env bun
/**
 * R905: the guard `scripts/heavy-slot.sh` runs after it took a slot and wrote its class.
 *
 *   bun scripts/heavy-slot-guard.ts <lockDir> <slot> <baseapp|other> [peakGiB]
 *
 * Same verdict as corpus-snapshot's in-slot guard (`heavyVerdict`): the other held slots, their
 * classes and the real `ps` scan. R952 (R953): then the memory rule (`memoryVerdict`): the cgroup's
 * headroom against this job's expected peak (the class default when none is given) and the peaks the
 * other held slots declared. Prints both verdicts; exits 75 (HEAVY_GUARD_EXIT) to refuse, 0 to go.
 * Test seams: LETHAL_HEAVY_PS_FILE names a file holding `ps -eo pid,ppid,pgid,args` output;
 * LETHAL_HEAVY_CGROUP_DIR names a folder holding `memory.current`, `memory.max` (and `memory.stat`)
 * in place of /sys/fs/cgroup.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HEAVY_GUARD_EXIT, SLOTS, heavyVerdict, parsePs, slotHeld } from "./corpus-snapshot.ts";
import {
  DEFAULT_PEAK_GIB,
  memoryVerdict,
  readContainerMemory,
  readSlot,
} from "./heavy-slot-class.ts";

if (import.meta.main) {
  const [dir, slotArg, cls, peakArg] = process.argv.slice(2);
  const mine = Number(slotArg);
  if (dir === undefined || !SLOTS.some((s) => s === mine) || (cls !== "baseapp" && cls !== "other"))
    throw new Error("usage: heavy-slot-guard.ts <lockDir> <1|2|3> <baseapp|other> [peakGiB]");
  const peak = peakArg === undefined ? DEFAULT_PEAK_GIB[cls] : Number(peakArg);
  if (!(peak > 0)) throw new Error(`heavy-slot-guard: bad peak ${peakArg}`);
  const held = SLOTS.filter((s) => s !== mine && slotHeld(dir, s));
  const pids = held
    .map((s) => Number(readFileSync(join(dir, `heavy.${s}`), "utf8").trim()))
    .filter((p) => !Number.isNaN(p));
  const psFile = process.env.LETHAL_HEAVY_PS_FILE;
  const ps =
    psFile !== undefined
      ? readFileSync(psFile, "utf8")
      : Bun.spawnSync(["ps", "-eo", "pid,ppid,pgid,args"], { stdout: "pipe" }).stdout.toString();
  const slots = held.map((s) => readSlot(dir, s));
  const v = heavyVerdict(
    parsePs(ps),
    process.pid,
    pids,
    held.length,
    cls === "baseapp",
    slots.map((s) => s?.cls),
  );
  // A held slot with no readable class (a bare flock, or a pid that died) counts at the larger default.
  const heldPeaks = slots.map((s) => s?.peakGiB ?? Math.max(...Object.values(DEFAULT_PEAK_GIB)));
  const m = memoryVerdict(readContainerMemory(), heldPeaks, peak);
  console.error(v.message);
  console.error(m.message);
  process.exit(v.refuse || m.refuse ? HEAVY_GUARD_EXIT : 0);
}
