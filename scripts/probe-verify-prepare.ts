#!/usr/bin/env bun
/** R270 Task 1: time verify's pre-lease reads offline. Prints numbers only, never source. */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { hashTargetSource } from "../packages/runner/src/baseline-snapshot";
import { discoverTests } from "../packages/runner/src/discovery";

async function timed(f: () => Promise<unknown>): Promise<number> {
  const t = performance.now();
  await f();
  return Math.round(performance.now() - t);
}

export async function probe(projectDir: string, testDir: string, symbols: readonly string[]) {
  const names = (await readdir(projectDir, { recursive: true })).filter((n) =>
    n.toLowerCase().endsWith(".al"),
  );
  let projectBytes = 0;
  for (const n of names) projectBytes += (await stat(join(projectDir, n))).size;
  const tests = (await discoverTests(testDir)).length;
  if (names.length === 0 || tests === 0) {
    throw new Error(`probe: ${names.length} .al files, ${tests} tests; refusing to time nothing`);
  }
  const hashMs: number[] = [];
  const discoverMs: number[] = [];
  for (let i = 0; i < 5; i++) {
    hashMs.push(await timed(() => hashTargetSource(projectDir, symbols)));
    discoverMs.push(await timed(() => discoverTests(testDir)));
  }
  return { projectAlFiles: names.length, projectBytes, tests, hashMs, discoverMs };
}

if (import.meta.main) {
  const [projectDir, testDir, ...symbols] = process.argv.slice(2);
  if (projectDir === undefined || testDir === undefined) {
    console.error("usage: bun scripts/probe-verify-prepare.ts <projectDir> <testDir> [symbol...]");
    process.exit(2);
  }
  console.log(JSON.stringify(await probe(projectDir, testDir, symbols), null, 2));
}
