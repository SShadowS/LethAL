// R-595: list sandbox-app's gaps as the schemata emits them TODAY, one line per gap: its id and its
// member identity keys (`astHash|codeunit|procedure|operator|ordinal`, the form verify.itest.ts
// pins). Used to map the gate's pre-R276 gap ids to their current ids by member set.
//
//   bun scripts/r595-gap-map.ts [fixture]      (default: sandbox-app)
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateMutationSet,
  identityOrdinalsOf,
  operatorTiers,
} from "../packages/runner/src/orchestrator";
import { writeInstrumentedProject } from "../packages/schemata/src/index";

type Entry = {
  astHash: string;
  codeunitName: string;
  procedureName: string;
  triggerName?: string;
  operatorName: string;
  identityOrdinal?: number;
  gapId?: string;
};

const fixture = process.argv[2] ?? "sandbox-app";
const fixtureDir = join(import.meta.dir, "..", "fixtures", fixture);
const targetDir = await mkdtemp(join(tmpdir(), "lethal-r595-"));
try {
  const set = await generateMutationSet(fixtureDir);
  await writeInstrumentedProject({
    targetDir,
    files: set.files,
    identityOrdinals: identityOrdinalsOf(set),
    selectorIds: { selectorId: 50100, controlId: 50101, tableId: 50102 },
    artifactId: "0123456789abcdef0123456789abcdef",
    targetAppId: "00000000-0000-0000-0000-000000000000",
    operatorTiers,
  });
  const manifest = JSON.parse(await readFile(join(targetDir, "mutant-manifest.json"), "utf8")) as
    | { mutants?: Entry[] }
    | Entry[];
  const entries: Entry[] = Array.isArray(manifest) ? manifest : (manifest.mutants ?? []);
  if (entries.length === 0) throw new Error(`${fixture}: the manifest has no mutants`);
  const gaps = new Map<string, string[]>();
  for (const m of entries) {
    if (m.gapId === undefined) continue;
    const key = [
      m.astHash,
      m.codeunitName,
      m.procedureName || m.triggerName || "",
      m.operatorName,
      m.identityOrdinal ?? 0,
    ].join("|");
    gaps.set(m.gapId, [...(gaps.get(m.gapId) ?? []), key]);
  }
  for (const [id, keys] of [...gaps].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(JSON.stringify({ gapId: id, keys: keys.sort() }));
  }
} finally {
  await rm(targetDir, { recursive: true, force: true });
}
