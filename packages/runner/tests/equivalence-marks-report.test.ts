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
import {
  EQUIVALENCE_MARKS_FILENAME,
  type EquivalenceMark,
  loadEquivalenceMarks,
  parseEquivalenceMarks,
} from "../src/equivalence-marks";
import type { RunEvent, RunEventInput } from "../src/events";
import { explain } from "../src/explain";
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
  return survivedReport(entries, marks);
}

/** Builds the report with every entry survived, through the real `buildReport`. */
function survivedReport(
  entries: readonly MutantManifestEntry[],
  marks?: readonly EquivalenceMark[],
): SessionReport {
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
      preprocExcludedFiles: [],
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
        // R265: `lethal explain` refuses a survivor without one.
        coverageAttribution: "all-green",
      }),
    ),
    { type: "session-finished", elapsedMs: 100 },
  ];
  return buildReport(
    {
      caps: { authoritative: true, coverage: "none", deploy: "publish", isolation: "session" },
      ...(marks !== undefined ? { equivalenceMarks: marks } : {}),
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
      matched: [{ batchIndex: 0, mutantCode: second.mutantId, key, reason: "reader ruling" }],
      stale: [],
      contradicted: [],
    });
    const marked = report.mutants.filter((m) => m.readerMark !== undefined);
    expect(marked.map((m) => m.mutantCode)).toEqual([second.mutantId]);
    expect(marked[0]?.identityOrdinal).toBe(1);
  });
});

describe("R229: a trigger mutant can be reader-marked, through the real report path", () => {
  const TABLE = `table 50101 "Trig Tab"
{
    fields
    {
        field(1; Code; Code[20]) { }
        field(2; Amount; Integer) { }
    }

    trigger OnInsert()
    begin
        Amount := 10;
    end;
}
`;

  test("a mark on an OnInsert mutant matches it and is not stale", async () => {
    const { projectDir, entries } = await mutate({ "TrigTab.Table.al": TABLE });
    const target = entries.find(
      (m) => m.triggerName === "OnInsert" && m.operatorName === "lethal.remove-assignment",
    );
    if (target === undefined) throw new Error("the fixture must produce an OnInsert mutant");
    // The shape R229 is about: the member is named by `triggerName`, and `procedureName` is "".
    expect(target.procedureName).toBe("");

    const key = serializeKey(identityKeyOf(target));
    expect(key.split("|")[2]).toBe("OnInsert");
    const report = await reportWithMark(projectDir, entries, key);
    // The agent reference builds the key from the report row, taking `triggerName` when
    // `procedureName` is empty; that spelling is the same key.
    const row = report.mutants.find((m) => m.mutantCode === target.mutantId);
    if (row === undefined) throw new Error("buildReport dropped the mutant");
    expect(
      [
        row.astHash,
        row.codeunitName,
        row.procedureName || row.triggerName,
        row.operatorName,
        row.operatorMajor,
      ].join("|"),
    ).toBe(key);

    expect(report.readerMarkedEquivalent).toEqual({
      matched: [{ batchIndex: 0, mutantCode: target.mutantId, key, reason: "reader ruling" }],
      stale: [],
      contradicted: [],
    });
    expect(row.readerMark).toEqual({ key, reason: "reader ruling" });
  });
});

/**
 * R265: the key a reader copies from `lethal explain` is the key the mark join matches. Each case
 * builds a report with no mark, explains it, writes the survivor's `markKey` at explain's
 * `markIdentityScheme`, and builds the report again. Only THAT mutant may come back reader-marked.
 */
describe("R265: explain's markKey, written as a mark, marks that mutant and only it", () => {
  async function roundTrip(
    projectDir: string,
    entries: readonly MutantManifestEntry[],
    target: MutantManifestEntry,
  ): Promise<string> {
    const out = explain(survivedReport(entries));
    // A report this build wrote is under this build's scheme, so the keys are not stale.
    expect(out.markIdentityScheme).toBe(IDENTITY_SCHEME);
    expect(out.markKeysStale).toBeUndefined();
    const survivor = out.survivors.find((s) => s.mutantCode === target.mutantId);
    if (survivor === undefined) throw new Error(`explain has no survivor ${target.mutantId}`);
    const key = survivor.markKey;
    const file = JSON.stringify({
      identityScheme: out.markIdentityScheme,
      marks: [{ key, reason: "reader ruling" }],
    });
    expect(parseEquivalenceMarks(file, EQUIVALENCE_MARKS_FILENAME)).toEqual([
      { key, reason: "reader ruling", identityScheme: out.markIdentityScheme },
    ]);
    await writeFile(join(projectDir, EQUIVALENCE_MARKS_FILENAME), file);
    const marks = await loadEquivalenceMarks(projectDir);
    if (marks === undefined) throw new Error("the marks file was not found");
    const report = survivedReport(entries, marks);
    expect(report.readerMarkedEquivalent).toEqual({
      matched: [{ batchIndex: 0, mutantCode: target.mutantId, key, reason: "reader ruling" }],
      stale: [],
      contradicted: [],
    });
    expect(
      report.mutants.filter((m) => m.readerMark !== undefined).map((m) => m.mutantCode),
    ).toEqual([target.mutantId]);
    return key;
  }

  test("(a) a plain procedure mutant", async () => {
    const { projectDir, entries } = await mutate({
      "PlainOps.Codeunit.al": `codeunit 50102 "Plain Ops"
{
    procedure Double(var X: Integer)
    begin
        X := X * 2;
    end;
}
`,
    });
    const target = entries.find(
      (m) => m.procedureName === "Double" && m.operatorName === "lethal.remove-assignment",
    );
    if (target === undefined) throw new Error("the fixture must produce a Double mutant");
    expect(target.identityOrdinal ?? 0).toBe(0);
    expect(entries.length).toBeGreaterThan(1);
    const key = await roundTrip(projectDir, entries, target);
    expect(key.split("|")).toHaveLength(5);
  });

  test("(b) the ordinal-1 twin, whose key carries the ordinal", async () => {
    const { projectDir, entries } = await mutate({
      "TwinOps.Codeunit.al": `codeunit 50100 "Twin Ops"
{
    procedure Bump(var X: Integer)
    begin
        X := X + 1;
        X := X + 1;
    end;
}
`,
    });
    const twins = entries.filter((m) => m.operatorName === "lethal.remove-assignment");
    expect(twins.map((m) => m.identityOrdinal ?? 0)).toEqual([0, 1]);
    const [, second] = twins;
    if (second === undefined) throw new Error("unreachable");
    const key = await roundTrip(projectDir, entries, second);
    expect(key.endsWith("|1")).toBe(true);
  });

  test("(c) a table-trigger mutant, whose key names the trigger", async () => {
    const { projectDir, entries } = await mutate({
      "TrigTab.Table.al": `table 50101 "Trig Tab"
{
    fields
    {
        field(1; Code; Code[20]) { }
        field(2; Amount; Integer) { }
    }

    trigger OnInsert()
    begin
        Amount := 10;
    end;
}
`,
    });
    const target = entries.find(
      (m) => m.triggerName === "OnInsert" && m.operatorName === "lethal.remove-assignment",
    );
    if (target === undefined) throw new Error("the fixture must produce an OnInsert mutant");
    expect(target.procedureName).toBe("");
    const key = await roundTrip(projectDir, entries, target);
    expect(key.split("|")[2]).toBe("OnInsert");
  });
});
