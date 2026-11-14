#!/usr/bin/env bun
/**
 * R992: the measured peak of one heavy job, for the real-vs-declared ledger (`PEAKS_LEDGER`).
 *
 *   bun scripts/heavy-slot-peak.ts <root pid> <out file> [sample seconds]
 *
 * `scripts/heavy-slot.sh` starts it beside the admitted command. Every `sample` seconds (default 5) it
 * sums the resident memory of `root`'s process tree (this sampler and its own children left out) and
 * writes the highest sum so far, in KiB, to `out`; it ends when `root` is gone. Test seam:
 * LETHAL_HEAVY_PS_FILE names a file holding `ps -eo pid=,ppid=,rss=` output (read once per sample).
 */
import { readFileSync, writeFileSync } from "node:fs";

/** The summed RSS (KiB) of `root` and every descendant, without `exclude` and its descendants. */
export function treeRssKb(psText: string, root: number, exclude?: number): number {
  const kids = new Map<number, number[]>();
  const rss = new Map<number, number>();
  for (const line of psText.split("\n")) {
    const [pid, ppid, kb] = line.trim().split(/\s+/).map(Number);
    if (pid === undefined || ppid === undefined || kb === undefined) continue;
    if (Number.isNaN(pid) || Number.isNaN(ppid) || Number.isNaN(kb)) continue;
    rss.set(pid, kb);
    const list = kids.get(ppid);
    if (list === undefined) kids.set(ppid, [pid]);
    else list.push(pid);
  }
  if (!rss.has(root)) return 0;
  let sum = 0;
  const seen = new Set<number>();
  const queue = [root];
  for (let p = queue.shift(); p !== undefined; p = queue.shift()) {
    if (seen.has(p) || p === exclude) continue;
    seen.add(p);
    sum += rss.get(p) ?? 0;
    queue.push(...(kids.get(p) ?? []));
  }
  return sum;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

if (import.meta.main) {
  const [rootArg, out, everyArg] = process.argv.slice(2);
  const root = Number(rootArg);
  if (!(root > 0) || out === undefined)
    throw new Error("usage: heavy-slot-peak.ts <root pid> <out file> [sample seconds]");
  const every = everyArg === undefined ? 5 : Number(everyArg);
  const psFile = process.env.LETHAL_HEAVY_PS_FILE;
  let max = 0;
  writeFileSync(out, "0\n");
  while (alive(root)) {
    const ps =
      psFile !== undefined
        ? readFileSync(psFile, "utf8")
        : Bun.spawnSync(["ps", "-eo", "pid=,ppid=,rss="], { stdout: "pipe" }).stdout.toString();
    const kb = treeRssKb(ps, root, process.pid);
    if (kb > max) {
      max = kb;
      writeFileSync(out, `${max}\n`);
    }
    await Bun.sleep(every * 1000);
  }
}
