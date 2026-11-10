/**
 * R905: the class of a held heavy slot. Whoever takes `<lockDir>/heavy.<n>` writes
 * `<lockDir>/heavy.<n>.class` right after the lock, holding `baseapp <pid>` or `other <pid>`, and
 * removes it on exit. The guard (`heavyVerdict`) reads it: a job over a corpus COPY is invisible to
 * the `ps` scan, so the class is the only way to know a slot is BaseApp-class. The file is stale by
 * pid: a pid that is dead reads as no class. No class counts as BaseApp (the safe side).
 * Shell takers use `scripts/heavy-slot.sh`.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
  let text: string;
  try {
    text = readFileSync(classFile(lockDir, slot), "utf8");
  } catch {
    return undefined;
  }
  const m = /^(baseapp|other) (\d+)\s*$/.exec(text);
  if (m === null) return undefined;
  const pid = Number(m[2]);
  return pid > 0 && alive(pid) ? (m[1] as SlotClass) : undefined;
}

/** Write our class for the slot (pid = this process) and remove it when this process exits. */
export function writeSlotClass(lockDir: string, slot: number, cls: SlotClass): void {
  const file = classFile(lockDir, slot);
  writeFileSync(file, `${cls} ${process.pid}\n`);
  process.once("exit", () => rmSync(file, { force: true }));
}
