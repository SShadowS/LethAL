#!/usr/bin/env bun
/**
 * RUST-01: run a command and report its wall time and peak resident memory (maxRSS, from the OS
 * through Bun.spawn's resourceUsage).
 *
 * The unit of maxRSS depends on the platform:
 *   - win32: KILOBYTES. Measured 2026-09-27: a child that allocates and fills 1 GB printed 1,364 MB.
 *   - linux: BYTES. Measured 2026-10-03 in the kraken container: a 1 GB child printed
 *     `peak_mb 1061668` when divided by 1024 as if KB.
 * Any other platform is refused: no unit has been measured there, and a guessed unit is a wrong number.
 *
 *   bun scripts/measure-peak.ts <command> [args...]
 */

/** Thrown when maxRSS is read on a platform whose unit has not been measured. */
export class UnknownMaxRssUnitError extends Error {
  constructor(platform: string) {
    super(`measure-peak: the maxRSS unit on platform "${platform}" has not been measured`);
    this.name = "UnknownMaxRssUnitError";
  }
}

/** Convert Bun's `resourceUsage().maxRSS` to megabytes, using the unit measured for the platform. */
export function maxRssToMb(maxRss: number | bigint, platform: string): number {
  const raw = Number(maxRss);
  if (platform === "linux") return raw / (1024 * 1024);
  if (platform === "win32") return raw / 1024;
  throw new UnknownMaxRssUnitError(platform);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv.length === 0) throw new Error("usage: measure-peak.ts <command> [args...]");
  const t0 = performance.now();
  const child = Bun.spawn(argv, { stdout: "inherit", stderr: "inherit" });
  await child.exited;
  const usage = child.resourceUsage();
  if (usage === undefined) throw new Error("measure-peak: the child reported no resource usage");
  const wall = ((performance.now() - t0) / 1000).toFixed(2);
  const peakMb = Math.round(maxRssToMb(usage.maxRSS, process.platform));
  console.error(`measure-peak: exit ${child.exitCode} wall_s ${wall} peak_mb ${peakMb}`);
  process.exit(child.exitCode ?? 1);
}
