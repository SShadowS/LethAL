// R-326: today's equivalent of RUST-03's "W8": whole-project generation, then the instrumented-project
// writer, with memory read at three phase markers (start, generated, written).
// usage: bun scripts/r326-w8-memory.ts <project-dir> <out.json>
//
// At each marker: a full GC (`Bun.gc(true)`), then process.memoryUsage(), bun:jsc heapStats(),
// VmRSS and VmHWM from /proc/self/status, and wall seconds since start.
// Timers cannot run while the writer works, so its PEAK is read from outside: the script prints
//   MARK <name> <unix-ms>      (stderr; names: gen-start gen-end write-start write-end)
// at each phase edge, so a driver polling /proc/<pid>/status can split its RSS timeline by phase.
// MARK lines are printed BEFORE the marker's GC (gen-end, write-end) or AFTER it (gen-start, write-start),
// so the GC never sits inside a phase.
//
// Stand-ins for what only a live run has (the writer needs no BC server, test app or publish):
//   - selectorIds: the CLI defaults 79199 / 79198 / 79197 (cli.ts DEFAULT_SELECTOR_IDS, not exported).
//   - artifactId: a fixed 32-hex string (a real run mints a random one).
//   - targetAppId: the project's own app.json `id`, as orchestrator's targetAppIdOf reads it.
//   - flatNames: batchFlatNames(projectDir) with no generation snapshot (a real run may pass one).
// out.json holds the markers and counts only: no source text, no tuple text.
import { heapStats } from "bun:jsc";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  batchFlatNames,
  generateMutationSet,
  identityOrdinalsOf,
  operatorTiers,
  targetAppIdOf,
} from "../packages/runner/src/orchestrator";
import { writeInstrumentedProject } from "../packages/schemata/src/project";

const [projectDir, out] = process.argv.slice(2);
if (projectDir === undefined || out === undefined) {
  throw new Error("usage: bun scripts/r326-w8-memory.ts <project-dir> <out.json>");
}

const t0 = Date.now();
const mark = (name: string): void => {
  process.stderr.write(`MARK ${name} ${Date.now()}\n`);
};

async function status(): Promise<{ vmRssKb: number; vmHwmKb: number }> {
  const text = await readFile("/proc/self/status", "utf8");
  const kb = (key: string): number => Number(new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(text)?.[1]);
  return { vmRssKb: kb("VmRSS"), vmHwmKb: kb("VmHWM") };
}

async function snapshot(name: string) {
  Bun.gc(true);
  const m = process.memoryUsage();
  const h = heapStats();
  return {
    name,
    wallSeconds: (Date.now() - t0) / 1000,
    rss: m.rss,
    heapUsed: m.heapUsed,
    external: m.external,
    heapSize: h.heapSize,
    heapCapacity: h.heapCapacity,
    extraMemorySize: h.extraMemorySize,
    objectCount: h.objectCount,
    ...(await status()),
  };
}

const markers = [await snapshot("start")];

mark("gen-start");
const set = await generateMutationSet(projectDir, { emit: () => {} });
mark("gen-end");
markers.push(await snapshot("generated"));

const raw = await readFile(join(projectDir, "app.json"), "utf8");
const manifest: Record<string, unknown> = JSON.parse(raw.replace(/^﻿/, ""));
const targetDir = await mkdtemp(join(tmpdir(), "r326-w8-"));
let manifestRows = 0;
try {
  const identityOrdinals = identityOrdinalsOf(set);
  const flatNames = await batchFlatNames(projectDir);
  mark("write-start");
  await writeInstrumentedProject({
    targetDir,
    files: set.files,
    selectorIds: { selectorId: 79199, controlId: 79198, tableId: 79197 },
    artifactId: "0123456789abcdef0123456789abcdef",
    targetAppId: targetAppIdOf(manifest),
    operatorTiers,
    identityOrdinals,
    flatNames,
  });
  mark("write-end");
  markers.push(await snapshot("written"));
  const written = JSON.parse(await readFile(join(targetDir, "mutant-manifest.json"), "utf8"));
  manifestRows = written.mutants.length;
} finally {
  await rm(targetDir, { recursive: true, force: true });
}

const specs = set.files.reduce((n, f) => n + f.specs.length, 0);
await Bun.write(
  out,
  JSON.stringify({ markers, counts: { files: set.files.length, specs, manifestRows } }, null, 2),
);
