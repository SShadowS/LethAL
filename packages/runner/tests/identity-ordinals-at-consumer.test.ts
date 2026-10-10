import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import {
  dedupeSpecs,
  identityEntriesOf,
  identitySiteKey,
  numberIdentityOrdinals,
} from "@lethal/schemata";
import type { CompiledArtifact } from "../src/artifact";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import { generateMutationSet, operatorTiers, runSession } from "../src/orchestrator";
import type { SessionReport } from "../src/report";
import { ResultsStore } from "../src/store";
import { removeScratchDir } from "./helpers/scratch";

/**
 * R400: identity ordinals are numbered where they are consumed (`runSession`, through
 * `identityOrdinalsOf`), not across `generateMutationSet`'s file loop, which held one entry per
 * mutant until its end (749,855 on BaseApp). Two things are pinned here:
 *  1. the set holds identity entries for REFUSED files only (the reservation), none for a deployed
 *     file, so nothing per-mutant outlives the loop;
 *  2. the ordinals `runSession` writes equal a direct `numberIdentityOrdinals` over the same
 *     sites, with and without a refused file whose sites must be reserved.
 */

/** A table and a codeunit both named "Twin": the tuple reads the object NAME, so the three
 *  `X := X + 1;` statements are one identity tuple (run-wide-ordinals.test.ts). */
const TABLE_AL = `table 50100 "Twin"
{
    fields
    {
        field(1; Id; Integer) { }
    }

    procedure Bump(): Integer
    var
        X: Integer;
    begin
        X := X + 1;
        exit(X);
    end;
}
`;
/** The same table plus an enum, appended so the table's offsets do not move: refused (object-mix). */
const TABLE_WITH_ENUM_AL = `${TABLE_AL}
enum 50101 "Twin Kind"
{
    value(0; Zero) { }
}
`;
const CODEUNIT_AL = `codeunit 50100 "Twin"
{
    procedure Bump(): Integer
    var
        X: Integer;
    begin
        X := X + 1;
        X := X + 1;
        exit(X);
    end;
}
`;
const TEST_AL = `codeunit 50200 "Twin Tests"
{
    Subtype = Test;

    [Test]
    procedure BumpWorks()
    begin
    end;
}
`;
const APP_JSON = JSON.stringify({
  id: "4a7d1c52-8b8e-4f0e-9f41-3c6b2d1e5a70",
  name: "Twin Fixture",
  publisher: "LethAL",
  version: "1.0.0.0",
  idRanges: [{ from: 50000, to: 50299 }],
});
const TABLE_FILE = "A_Twin.Table.al";
const CODEUNIT_FILE = "B_Twin.Codeunit.al";
const selectorIds = { selectorId: 50290, controlId: 50291, tableId: 50292 };

/** Every test passes and covers nothing, so every mutant is reported, unexecuted. */
class NoCoverageBackend implements ExecutionBackend {
  capabilities(): BackendCapabilities {
    return { coverage: "procedure", deploy: "publish", isolation: "session", authoritative: true };
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "stub" };
  }
  async deploy(): Promise<CompiledArtifact | null> {
    return null;
  }
  async compileCheck(): Promise<void> {}
  async activate(): Promise<void> {}
  async run(ref: TestMethodRef): Promise<TestVerdict> {
    return {
      ref,
      outcome: "pass",
      durationMs: 5,
      coverage: { granularity: "procedure", entries: [] },
    };
  }
}

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) removeScratchDir(r);
});
beforeAll(async () => {
  await initParser();
});

async function project(table: string) {
  const root = await mkdtemp(join(tmpdir(), "lethal-r400-"));
  roots.push(root);
  const projectDir = join(root, "app");
  const testDir = join(root, "tests");
  await Bun.write(join(projectDir, TABLE_FILE), table);
  await Bun.write(join(projectDir, CODEUNIT_FILE), CODEUNIT_AL);
  await Bun.write(join(projectDir, "app.json"), APP_JSON);
  await Bun.write(join(testDir, "TwinTests.Codeunit.al"), TEST_AL);
  return { projectDir, testDir, instrumentedDir: join(root, "instr") };
}

/** The numbering done by hand: every deployed file's entries, through `numberIdentityOrdinals`. */
async function directOrdinals(projectDir: string): Promise<Map<string, number>> {
  const set = await generateMutationSet(projectDir, { emit: () => {} });
  const tierOf = (name: string) => operatorTiers.get(name);
  return numberIdentityOrdinals(
    set.files.flatMap((f) => identityEntriesOf(f.path, f.source, dedupeSpecs(f.specs, tierOf))),
  );
}

/** `<site key> -> ordinal` of every mutant `runSession` reported. */
async function sessionOrdinals(dirs: Awaited<ReturnType<typeof project>>) {
  const report: SessionReport = await runSession({
    backend: new NoCoverageBackend(),
    store: new ResultsStore(":memory:"),
    ...dirs,
    selectorIds,
  });
  return report.mutants.map((m) => ({
    file: m.file,
    key: identitySiteKey(m.file, m.startIndex, m.endIndex, m.operatorName),
    ordinal: m.identityOrdinal ?? 0,
  }));
}

describe("R400: generateMutationSet holds identity entries for refused files only", () => {
  test("no refusal: no entry; an object-mix refusal: exactly the refused file's sites", async () => {
    const clean = await generateMutationSet((await project(TABLE_AL)).projectDir, {
      emit: () => {},
    });
    expect(clean.files.length).toBe(2);
    expect(clean.reservedIdentityEntries).toEqual([]);
    expect("identityOrdinals" in clean).toBe(false);

    const refused = await generateMutationSet((await project(TABLE_WITH_ENUM_AL)).projectDir, {
      emit: () => {},
    });
    expect(refused.refusedFiles.map((r) => [r.file, r.shape])).toEqual([
      [TABLE_FILE, "object-mix"],
    ]);
    expect([...new Set(refused.reservedIdentityEntries.map((e) => e.file))]).toEqual([TABLE_FILE]);
    expect(refused.reservedIdentityEntries.length).toBe(refused.refusedFiles[0]?.sites ?? -1);
  });
});

describe("R400: runSession's ordinals equal a direct numberIdentityOrdinals", () => {
  test("same project, no refusal", async () => {
    const dirs = await project(TABLE_AL);
    const direct = await directOrdinals(dirs.projectDir);
    const rows = await sessionOrdinals(dirs);
    expect(rows.length).toBe(direct.size);
    expect(rows.filter((r) => r.ordinal > 0).length).toBeGreaterThan(0); // twins exist
    expect(rows.filter((r) => direct.get(r.key) !== r.ordinal)).toEqual([]);
  });

  test("a refused table: the codeunit keeps the ordinals the unrefused project numbers", async () => {
    // The unrefused project numbers the table's sites first; the refused run must reserve them,
    // so every codeunit mutant keeps the same ordinal. The enum is appended, so offsets agree.
    const direct = await directOrdinals((await project(TABLE_AL)).projectDir);
    const rows = await sessionOrdinals(await project(TABLE_WITH_ENUM_AL));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.file === CODEUNIT_FILE)).toBe(true);
    expect(rows.filter((r) => r.ordinal > 0).length).toBeGreaterThan(0);
    expect(
      rows
        .filter((r) => direct.get(r.key) !== r.ordinal)
        .map((r) => `${r.key}: ${r.ordinal} vs ${direct.get(r.key)}`),
    ).toEqual([]);
  });
});
