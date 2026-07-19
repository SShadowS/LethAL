#!/usr/bin/env bun
/**
 * Reports instrumented-source growth for the sandbox fixture. Not env-gated —
 * it needs no server, only the schemata compiler (this is the growth claim
 * design.md §3/§11 asks Layer 4.3 to substantiate: flat dispatch should make
 * emitted-source growth linear in mutant count rather than exponential in
 * nesting depth). Run: bun run itest:growth
 *
 * NOT a `bun:test` file — `.itest.ts` is never picked up by `bun test` (see
 * `al-runner.itest.ts`/`bcdev.itest.ts`, same convention).
 */
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeInstrumentedProject } from "@lethal/schemata";
import { generateMutationSet } from "../src/orchestrator";

const PROJECT = join(import.meta.dir, "..", "..", "..", "fixtures", "sandbox-app");
const files = await generateMutationSet(PROJECT);
const originalBytes = files.reduce((n, f) => n + f.source.length, 0);
const mutantCount = files.reduce((n, f) => n + f.specs.length, 0);

const dir = await mkdtemp(join(tmpdir(), "lethal-growth-"));
try {
  await writeInstrumentedProject({
    targetDir: dir,
    files,
    selectorIds: { selectorId: 79199, controlId: 79198, tableId: 79197 },
  });

  let emitted = 0;
  for (const entry of await readdir(dir)) {
    if (!entry.endsWith(".al")) continue;
    emitted += (await stat(join(dir, entry))).size;
  }

  const ratio = emitted / originalBytes;
  console.log(`mutants:          ${mutantCount}`);
  console.log(`original source:  ${originalBytes} bytes`);
  console.log(`instrumented:     ${emitted} bytes`);
  console.log(
    `growth:           ${ratio.toFixed(2)}x  (${(emitted / mutantCount).toFixed(0)} bytes/mutant)`,
  );
  console.log(
    ratio < mutantCount
      ? "LINEAR-ish: growth is below one full copy per mutant"
      : "WARNING: growth exceeds one copy per mutant — investigate",
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
