import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeInstrumentedProject } from "@lethal/schemata";
import { PINNED_GAPS } from "../itest/verify-gaps";
import { generateMutationSet, identityOrdinalsOf, operatorTiers } from "../src/orchestrator";
import { removeScratchDir } from "./helpers/scratch";

/**
 * R-595: `itest:verify` pins five gap ids (`verify-gaps.ts`). R276 changed `gapIdOf` and the pins
 * went stale for two weeks, because only the live gate read them. This test emits sandbox-app's
 * manifest the way `fixture-emission.test.ts` does (that path calls `gapIdOf`) and checks every
 * pinned gap: its id exists and its members are exactly the pinned ones, compared by identity key
 * without the ordinal (every pinned key has ordinal 1, the manifest leaves it unset).
 */
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) removeScratchDir(d);
});

type Entry = {
  astHash: string;
  codeunitName: string;
  procedureName: string;
  triggerName?: string;
  operatorName: string;
  gapId?: string;
};

test("itest:verify's pinned gap ids and members match sandbox-app's emitted manifest", async () => {
  const fixtureDir = join(import.meta.dir, "../../../fixtures/sandbox-app");
  const targetDir = await mkdtemp(join(tmpdir(), "lethal-gap-pins-"));
  dirs.push(targetDir);
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
  const raw = JSON.parse(await readFile(join(targetDir, "mutant-manifest.json"), "utf8")) as
    | Entry[]
    | { mutants: Entry[] };
  const entries = Array.isArray(raw) ? raw : raw.mutants;
  expect(entries.length).toBeGreaterThan(0);

  const members = new Map<string, string[]>();
  for (const m of entries) {
    if (m.gapId === undefined) continue;
    const key = [m.astHash, m.codeunitName, m.procedureName || m.triggerName || "", m.operatorName];
    members.set(m.gapId, [...(members.get(m.gapId) ?? []), key.join("|")]);
  }
  const withoutOrdinal = (k: string) => k.replace(/\|\d+$/, "");
  for (const gap of PINNED_GAPS) {
    expect(
      { name: gap.name, keys: (members.get(gap.gapId) ?? []).sort() },
      `${gap.name}: no gap ${gap.gapId} with these members (re-derive with scripts/r595-gap-map.ts)`,
    ).toEqual({ name: gap.name, keys: gap.keys.map(withoutOrdinal).sort() });
  }
}, 60_000);
