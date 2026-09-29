import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import {
  IDENTITY_SCHEME,
  type MutantManifest,
  type MutantManifestEntry,
  writeInstrumentedProject,
} from "@lethal/schemata";
import { EQUIVALENCE_MARKS_FILENAME, loadEquivalenceMarks } from "../src/equivalence-marks";
import type { RunEvent, RunEventInput } from "../src/events";
import { generateMutationSet, operatorTiers } from "../src/orchestrator";
import { buildReport } from "../src/report";
import type { SessionReport } from "../src/report";
import { identityKeyOf, serializeKey } from "../src/selection";

/**
 * A reader mark round-trips through the REAL path: a small AL project is mutated by the real
 * operator set and writer, the mark's key is built from the resulting manifest entry the way
 * `EquivalenceMark.key` documents, written to `lethal.equivalent.json`, loaded and parsed from
 * disk, and matched by `buildReport`. A hand-built manifest entry could agree with a hand-built key
 * while real mutants did not, so nothing here is hand-built except the AL.
 */

const APP_JSON = {
  id: "00000000-0000-0000-0000-000000000230",
  name: "marks",
  publisher: "marks",
  version: "1.0.0.0",
  runtime: "16.0",
  idRanges: [{ from: 50100, to: 50149 }],
};

const roots: string[] = [];
beforeAll(async () => {
  await initParser();
});
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

/** Mutates `files` as one project; returns the project dir and the manifest's entries. */
async function mutate(
  files: Record<string, string>,
): Promise<{ projectDir: string; entries: readonly MutantManifestEntry[] }> {
  const root = await mkdtemp(join(tmpdir(), "lethal-marks-report-"));
  roots.push(root);
  const projectDir = join(root, "app");
  const out = join(root, "instr");
  await Bun.write(join(projectDir, "app.json"), JSON.stringify(APP_JSON));
  for (const [name, text] of Object.entries(files)) await Bun.write(join(projectDir, name), text);
  const set = await generateMutationSet(projectDir);
  await writeInstrumentedProject({
    targetDir: out,
    files: set.files,
    selectorIds: { selectorId: 50147, controlId: 50148, tableId: 50149 },
    artifactId: "0123456789abcdef0123456789abcdef",
    targetAppId: APP_JSON.id,
    operatorTiers,
  });
  const manifest = JSON.parse(
    await readFile(join(out, "mutant-manifest.json"), "utf8"),
  ) as MutantManifest;
  return { projectDir, entries: manifest.mutants };
}

/** Writes one mark for `key`, loads it from disk, and builds the report with every entry survived. */
async function reportWithMark(
  projectDir: string,
  entries: readonly MutantManifestEntry[],
  key: string,
): Promise<SessionReport> {
  await writeFile(
    join(projectDir, EQUIVALENCE_MARKS_FILENAME),
    JSON.stringify({ identityScheme: IDENTITY_SCHEME, marks: [{ key, reason: "reader ruling" }] }),
  );
  const marks = await loadEquivalenceMarks(projectDir);
  if (marks === undefined) throw new Error("the marks file was not found");
  const events: RunEventInput[] = [
    {
      type: "mutation-set-generated",
      siteCount: entries.length,
      deployedCount: entries.length,
      hangCapableCount: 0,
      totalFiles: 1,
      instrumentableFiles: 1,
      notInstrumentedFiles: [],
      declarativeSiteFiles: [],
      excludedByOnly: 0,
      excludedByExclude: 0,
      excludedByOperator: 0,
    },
    { type: "baseline-batch-finished", batchIndex: 0, verdicts: [] },
    ...entries.map(
      (m): RunEventInput => ({
        type: "mutant-scored",
        mutant: m,
        verdict: "survived",
        batchIndex: 0,
        durationMs: 10,
        coveringTests: [],
      }),
    ),
    { type: "session-finished", elapsedMs: 100 },
  ];
  return buildReport(
    {
      caps: { authoritative: true, coverage: "none", deploy: "publish", isolation: "session" },
      equivalenceMarks: marks,
    },
    events.map((e, i) => ({ ...e, seq: i + 1 }) as RunEvent),
  );
}

describe("R230: a twin after the first can be reader-marked, through the real report path", () => {
  const TWINS = `codeunit 50100 "Twin Ops"
{
    procedure Bump(var X: Integer)
    begin
        X := X + 1;
        X := X + 1;
    end;
}
`;

  test("the ordinal-1 twin's six-field key loads, matches that twin, and not the first", async () => {
    const { projectDir, entries } = await mutate({ "TwinOps.Codeunit.al": TWINS });
    const twins = entries.filter((m) => m.operatorName === "lethal.remove-assignment");
    expect(twins.map((m) => m.identityOrdinal ?? 0)).toEqual([0, 1]);
    const [first, second] = twins;
    if (first === undefined || second === undefined) throw new Error("unreachable");
    // The twins differ in nothing but the ordinal, which is what R193's sixth field is for.
    expect(serializeKey({ ...identityKeyOf(second), ordinal: 0 })).toBe(
      serializeKey(identityKeyOf(first)),
    );

    const key = serializeKey(identityKeyOf(second));
    expect(key.split("|")).toHaveLength(6);
    expect(key.endsWith("|1")).toBe(true);

    const report = await reportWithMark(projectDir, entries, key);
    expect(report.readerMarkedEquivalent).toEqual({
      matched: [{ mutantCode: second.mutantId, key, reason: "reader ruling" }],
      stale: [],
      contradicted: [],
    });
    const marked = report.mutants.filter((m) => m.readerMark !== undefined);
    expect(marked.map((m) => m.mutantCode)).toEqual([second.mutantId]);
    expect(marked[0]?.identityOrdinal).toBe(1);
  });
});
