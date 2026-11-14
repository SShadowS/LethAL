#!/usr/bin/env bun
/**
 * R905: the guard `scripts/heavy-slot.sh` runs after it took a slot and wrote its class.
 *
 *   bun scripts/heavy-slot-guard.ts <lockDir> <slot> <baseapp|other> [peakGiB]
 *
 * R960 (owner ruling 2026-11-13: heavy jobs are admitted by memory only): where the cgroup names a
 * limit, the memory rule alone decides (`memoryVerdict`, R953): used now + this job's peak + reserve,
 * and the other held slots' declared peaks + this job's peak + reserve, both under `memory.max`. No job
 * count or class cap applies then; the slot files (`SLOTS`) remain only as a file-count ceiling set
 * high enough not to bind. With no cgroup limit to read (a host without cgroup v2), the old count
 * verdict (`heavyVerdict`: held slots, their classes, the `ps` scan) decides, as before R953.
 * Prints the verdict it used; exits 75 (HEAVY_GUARD_EXIT) to refuse, 0 to go.
 * Test seams: LETHAL_HEAVY_PS_FILE names a file holding `ps -eo pid,ppid,pgid,args` output;
 * LETHAL_HEAVY_CGROUP_DIR names a folder holding `memory.current`, `memory.max` (and `memory.stat`)
 * in place of /sys/fs/cgroup.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HEAVY_GUARD_EXIT,
  SLOTS,
  heavyVerdict,
  parsePs,
  slotHeld,
  unslottedPeaks,
} from "./corpus-snapshot.ts";
import {
  DEFAULT_PEAK_GIB,
  MEMORY_RESERVE_GIB,
  SMALL_ADMITS_LEDGER,
  markSlotSmall,
  memoryVerdict,
  readContainerMemory,
  readSlot,
} from "./heavy-slot-class.ts";

/** The pid the slot's lock file names (heavy-slot.sh writes its own; the guard runs under `flock`). */
function holderPid(dir: string, slot: number): string {
  try {
    return readFileSync(join(dir, `heavy.${slot}`), "utf8").trim();
  } catch {
    return "?";
  }
}

if (import.meta.main) {
  const [dir, slotArg, cls, peakArg] = process.argv.slice(2);
  const mine = Number(slotArg);
  if (dir === undefined || !SLOTS.some((s) => s === mine) || (cls !== "baseapp" && cls !== "other"))
    throw new Error("usage: heavy-slot-guard.ts <lockDir> <slot> <baseapp|other> [peakGiB]");
  const peak = peakArg === undefined ? DEFAULT_PEAK_GIB[cls] : Number(peakArg);
  if (!(peak > 0)) throw new Error(`heavy-slot-guard: bad peak ${peakArg}`);
  const held = SLOTS.filter((s) => s !== mine && slotHeld(dir, s));
  const slots = held.map((s) => readSlot(dir, s));
  const pids = held
    .map((s) => Number(readFileSync(join(dir, `heavy.${s}`), "utf8").trim()))
    .filter((p) => !Number.isNaN(p));
  const psFile = process.env.LETHAL_HEAVY_PS_FILE;
  const ps =
    psFile !== undefined
      ? readFileSync(psFile, "utf8")
      : Bun.spawnSync(["ps", "-eo", "pid,ppid,pgid,args"], { stdout: "pipe" }).stdout.toString();
  const procs = parsePs(ps);
  // A held slot with no readable class (a bare flock, or a pid that died) counts at the larger default;
  // a heavy job in no slot at its class default (review r1: memory.current holds only what it uses now).
  const heldPeaks = [
    ...slots.map((s) => s?.peakGiB ?? Math.max(...Object.values(DEFAULT_PEAK_GIB))),
    ...unslottedPeaks(
      procs,
      process.pid,
      pids,
      slots.map((s) => s?.cls),
    ),
  ];
  // R992: small jobs held, or undefined when a held slot's class cannot be read (fail closed: no allowance).
  const smallHeld = slots.every((s) => s !== undefined)
    ? slots.filter((s) => s?.small === true).length
    : undefined;
  const sample = readContainerMemory();
  const m = memoryVerdict(sample, heldPeaks, peak, MEMORY_RESERVE_GIB, smallHeld);
  console.error(m.message);
  if (m.small === true) {
    markSlotSmall(dir, mine);
    // One line per admission that passed only by the R992 allowance.
    const gib = (b: number | undefined) => (b === undefined ? "?" : (b / 2 ** 30).toFixed(2));
    appendFileSync(
      join(dir, SMALL_ADMITS_LEDGER),
      `${[new Date().toISOString(), `heavy.${mine}`, cls, peak, gib(sample?.usedBytes), heldPeaks.reduce((s, p) => s + p, 0), gib(sample?.maxBytes), holderPid(dir, mine)].join("\t")}\n`,
    );
  }
  // R991: a job that can never fit fails by name (exit 2: retrying never helps), so a --wait ticket
  // never waits for it, and never holds the queue's head for it.
  if (m.never === true) process.exit(2);
  if (m.off !== true) process.exit(m.refuse ? HEAVY_GUARD_EXIT : 0);
  // No cgroup limit: the count verdict, as before R953.
  const v = heavyVerdict(
    procs,
    process.pid,
    pids,
    held.length,
    cls === "baseapp",
    slots.map((s) => s?.cls),
  );
  console.error(v.message);
  process.exit(v.refuse ? HEAVY_GUARD_EXIT : 0);
}
