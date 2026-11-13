import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import type { MutantManifest, MutantManifestEntry } from "@lethal/schemata";
import { writeInstrumentedProject } from "@lethal/schemata";
import { alRunnerCoverageFromServer, buildAlRunnerCoverageIndex } from "../src/al-runner-coverage";
import type { CoverageMap, TestMethodRef } from "../src/backend";
import { generateMutationSet, identityOrdinalsOf, operatorTiers } from "../src/orchestrator";
import { buildCoverageIndex, coverageFilter } from "../src/selection";

// R965: al-runner's per-test coverage keeps overloads apart by line, but selection keyed members by
// name alone, so a test that ran one overload "covered" every same-named overload's mutants.
// Hand-written repro, no corpus text.

const APP_JSON = {
  id: "00000000-0000-0000-0000-000000000965",
  name: "r965",
  publisher: "repro",
  version: "1.0.0.0",
  runtime: "16.0",
  idRanges: [{ from: 50100, to: 50149 }],
};

const SRC = `codeunit 50100 "Overloads"
{
    procedure Greet(Name: Text): Integer
    begin
        exit(StrLen(Name) + 1);
    end;

    procedure Greet(Count: Integer): Integer
    begin
        Count := Count + 2;
        exit(Count + 3);
    end;

    procedure Plain(X: Integer): Integer
    begin
        exit(X + 5);
    end;
}
`;

const tA: TestMethodRef = { codeunitId: 50200, codeunitName: "T", method: "RanFirstGreet" };
const tB: TestMethodRef = { codeunitId: 50200, codeunitName: "T", method: "RanPlain" };

let manifest: MutantManifest;
let emitted: string;

beforeAll(async () => {
  await initParser();
  const src = await mkdtemp(join(tmpdir(), "lethal-r965-src-"));
  const out = await mkdtemp(join(tmpdir(), "lethal-r965-out-"));
  try {
    await writeFile(join(src, "app.json"), JSON.stringify(APP_JSON));
    await writeFile(join(src, "Repro.Codeunit.al"), SRC);
    const set = await generateMutationSet(src, { preprocessorSymbols: [] });
    await writeInstrumentedProject({
      targetDir: out,
      files: set.files,
      identityOrdinals: identityOrdinalsOf(set),
      selectorIds: { selectorId: 50147, controlId: 50148, tableId: 50149 },
      artifactId: "0123456789abcdef0123456789abcdef",
      targetAppId: APP_JSON.id,
      operatorTiers,
    });
    manifest = JSON.parse(
      await readFile(join(out, "mutant-manifest.json"), "utf8"),
    ) as MutantManifest;
    emitted = await readFile(join(out, "Repro.Codeunit.al"), "utf8");
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

const of = (name: string, idx?: number): MutantManifestEntry[] =>
  manifest.mutants.filter(
    (m) => m.procedureName === name && (idx === undefined || m.procedureOverloadIndex === idx),
  );

/** The coverage al-runner would report for a test that ran the statement containing `needle`. */
async function ranStatement(needle: string, scope: string): Promise<CoverageMap> {
  const dir = await mkdtemp(join(tmpdir(), "lethal-r965-cov-"));
  try {
    await writeFile(join(dir, "Repro.Codeunit.al"), emitted);
    const index = await buildAlRunnerCoverageIndex(dir);
    const line = emitted.split("\n").findIndex((l) => l.includes(needle)) + 1;
    expect(line).toBeGreaterThan(0);
    return alRunnerCoverageFromServer(
      {
        test: "Codeunit50200.X",
        coverage: [{ file: "Repro.Codeunit.al", statements: [{ scope, line, hits: 1 }] }],
      },
      index,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const split = (cov: CoverageMap, mutants: readonly MutantManifestEntry[]) =>
  coverageFilter(
    mutants,
    buildCoverageIndex([{ ref: tA, coverage: cov }]),
    [tA, tB],
    undefined,
    true,
    undefined,
    () => {},
  );

describe("R965: the manifest numbers overloads", () => {
  test("each Greet mutant carries its overload's position; Plain carries none", () => {
    expect(of("Greet", 0).length).toBeGreaterThan(0);
    expect(of("Greet", 1).length).toBeGreaterThan(0);
    expect(of("Greet").every((m) => m.procedureOverloadIndex !== undefined)).toBe(true);
    expect(of("Plain").length).toBeGreaterThan(0);
    expect(of("Plain").every((m) => m.procedureOverloadIndex === undefined)).toBe(true);
  });
});

describe("R965: a test that ran one overload covers that overload only", () => {
  test("the first overload's lines: its mutants get the test (exact), the second overload's get none", async () => {
    const cov = await ranStatement("StrLen(Name) + 1", "Greet");
    expect(cov.entries.every((e) => e.overloadIndex === 0)).toBe(true);
    const mutants = [...of("Greet", 0), ...of("Greet", 1)];
    const s = split(cov, mutants);
    for (const m of of("Greet", 0)) {
      expect(s.covered.get(m.mutantId)).toEqual([tA]);
      expect(s.attribution.get(m.mutantId)).toBe("exact");
    }
    for (const m of of("Greet", 1)) {
      expect(s.covered.has(m.mutantId)).toBe(false);
      expect(s.uncovered.map((u) => u.mutantId)).toContain(m.mutantId);
    }
  });

  test("the second overload's lines: the reverse", async () => {
    const cov = await ranStatement("Count + 3", "Greet");
    expect(cov.entries.every((e) => e.overloadIndex === 1)).toBe(true);
    const s = split(cov, [...of("Greet", 0), ...of("Greet", 1)]);
    for (const m of of("Greet", 1)) expect(s.covered.get(m.mutantId)).toEqual([tA]);
    for (const m of of("Greet", 0)) expect(s.covered.has(m.mutantId)).toBe(false);
  });
});

describe("R965: a procedure with a name of its own is unchanged", () => {
  test("Plain: the entry carries no overloadIndex and its mutants take the test, exact", async () => {
    const cov = await ranStatement("X + 5", "Plain");
    expect(cov.entries.every((e) => e.overloadIndex === undefined)).toBe(true);
    const s = split(cov, of("Plain"));
    for (const m of of("Plain")) {
      expect(s.covered.get(m.mutantId)).toEqual([tA]);
      expect(s.attribution.get(m.mutantId)).toBe("exact");
    }
  });
});

describe("R965: coverage that cannot say which overload ran", () => {
  const nameOnly: CoverageMap = {
    granularity: "procedure",
    entries: [
      { objectType: "Codeunit", objectId: 50100, procedure: "Greet" },
      { objectType: "Codeunit", objectId: 50100, procedure: "Plain" },
    ],
  };

  test("an overloaded name with no overloadIndex gives no exact claim for either overload", () => {
    const s = split(nameOnly, [...of("Greet", 0), ...of("Greet", 1)]);
    expect(s.covered.size).toBe(0);
    expect(s.uncovered.length).toBe(of("Greet").length);
  });

  test("a non-overloaded name with no line is exact, as before", () => {
    const s = split(nameOnly, of("Plain"));
    for (const m of of("Plain")) {
      expect(s.covered.get(m.mutantId)).toEqual([tA]);
      expect(s.attribution.get(m.mutantId)).toBe("exact");
    }
  });
});
