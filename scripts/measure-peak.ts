#!/usr/bin/env bun
/**
 * RUST-01: run a command and report its wall time and peak resident memory (maxRSS in KB, from the
 * OS through Bun.spawn's resourceUsage). Proven on Windows 2026-09-27: a child that allocates and
 * fills 1 GB reports 1,364 MB.
 *
 *   bun scripts/measure-peak.ts <command> [args...]
 */
const argv = process.argv.slice(2);
if (argv.length === 0) throw new Error("usage: measure-peak.ts <command> [args...]");
const t0 = performance.now();
const child = Bun.spawn(argv, { stdout: "inherit", stderr: "inherit" });
await child.exited;
const usage = child.resourceUsage();
if (usage === undefined) throw new Error("measure-peak: the child reported no resource usage");
const wall = ((performance.now() - t0) / 1000).toFixed(2);
const peakMb = Math.round(Number(usage.maxRSS) / 1024);
console.error(`measure-peak: exit ${child.exitCode} wall_s ${wall} peak_mb ${peakMb}`);
process.exit(child.exitCode ?? 1);
