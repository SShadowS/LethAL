#!/usr/bin/env bun
/**
 * R905: the guard `scripts/heavy-slot.sh` runs after it took a slot and wrote its class.
 *
 *   bun scripts/heavy-slot-guard.ts <lockDir> <slot> <baseapp|other>
 *
 * Same verdict as corpus-snapshot's in-slot guard (`heavyVerdict`): the other held slots, their
 * classes and the real `ps` scan. Prints the verdict; exits 75 (HEAVY_GUARD_EXIT) to refuse, 0 to go.
 * Test seam: LETHAL_HEAVY_PS_FILE names a file holding `ps -eo pid,ppid,pgid,args` output.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HEAVY_GUARD_EXIT, SLOTS, heavyVerdict, parsePs, slotHeld } from "./corpus-snapshot.ts";
import { readSlotClass } from "./heavy-slot-class.ts";

if (import.meta.main) {
  const [dir, slotArg, cls] = process.argv.slice(2);
  const mine = Number(slotArg);
  if (dir === undefined || !SLOTS.some((s) => s === mine) || (cls !== "baseapp" && cls !== "other"))
    throw new Error("usage: heavy-slot-guard.ts <lockDir> <1|2|3> <baseapp|other>");
  const held = SLOTS.filter((s) => s !== mine && slotHeld(dir, s));
  const pids = held
    .map((s) => Number(readFileSync(join(dir, `heavy.${s}`), "utf8").trim()))
    .filter((p) => !Number.isNaN(p));
  const psFile = process.env.LETHAL_HEAVY_PS_FILE;
  const ps =
    psFile !== undefined
      ? readFileSync(psFile, "utf8")
      : Bun.spawnSync(["ps", "-eo", "pid,ppid,pgid,args"], { stdout: "pipe" }).stdout.toString();
  const classes = held.map((s) => readSlotClass(dir, s));
  const v = heavyVerdict(parsePs(ps), process.pid, pids, held.length, cls === "baseapp", classes);
  console.error(v.message);
  process.exit(v.refuse ? HEAVY_GUARD_EXIT : 0);
}
