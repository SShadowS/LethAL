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
import { basename, join } from "node:path";
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

  // The Mutation* files (Selector/Control/Active) are fixed scaffolding —
  // written once per artifact, byte-identical no matter how many mutants the
  // artifact holds. Counting them as "growth" inflated the headline (they
  // were 31% of the reported instrumented bytes) and, worse, would dominate
  // and distort any future cross-fixture growth CURVE, which is the whole
  // point of measuring bytes-per-mutant. Report them as their own line.
  let instrumentedSource = 0;
  let fixedScaffolding = 0;
  for (const entry of await readdir(dir)) {
    if (!entry.endsWith(".al")) continue;
    const size = (await stat(join(dir, entry))).size;
    if (basename(entry).startsWith("Mutation")) fixedScaffolding += size;
    else instrumentedSource += size;
  }

  const sourceRatio = instrumentedSource / originalBytes;
  const totalRatio = (instrumentedSource + fixedScaffolding) / originalBytes;
  const marginalPerMutant = (instrumentedSource - originalBytes) / mutantCount;
  console.log(`mutants:              ${mutantCount}`);
  console.log(`original source:      ${originalBytes} bytes`);
  console.log(`instrumented source:  ${instrumentedSource} bytes`);
  console.log(
    `fixed scaffolding:    ${fixedScaffolding} bytes (Mutation* files — constant per artifact, excluded from growth)`,
  );
  console.log(
    `total emitted:        ${instrumentedSource + fixedScaffolding} bytes (${totalRatio.toFixed(2)}x incl. scaffolding)`,
  );
  console.log(
    `source growth:        ${sourceRatio.toFixed(2)}x  (~${marginalPerMutant.toFixed(0)} marginal bytes/mutant)`,
  );
  console.log(
    sourceRatio < mutantCount
      ? "LINEAR-ish: source growth is below one full copy per mutant"
      : "WARNING: source growth exceeds one copy per mutant — investigate",
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
