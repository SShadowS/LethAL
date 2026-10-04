import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDENTITY_SCHEME, type MutantManifest, type MutantManifestEntry } from "@lethal/schemata";
import { Glob } from "bun";
import { normalizeForComparison } from "../itest/mutant-equality";
import { hashTargetSource } from "../src/baseline-snapshot";
import { CAMPAIGN_COMPARE_SCHEMA_VERSION, compareCampaignStage } from "../src/campaign-subcommands";
import {
  DOCTOR_AL_RUNNER_ONLY_CAVEAT,
  DOCTOR_CAVEAT_KINDS,
  DOCTOR_CREATE_MODE_CAVEAT,
  DOCTOR_NOT_CHECKED_TOKENS,
  DOCTOR_SCHEMA_VERSION,
  doctorJson,
} from "../src/cli";
import { STREAM_SCHEMA_VERSION } from "../src/events";
import {
  ARTIFACT_ID_ABSENCES,
  EXPLAIN_ATTRIBUTION_INTERPRETATIONS,
  EXPLAIN_SCHEMA_VERSION,
  REACH_GRAINS,
  SURVIVOR_RANKINGS,
  TOOL_CONDITIONS,
} from "../src/explain";
import { assertExplainableReport, explain } from "../src/explain";
import {
  CAVEAT_INTERPRETATIONS,
  ERROR_CAUSE_INTERPRETATIONS,
  GUARD_EVIDENCE_INTERPRETATIONS,
  REACH_INTERPRETATIONS,
  REPORT_SCHEMA_VERSION,
} from "../src/report";
import { identityKeyOf, serializeKey } from "../src/selection";
import { ResultsStore } from "../src/store";
import {
  KILLED_BY,
  NEW_TEST_STATES,
  UNMUTATED_OUTCOMES,
  VERIFY_REFUSALS,
  VERIFY_SCHEMA_VERSION,
  VERIFY_VERDICTS,
  type VerifyDeps,
  type VerifyOutput,
  runVerify,
} from "../src/verify";
import { REACH_FILTER_OFF_REASONS, REACH_FILTER_STATES } from "../src/verify-reach";
import { bundleFor } from "./helpers/bundle";
import { makeGitRepo } from "./helpers/git-repo";
import { typeLeafPaths } from "./helpers/type-leaf-paths";

/**
 * R152. LethAL versions four machine surfaces and, until now, published a schema for none of them:
 * a consumer outside this repository had a version number and no artifact to check against, so it
 * could not validate a file, could not generate types, and discovered a shape change by crashing on
 * one.
 *
 * The schemas are HAND-WRITTEN, which is the one decision here worth arguing. A generator would make
 * drift impossible by construction, and would also be a new piece of machinery to maintain for two
 * documents. The cheaper guarantee, and the one this repository already uses for
 * `EXPLAIN_LEAF_PATHS`, is to pin the artifact against the DECLARATION: the first test below walks
 * `ExplainOutput` and `DoctorJsonOutput` out of their `.ts` sources and asserts the schema describes
 * exactly those leaves, in both directions. A field added to either type with no schema entry fails,
 * and a schema property with no field fails.
 *
 * That covers SHAPE. Two more things need covering and are, separately:
 *
 *   - VALUE DOMAINS. Every `enum` in a schema is asserted equal to the runtime constant it copies,
 *     so a value added to `Caveat` or `MutantErrorCause` cannot leave the published schema behind.
 *     This is the failure that would silently reject valid documents at a consumer.
 *   - REAL DATA. The projection of a committed campaign report is validated against the schema, so
 *     the schema is checked against output rather than only against a type. Its blind spot is a
 *     field no real report reaches, which is exactly what the declaration walk above covers.
 *
 * `conformsTo` below is a deliberately small validator: type, const, enum, required, properties,
 * additionalProperties, items, minItems and local `$ref`. It is not a JSON Schema implementation and
 * must not grow into one — if a schema here needs a keyword it does not support, that is a signal to
 * add the dependency rather than to keep extending this.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const SRC = join(import.meta.dir, "..", "src");

type Schema = Record<string, unknown>;

function loadSchema(name: string): Schema {
  return JSON.parse(readFileSync(join(REPO_ROOT, "schemas", name), "utf8")) as Schema;
}

/** Resolves a local `#/$defs/x` pointer. Anything else throws: a schema reaching outside this file
 *  would make the leaf walk and the validator quietly incomplete. */
function deref(root: Schema, node: Schema): Schema {
  const ref = node.$ref;
  if (ref === undefined) return node;
  if (typeof ref !== "string" || !ref.startsWith("#/$defs/")) {
    throw new Error(`unsupported $ref ${JSON.stringify(ref)} — only #/$defs/<name> is handled`);
  }
  const defs = root.$defs as Record<string, Schema> | undefined;
  const found = defs?.[ref.slice("#/$defs/".length)];
  if (found === undefined) throw new Error(`$ref ${ref} does not resolve`);
  return found;
}

/**
 * Every leaf path the SCHEMA describes, in the notation `typeLeafPaths` produces: an object property
 * appends `.name`, an array appends `[]`, and a scalar ends the path.
 */
function schemaLeafPaths(root: Schema, node: Schema = root, path = "$"): string[] {
  const resolved = deref(root, node);
  const properties = resolved.properties as Record<string, Schema> | undefined;
  if (properties !== undefined) {
    return Object.entries(properties).flatMap(([key, child]) =>
      schemaLeafPaths(root, child, `${path}.${key}`),
    );
  }
  const items = resolved.items as Schema | undefined;
  if (items !== undefined) return schemaLeafPaths(root, items, `${path}[]`);
  return [path];
}

interface Violation {
  readonly path: string;
  readonly problem: string;
}

/** See this file's doc comment: a small validator, not a JSON Schema implementation. */
function conformsTo(root: Schema, value: unknown, node: Schema = root, path = "$"): Violation[] {
  const schema = deref(root, node);
  const out: Violation[] = [];

  if (schema.const !== undefined && value !== schema.const) {
    out.push({ path, problem: `expected const ${JSON.stringify(schema.const)}` });
  }
  // `anyOf` — the stream's root is a union of event shapes, and a validator that ignored it would
  // return [] for EVERY document against that schema. That is exactly the empty-vs-empty pass this
  // file exists to prevent, and it was a real bug here until the header line failed to fail.
  const anyOf = schema.anyOf as Schema[] | undefined;
  if (anyOf !== undefined) {
    const branches = anyOf.map((branch) => conformsTo(root, value, branch, path));
    if (branches.some((v) => v.length === 0)) return [];
    const best = branches.reduce((a, b) => (a.length <= b.length ? a : b));
    return [
      {
        path,
        problem: `matches no branch of anyOf; closest complaint: ${best[0]?.problem ?? "?"}`,
      },
    ];
  }

  const enumValues = schema.enum as unknown[] | undefined;
  if (enumValues !== undefined && !enumValues.includes(value)) {
    out.push({
      path,
      problem: `${JSON.stringify(value)} is not one of ${JSON.stringify(enumValues)}`,
    });
  }

  const declared = schema.type;
  const allowed = declared === undefined ? [] : Array.isArray(declared) ? declared : [declared];
  const actual =
    value === null
      ? "null"
      : Array.isArray(value)
        ? "array"
        : typeof value === "number"
          ? "number"
          : typeof value;
  const typeOk =
    allowed.length === 0 ||
    allowed.some((t) =>
      t === "integer" ? typeof value === "number" && Number.isInteger(value) : t === actual,
    );
  if (!typeOk) {
    out.push({ path, problem: `expected type ${allowed.join("|")}, got ${actual}` });
    return out;
  }

  if (allowed.includes("array") && Array.isArray(value)) {
    const minItems = schema.minItems;
    if (typeof minItems === "number" && value.length < minItems) {
      out.push({ path, problem: `expected at least ${minItems} item(s), got ${value.length}` });
    }
    const items = schema.items as Schema | undefined;
    if (items !== undefined) {
      value.forEach((entry, i) => out.push(...conformsTo(root, entry, items, `${path}[${i}]`)));
    }
    return out;
  }

  if (allowed.includes("object") && typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (!(key in record)) out.push({ path: `${path}.${key}`, problem: "required but absent" });
    }
    for (const [key, entry] of Object.entries(record)) {
      const child = properties[key];
      if (child === undefined) {
        if (schema.additionalProperties === false) {
          out.push({ path: `${path}.${key}`, problem: "not described by the schema" });
        }
        continue;
      }
      out.push(...conformsTo(root, entry, child, `${path}.${key}`));
    }
  }
  return out;
}

/** Pulls a named enum out of a schema by leaf path, so the assertion names the field rather than an
 *  index into a nested literal. */
function enumAt(root: Schema, path: string): unknown[] {
  const parts = path
    .replace(/^\$\.?/, "")
    .split(/\.|\[\]/)
    .filter(Boolean);
  let node: Schema = root;
  for (const part of parts) {
    node = deref(root, node);
    const items = node.items as Schema | undefined;
    const properties = node.properties as Record<string, Schema> | undefined;
    const next =
      properties?.[part] ?? (items?.properties as Record<string, Schema> | undefined)?.[part];
    if (next === undefined) throw new Error(`no schema node at ${path} (stuck at ${part})`);
    node = next;
  }
  const resolved = deref(root, node);
  const values = (resolved.enum ?? (resolved.items as Schema | undefined)?.enum) as
    | unknown[]
    | undefined;
  if (values === undefined) throw new Error(`no enum at ${path}`);
  return values;
}

describe("published JSON Schemas (R152)", () => {
  const explainSchema = loadSchema(`explain-v${EXPLAIN_SCHEMA_VERSION}.schema.json`);
  const doctorSchema = loadSchema("doctor-v1.schema.json");

  test("the explain schema describes exactly the leaves ExplainOutput declares", () => {
    const fromType = typeLeafPaths({
      files: [join(SRC, "explain.ts"), join(SRC, "interpretation.ts")],
      root: "ExplainOutput",
      expectedLeafTypeNames: [
        "Caveat",
        "CoverageAttribution",
        "GuardEvidence",
        "SurvivorReach",
        "ReachGrain",
        "SurvivorRanking",
        "MutantErrorCause",
        "ToolCondition",
        "ArtifactIdAbsence",
        'ReportValidity["reliability"]',
      ],
    });
    expect([...schemaLeafPaths(explainSchema)].sort()).toEqual([...fromType].sort());
  });

  test("the doctor schema describes exactly the leaves DoctorJsonOutput declares", () => {
    const fromType = typeLeafPaths({
      files: [join(SRC, "cli.ts"), join(SRC, "doctor.ts")],
      root: "DoctorJsonOutput",
      expectedLeafTypeNames: ["DoctorNotChecked", "DoctorCaveatKind"],
    });
    expect([...schemaLeafPaths(doctorSchema)].sort()).toEqual([...fromType].sort());
  });

  test("every published enum equals the runtime domain it copies", () => {
    // The failure this catches is a schema that silently rejects valid documents: a value added to
    // `Caveat` or `MutantErrorCause` ships in the output immediately, and a stale schema then calls
    // a correct file invalid at every consumer that validates.
    expect(enumAt(explainSchema, "$.caveats[].caveat")).toEqual(
      Object.keys(CAVEAT_INTERPRETATIONS),
    );
    expect(enumAt(explainSchema, "$.survivors[].attribution")).toEqual(
      Object.keys(EXPLAIN_ATTRIBUTION_INTERPRETATIONS),
    );
    expect(enumAt(explainSchema, "$.survivors[].guardEvidence")).toEqual(
      Object.keys(GUARD_EVIDENCE_INTERPRETATIONS),
    );
    expect(enumAt(explainSchema, "$.survivors[].reach")).toEqual(
      Object.keys(REACH_INTERPRETATIONS),
    );
    expect(enumAt(explainSchema, "$.survivors[].reachGrain")).toEqual(Object.keys(REACH_GRAINS));
    expect(enumAt(explainSchema, "$.notMeasured[].cause")).toEqual(
      Object.keys(ERROR_CAUSE_INTERPRETATIONS),
    );
    expect(enumAt(explainSchema, "$.toolConditions[].condition")).toEqual([...TOOL_CONDITIONS]);
    expect(enumAt(explainSchema, "$.survivorSelection.rankedBy")).toEqual([...SURVIVOR_RANKINGS]);
    expect(enumAt(explainSchema, "$.survivors[].artifactIdAbsent")).toEqual([
      ...ARTIFACT_ID_ABSENCES,
    ]);
    expect(enumAt(doctorSchema, "$.notChecked")).toEqual([...DOCTOR_NOT_CHECKED_TOKENS]);
    expect(enumAt(doctorSchema, "$.caveat.kind")).toEqual([...DOCTOR_CAVEAT_KINDS]);
  });

  test("each schema pins the version constant its build emits", () => {
    const explainVersion = (explainSchema.properties as Record<string, Schema>)
      .explainSchemaVersion;
    const doctorVersion = (doctorSchema.properties as Record<string, Schema>).doctorSchemaVersion;
    expect(explainVersion?.const).toBe(EXPLAIN_SCHEMA_VERSION);
    expect(doctorVersion?.const).toBe(DOCTOR_SCHEMA_VERSION);
    // The filename carries the version too, so a bump that edits only the const leaves a file whose
    // name lies about what it describes.
    expect(explainSchema.$id).toContain(`explain-v${EXPLAIN_SCHEMA_VERSION}`);
    expect(doctorSchema.$id).toContain(`doctor-v${DOCTOR_SCHEMA_VERSION}`);
  });

  test("a real campaign report's projection validates against the explain schema", () => {
    // Checked against OUTPUT, not only against a type. Its blind spot -- a field no real report
    // reaches -- is what the declaration walk above covers, which is why both tests exist.
    const raw = JSON.parse(
      readFileSync(join(REPO_ROOT, "docs/campaign/2026-08-03-do/rung2.report.json"), "utf8"),
    );
    const projection = explain(assertExplainableReport(raw));
    expect(conformsTo(explainSchema, projection)).toEqual([]);
    // And capped, because --top changes two fields' values and must not change the shape.
    expect(
      conformsTo(explainSchema, explain(assertExplainableReport(raw), { topSurvivors: 3 })),
    ).toEqual([]);
  });

  test("a projection WITH gaps validates against the explain schema (C02-09)", () => {
    // The committed report above predates C02-09 and carries no gap ids, so it never reaches
    // `gaps` or `noCoverageBlocks`. Here every row gets one per (file, procedure, trigger, batch),
    // and two batches get an artifact, so gaps with and without `artifactId`, with and without
    // `triggerName`, and no-coverage blocks all appear.
    const raw = JSON.parse(
      readFileSync(join(REPO_ROOT, "docs/campaign/2026-08-03-do/rung2.report.json"), "utf8"),
    ) as { mutants: Record<string, unknown>[]; artifacts?: unknown };
    const ids = new Map<string, { gapId: string; line: number }>();
    for (const m of raw.mutants) {
      const key = [m.file, m.procedureName, m.triggerName, m.batchIndex].join("|");
      let block = ids.get(key);
      if (block === undefined) {
        block = { gapId: `G${ids.size.toString(16).padStart(12, "0")}`, line: Number(m.line) };
        ids.set(key, block);
      }
      m.gapId = block.gapId;
      m.blockStartLine = block.line;
      m.blockEndLine = block.line + 1;
    }
    raw.artifacts = [0, 1].map((batchIndex) => ({
      batchIndex,
      artifactId: `${batchIndex}`.repeat(32),
      sha256: "c".repeat(64),
      appVersion: "1.0.0.0",
    }));
    const projection = explain(assertExplainableReport(raw));
    const gaps = projection.gaps ?? [];
    expect(gaps.some((g) => g.artifactId !== undefined)).toBe(true);
    expect(gaps.some((g) => g.artifactIdAbsent !== undefined)).toBe(true);
    expect(gaps.some((g) => g.triggerName !== undefined)).toBe(true);
    expect(gaps.some((g) => g.triggerName === undefined)).toBe(true);
    expect(projection.noCoverageBlocks?.length).toBeGreaterThan(0);
    expect(conformsTo(explainSchema, projection)).toEqual([]);
    expect(
      conformsTo(explainSchema, explain(assertExplainableReport(raw), { topSurvivors: 3 })),
    ).toEqual([]);
  });

  test("R351: coverageArmNames is additive under explain v7: output without it validates, and with it", () => {
    // v7 was edited in place, which is sound only while the field stays OPTIONAL on survivors, gaps
    // and no-coverage blocks: required, it would reject every v7 output written before R351.
    const raw = JSON.parse(
      readFileSync(join(REPO_ROOT, "docs/campaign/2026-08-03-do/rung2.report.json"), "utf8"),
    ) as { mutants: Record<string, unknown>[] };
    raw.mutants.forEach((m, i) => {
      m.gapId = `G${i.toString(16).padStart(12, "0")}`;
      m.blockStartLine = Number(m.line);
      m.blockEndLine = Number(m.line) + 1;
    });
    const without = explain(assertExplainableReport(raw));
    const text = JSON.stringify(without);
    expect(text).not.toContain("coverageArmNames");
    expect(without.survivors.length).toBeGreaterThan(0);
    expect(without.gaps?.length).toBeGreaterThan(0);
    expect(without.noCoverageBlocks?.length).toBeGreaterThan(0);
    expect(conformsTo(explainSchema, without)).toEqual([]);
    const withNames = JSON.parse(text) as {
      survivors: Record<string, unknown>[];
      gaps: Record<string, unknown>[];
      noCoverageBlocks: Record<string, unknown>[];
    };
    for (const row of [...withNames.survivors, ...withNames.gaps, ...withNames.noCoverageBlocks]) {
      row.coverageArmNames = ["Alpha"];
    }
    expect(conformsTo(explainSchema, withNames)).toEqual([]);
  });

  test("R252: a coverage-off projection, with attribution not-measured, validates", () => {
    const raw = JSON.parse(
      readFileSync(join(REPO_ROOT, "docs/campaign/2026-08-03-do/rung2.report.json"), "utf8"),
    ) as { mutants: Record<string, unknown>[]; coverageMode?: string };
    raw.coverageMode = "none";
    for (const m of raw.mutants) {
      if (m.verdict === "survived") m.coverageAttribution = undefined;
    }
    const out = explain(assertExplainableReport(JSON.parse(JSON.stringify(raw))));
    expect(out.survivors.length).toBeGreaterThan(0);
    expect(out.survivors.every((s) => s.attribution === "not-measured")).toBe(true);
    expect(conformsTo(explainSchema, out)).toEqual([]);
  });

  test("doctor output validates, with and without a caveat", () => {
    const report = {
      ok: false,
      checks: [
        { name: "environment", ok: true, detail: "reachable (no vendor status reported)" },
        { name: "control-version", ok: false, detail: "1.0.0.0 is older than the shipped app" },
      ],
    };
    expect(conformsTo(doctorSchema, doctorJson(report))).toEqual([]);
    expect(conformsTo(doctorSchema, doctorJson(report, DOCTOR_CREATE_MODE_CAVEAT))).toEqual([]);
    expect(conformsTo(doctorSchema, doctorJson(report, DOCTOR_AL_RUNNER_ONLY_CAVEAT))).toEqual([]);
  });

  test("the validator FAILS a document it should fail — otherwise every test above is vacuous", () => {
    // A validator that returns [] unconditionally would make five green tests mean nothing. Each
    // case below is a defect a consumer would actually meet.
    const raw = JSON.parse(
      readFileSync(join(REPO_ROOT, "docs/campaign/2026-08-03-do/rung2.report.json"), "utf8"),
    );
    const good = explain(assertExplainableReport(raw)) as unknown as Record<string, unknown>;

    // Rest-destructured rather than deleted, and NOT set to `undefined`: the check is `key in
    // record`, so an explicit undefined would leave the key present and this case would silently
    // stop testing absence.
    const { survivorSelection: _omitted, ...missingRequired } = good;
    expect(conformsTo(explainSchema, missingRequired)).toContainEqual({
      path: "$.survivorSelection",
      problem: "required but absent",
    });

    expect(conformsTo(explainSchema, { ...good, explainSchemaVersion: 99 })[0]?.path).toBe(
      "$.explainSchemaVersion",
    );

    expect(conformsTo(explainSchema, { ...good, unexpected: 1 }).map((v) => v.problem)).toContain(
      "not described by the schema",
    );

    const badEnum = {
      ...good,
      survivorSelection: { ...(good.survivorSelection as object), rankedBy: "whatever" },
    };
    expect(conformsTo(explainSchema, badEnum).map((v) => v.path)).toContain(
      "$.survivorSelection.rankedBy",
    );
  });
});

/**
 * C02-06 Task 6. `verify-v1.schema.json` is hand-written, like `doctor` and `explain` above it, and
 * pinned the same way: leaves against the declaration, enums against the runtime domain, version
 * against the constant. The fourth check needs a REAL `runVerify` output rather than a hand-typed
 * one, and orchestrator.test.ts's own runVerify fixtures (search "C02-06 Task 5.4: runVerify")
 * drive a full schemata compile through a fake execution backend and a real lease dance to get one
 * -- machinery this file has no reason to duplicate just to validate a schema. The ALL-SKIPPED path
 * below is a genuine `runVerify` call too, just one that never reaches the backend or the lease
 * (planVerify returns before either is touched once every survivor is reader-marked equivalent),
 * so the backend and lease it passes only need to satisfy the types, not do anything.
 */
function neverCalledBackend(): VerifyDeps["backend"] {
  const boom = (): never => {
    throw new Error("schemas.test.ts verify fixture: the backend is not used on this path");
  };
  return {
    // R354: verify reads its own coverage mode before anything else; the source run is `procedure`.
    capabilities: () => ({
      coverage: "procedure",
      deploy: "publish",
      isolation: "session",
      authoritative: true,
    }),
    status: async () => boom(),
    deploy: async () => boom(),
    compileCheck: async () => boom(),
    activate: async () => boom(),
    run: async () => boom(),
    compileTestApp: async () => boom(),
    publishTestApp: async () => boom(),
  };
}

function neverCalledLease(): VerifyDeps["lease"] {
  const boom = (): never => {
    throw new Error("schemas.test.ts verify fixture: the lease is not used on this path");
  };
  return {
    client: {
      acquire: async () => boom(),
      renew: async () => boom(),
      release: async () => boom(),
      beginPublish: async () => boom(),
      endPublish: async () => boom(),
      getOperationStatus: async () => boom(),
      recoverOp: async () => boom(),
    },
    serverGeneration: async () => boom(),
  };
}

/** One minimal, fully-valid manifest entry -- the same shape verify.test.ts's own `entry()` builds. */
function verifySchemaFixtureEntry(): MutantManifestEntry {
  return {
    mutantId: "M0001",
    file: "Logic.Codeunit.al",
    startIndex: 10,
    endIndex: 20,
    startLine: 3,
    operatorName: "lethal.negate-conditional",
    operatorVersion: "1.0.0",
    astHash: "hash-M0001",
    objectType: "codeunit",
    codeunitId: 50000,
    codeunitName: "Logic",
    procedureName: "Post",
    originalText: "a",
    mutatedText: "b",
  };
}

/**
 * A real source project, a real hashed manifest and `.app` on disk, and a real reader mark: enough
 * for `resolveVerifySource`, `assertSourceUnchanged` and `loadInstalledArtifact` to all run for
 * real, then `planVerify` skips the one survivor, so `runVerify` returns without ever reaching
 * `compileTestApp`/`publishTestApp`/`runNamedMutants`/the lease. A genuine `ok: true` VerifyOutput.
 */
async function buildVerifyHappyPathOutput() {
  const projectDir = mkdtempSync(join(tmpdir(), "lethal-verify-schema-proj-"));
  const instrumentedDir = mkdtempSync(join(tmpdir(), "lethal-verify-schema-instr-"));
  try {
    writeFileSync(join(projectDir, "app.json"), '{"id":"x"}');
    mkdirSync(join(projectDir, "src"));
    writeFileSync(join(projectDir, "src", "Logic.Codeunit.al"), 'codeunit 50000 "Logic" { }');

    const entry = verifySchemaFixtureEntry();
    const manifest: MutantManifest = {
      selectorIds: { selectorId: 1, controlId: 2, tableId: 3 },
      artifactId: "a".repeat(32),
      mutants: [entry],
    };
    const manifestText = JSON.stringify(manifest);
    writeFileSync(join(instrumentedDir, "mutant-manifest.json"), manifestText);
    writeFileSync(join(instrumentedDir, "app.json"), "{}");
    const appBytes = new TextEncoder().encode("fake-test-app-bytes");
    const appPath = join(instrumentedDir, "fake.app");
    writeFileSync(appPath, appBytes);

    writeFileSync(
      join(projectDir, "lethal.equivalent.json"),
      JSON.stringify({
        identityScheme: IDENTITY_SCHEME,
        marks: [{ key: serializeKey(identityKeyOf(entry)), reason: "same either way" }],
      }),
    );

    const store = new ResultsStore(":memory:");
    const preprocessorSymbols: string[] = [];
    const runId = store.createRun({
      coverageMode: "procedure",
      identityScheme: IDENTITY_SCHEME,
      buildSymbols: [],
      projectPath: projectDir,
      backend: "bcdev",
      appVersion: "0.0.0.0",
    });
    store.recordArtifact(runId, {
      batchIndex: 0,
      appVersion: "1.0.0.1",
      appId: "11111111-1111-1111-1111-111111111111",
      artifactId: manifest.artifactId,
      sha256: Bun.SHA256.hash(appBytes, "hex"),
      manifestSha256: Bun.SHA256.hash(manifestText, "hex"),
      appPath,
      instrumentedDir,
      bundle: await bundleFor(instrumentedDir, appPath),
    });
    store.recordSourceHash(runId, await hashTargetSource(projectDir, preprocessorSymbols));
    store.recordMutant(runId, {
      mutantCode: entry.mutantId,
      astHash: entry.astHash,
      codeunitName: entry.codeunitName,
      procedureName: entry.procedureName,
      operatorName: entry.operatorName,
      operatorMajor: 1,
      file: entry.file,
      line: entry.startLine,
      verdict: "survived",
      durationMs: 40,
      batchIndex: 0,
      carried: false,
      coveringTests: [],
    });

    const out = await runVerify(
      { artifact: manifest.artifactId, survivors: ["0/M0001"], testDir: join(projectDir, "tests") },
      {
        store,
        backend: neverCalledBackend(),
        lease: neverCalledLease(),
        resourceServer: "http://schema-fixture",
        resourceServerInstance: "BC",
        preprocessorSymbols,
      },
    );
    store.close();
    return out;
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(instrumentedDir, { recursive: true, force: true });
  }
}

/** No store row, no project, no manifest: `parseVerifyRequest` refuses before any of those is read. */
async function buildVerifyRefusedOutput() {
  const store = new ResultsStore(":memory:");
  const out = await runVerify(
    { artifact: "not-32-hex", survivors: ["0/M0001"], testDir: "unused" },
    {
      store,
      backend: neverCalledBackend(),
      lease: neverCalledLease(),
      resourceServer: "http://schema-fixture",
      resourceServerInstance: "BC",
      preprocessorSymbols: [],
    },
  );
  store.close();
  return out;
}

describe("published JSON Schema - verify (C02-06 Task 6)", () => {
  const verifySchema = loadSchema(`verify-v${VERIFY_SCHEMA_VERSION}.schema.json`);

  // C02-09: v2 added two refusal reasons and `results[].gapId`. v1 stays as it was published, so a
  // stored v1 document remains checkable, and is no longer pinned against the declaration (the
  // explain-v4 precedent).
  test("verify-v1.schema.json is kept as published", () => {
    const v1 = loadSchema("verify-v1.schema.json");
    expect((v1.properties as Record<string, Schema>).verifySchemaVersion?.const).toBe(1);
    expect(enumAt(v1, "$.refused.reason")).not.toContain("unknown-gap");
  });

  // R354: v3 added the refusal reason `coverage-mode-changed`. v2 stays as it was published.
  test("verify-v2.schema.json is kept as published", () => {
    const v2 = loadSchema("verify-v2.schema.json");
    expect((v2.properties as Record<string, Schema>).verifySchemaVersion?.const).toBe(2);
    expect(enumAt(v2, "$.refused.reason")).toContain("gap-has-no-survivor");
    expect(enumAt(v2, "$.refused.reason")).not.toContain("coverage-mode-changed");
  });

  // R-371: v4 added the refusal reasons `too-many-new-tests` and `dependency-unreadable`. v3 stays
  // as it was published.
  test("verify-v3.schema.json is kept as published", () => {
    const v3 = loadSchema("verify-v3.schema.json");
    expect((v3.properties as Record<string, Schema>).verifySchemaVersion?.const).toBe(3);
    expect(enumAt(v3, "$.refused.reason")).toContain("coverage-mode-changed");
    expect(enumAt(v3, "$.refused.reason")).not.toContain("too-many-new-tests");
    expect(enumAt(v3, "$.refused.reason")).not.toContain("dependency-unreadable");
  });

  // R-425: v5 added `reachFilter` and `results[].reachNarrowed`. v4 stays as it was published, and
  // a REAL v4 report (the R-384 gate's step-3 JSON) still validates against it.
  test("verify-v4.schema.json is kept as published", () => {
    const v4 = loadSchema("verify-v4.schema.json");
    expect((v4.properties as Record<string, Schema>).verifySchemaVersion?.const).toBe(4);
    expect(enumAt(v4, "$.refused.reason")).toContain("too-many-new-tests");
    expect([...schemaLeafPaths(v4)]).not.toContain("$.reachFilter.state");
    expect([...schemaLeafPaths(v4)]).not.toContain("$.results[].reachNarrowed");
    const real = JSON.parse(
      readFileSync(join(import.meta.dir, "fixtures", "verify-v4-r384-step3.json"), "utf8"),
    ) as unknown;
    expect(conformsTo(v4, real)).toEqual([]);
  });

  // R-427: v6 added the newTests[].state value `not-rerun`. v5 stays as it was published, so a v5
  // reader never sees `not-rerun`.
  test("verify-v5.schema.json is kept as published", () => {
    const v5 = loadSchema("verify-v5.schema.json");
    expect((v5.properties as Record<string, Schema>).verifySchemaVersion?.const).toBe(5);
    expect([...schemaLeafPaths(v5)]).toContain("$.reachFilter.state");
    expect(enumAt(v5, "$.newTests[].state")).toEqual([
      "stable",
      "flaky",
      "red",
      "flaky-unknown",
      "infra-error",
    ]);
  });

  test("results[].gapId is a declared leaf of the current verify schema", () => {
    expect([...schemaLeafPaths(verifySchema)]).toContain("$.results[].gapId");
  });

  test("the verify schema describes exactly the leaves VerifyOutput declares", () => {
    const fromType = typeLeafPaths({
      files: [join(SRC, "verify.ts")],
      root: "VerifyOutput",
      expectedLeafTypeNames: [
        "VerifyVerdict",
        "KilledBy",
        "NewTestState",
        "UnmutatedOutcome",
        "VerifyRefusal",
        "ReachFilterState",
        "ReachFilterOffReason",
      ],
    });
    expect([...schemaLeafPaths(verifySchema)].sort()).toEqual([...fromType].sort());
  });

  test("every verify enum equals the runtime domain it copies", () => {
    expect(enumAt(verifySchema, "$.results[].verdict")).toEqual([...VERIFY_VERDICTS]);
    expect(enumAt(verifySchema, "$.refused.reason")).toEqual([...VERIFY_REFUSALS]);
    expect(enumAt(verifySchema, "$.results[].killedBy")).toEqual([...KILLED_BY]);
    expect(enumAt(verifySchema, "$.newTests[].state")).toEqual([...NEW_TEST_STATES]);
    expect(enumAt(verifySchema, "$.newTests[].runs[].outcome")).toEqual([...UNMUTATED_OUTCOMES]);
    expect(enumAt(verifySchema, "$.reachFilter.state")).toEqual([...REACH_FILTER_STATES]);
    expect(enumAt(verifySchema, "$.reachFilter.reason")).toEqual([...REACH_FILTER_OFF_REASONS]);
    // R-425: literal pins, for the same reason as the two below.
    expect([...REACH_FILTER_STATES]).toEqual(["on", "off"]);
    expect([...REACH_FILTER_OFF_REASONS]).toEqual([
      "no-reach-filter",
      "coverage-mode-none",
      "coverage-mode-procedure",
      "coverage-mode-line",
      "coverage-mode-al-runner",
    ]);
    // Independent of the constants: a coordinated change to a constant AND the schema moves the
    // published value domain, which needs a deliberate edit here too (R262 review).
    expect([...UNMUTATED_OUTCOMES]).toEqual([
      "pass",
      "fail",
      "skip",
      "timeout",
      "deadline-exceeded",
      "error",
      "not-run",
    ]);
    // R-427: `not-rerun` (v6).
    expect([...NEW_TEST_STATES]).toEqual([
      "stable",
      "flaky",
      "red",
      "flaky-unknown",
      "infra-error",
      "not-rerun",
    ]);
  });

  test("the verify schema's version const and $id match VERIFY_SCHEMA_VERSION", () => {
    const verifyVersion = (verifySchema.properties as Record<string, Schema>).verifySchemaVersion;
    expect(verifyVersion?.const).toBe(VERIFY_SCHEMA_VERSION);
    expect(verifySchema.$id).toContain(`verify-v${VERIFY_SCHEMA_VERSION}`);
  });

  test("a runVerify output validates", async () => {
    const happy = await buildVerifyHappyPathOutput();
    expect(happy.ok).toBe(true);
    expect(happy.results.map((r) => r.verdict)).toEqual(["skipped"]);
    expect(conformsTo(verifySchema, happy)).toEqual([]);

    const refused = await buildVerifyRefusedOutput();
    expect(refused.refused?.reason).toBe("malformed-request");
    expect(refused.source).toBeUndefined();
    expect(conformsTo(verifySchema, refused)).toEqual([]);

    // Neither fixture above reaches a killed or survived verdict, testApp, or a populated newTests
    // entry: planVerify returns before any of those are touched once every survivor is skipped, and
    // parseVerifyRequest refuses before source resolves at all. The leaf-path test further up only
    // confirms those paths EXIST in both the type and the schema -- it never checks `required` or
    // `additionalProperties` on them, which live only in the hand-written JSON. This literal is
    // typed `: VerifyOutput` with no `as` anywhere, so tsc itself forces every field VerifyOutput
    // requires to be present, and it fills every optional leaf `killingTest`/`killedBy`/`testApp`/
    // `newTests[].runs` touch -- closing that gap without a runNamed fake or a committed report.
    const measured: VerifyOutput = {
      verifySchemaVersion: VERIFY_SCHEMA_VERSION,
      reachFilter: { state: "off", reason: "coverage-mode-procedure" },
      ok: false,
      exitCode: 5,
      source: {
        runId: 1,
        batchIndex: 0,
        artifactId: "a".repeat(32),
        artifactSha256: "b".repeat(64),
        sourceSha256: "c".repeat(64),
        projectPath: "C:/fixtures/sandbox-app",
      },
      verifyRunId: 2,
      testApp: {
        name: "Server Tests",
        version: "7.7.7.7",
        sha256: "d".repeat(64),
        compiledAgainst: { artifactId: "a".repeat(32), sha256: "b".repeat(64) },
      },
      newTests: [
        {
          test: "New Tests.OverBudgetDetected",
          codeunitId: 79102,
          state: "stable",
          runs: [
            { outcome: "pass", fresh: true, sessionId: 11, testRunsBefore: 0 },
            { outcome: "pass", fresh: true, sessionId: 12, testRunsBefore: 0 },
          ],
        },
        // R-427: a test sent to no survivor, with its one baseline run.
        {
          test: "New Tests.ReachesNothing",
          codeunitId: 79102,
          state: "not-rerun",
          runs: [{ outcome: "pass", fresh: true, sessionId: 13, testRunsBefore: 0 }],
        },
      ],
      results: [
        {
          id: "0/M0001",
          batchIndex: 0,
          mutantCode: "M0001",
          file: "Logic.Codeunit.al",
          line: 3,
          operatorName: "lethal.negate-conditional",
          procedureName: "Post",
          gapId: "G0123456789ab",
          verdict: "killed",
          testsRun: ["Sandbox Tests.OverBudgetDetected"],
          killingTest: {
            codeunitId: 79100,
            codeunitName: "Sandbox Tests",
            method: "OverBudgetDetected",
          },
          killedByNewTest: false,
          killedBy: "assertion",
          killingTestFailure: "Assert.AreEqual failed. Expected:<400> Actual:<0>.",
          reachNarrowed: false,
        },
        {
          id: "0/M0002",
          batchIndex: 0,
          mutantCode: "M0002",
          file: "Logic.Codeunit.al",
          line: 9,
          operatorName: "lethal.remove-assignment",
          procedureName: "Post",
          verdict: "survived",
          testsRun: ["Sandbox Tests.OverBudgetDetected"],
        },
      ],
      counts: { killed: 1, survived: 1, error: 0, skipped: 0 },
      timings: { totalMs: 1234, compileMs: 200, publishMs: 50 },
    };
    expect(conformsTo(verifySchema, measured)).toEqual([]);
  });
});

/**
 * The two BIG surfaces are GENERATED (`scripts/generate-schemas.ts`) rather than hand-written:
 * `SessionReport` has 130 leaves and the stream is a union of 22 event shapes, and at that size a
 * hand-written file is a second copy of the type rather than a guarantee. So the tests differ too —
 * freshness against the generator replaces the leaf-path pin, and both are checked against real
 * committed data.
 */
describe("generated JSON Schemas — report and stream (R152)", () => {
  const reportSchema = loadSchema(`report-v${REPORT_SCHEMA_VERSION}.schema.json`);
  /** R231: v2 is a frozen archive once v3 exists, kept so an archived v2 report is still checked
   *  against the shape it was written under. */
  const reportV2Schema = loadSchema("report-v2.schema.json");
  const streamSchema = loadSchema("stream-v1.schema.json");

  /**
   * Spawns a real `bun` subprocess, which passes alone in well under a second but can push past
   * Bun's 5 s default test timeout when something else is loading the machine (a full `bun test`
   * run, or a live itest at the same time). See HOOK_TIMEOUT_MS in campaign-subcommands.test.ts
   * (R335) for the measured shape of this failure.
   */
  const SPAWN_TEST_TIMEOUT_MS = 60_000;

  test(
    "the committed schemas are what the generator produces from today's types",
    () => {
      // The whole guarantee for a generated artifact: edit the type, forget to regenerate, and this
      // reddens instead of a consumer discovering it.
      const r = spawnSync("bun", [join(REPO_ROOT, "scripts/generate-schemas.ts"), "--check"], {
        encoding: "utf8",
        cwd: REPO_ROOT,
      });
      expect(r.stdout + r.stderr).not.toContain("STALE");
      expect(r.status).toBe(0);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test("each pins its own version constant, and its filename agrees", () => {
    const props = reportSchema.properties as Record<string, Schema>;
    expect(props.schemaVersion?.const).toBe(REPORT_SCHEMA_VERSION);
    expect(reportSchema.$id).toContain(`report-v${REPORT_SCHEMA_VERSION}`);
    expect(streamSchema.$id).toContain(`stream-v${STREAM_SCHEMA_VERSION}`);
  });

  test("R214: the report schema names the two preprocessor exclusion reasons", () => {
    // R307's `instrumentation-refused` follows them.
    expect(enumAt(reportSchema, "$.excludedSites.files[].reason")).toEqual([
      "not-instrumentable",
      "declarative",
      "compiled-out",
      "preproc-undecided",
      "instrumentation-refused",
    ]);
  });

  test("a report written by THIS build validates against the report schema", () => {
    // Real data, and redacted data: redaction replaces two string fields, so a report that stopped
    // validating afterwards would mean the schema disagrees with the redactor.
    const doc = JSON.parse(
      readFileSync(
        join(REPO_ROOT, "docs/campaign/2026-08-16-gift-card/rehearsal.report.json"),
        "utf8",
      ),
    );
    expect(conformsTo(reportSchema, doc)).toEqual([]);
  });

  test("R351: coverageArmNames is additive under v3: a report without it validates, and with it", () => {
    // v3 was edited in place, which is sound only while the field stays OPTIONAL. Making it
    // required on a row or a survivor group would reject every report written before R351.
    const raw = readFileSync(
      join(REPO_ROOT, "docs/campaign/2026-08-16-gift-card/rehearsal.report.json"),
      "utf8",
    );
    expect(raw).not.toContain("coverageArmNames");
    const without = JSON.parse(raw) as {
      mutants: Record<string, unknown>[];
      survivorsByProcedure: Record<string, unknown>[];
    };
    expect(without.mutants.length).toBeGreaterThan(0);
    expect(without.survivorsByProcedure.length).toBeGreaterThan(0);
    expect(conformsTo(reportSchema, without)).toEqual([]);
    const withNames = JSON.parse(raw) as typeof without;
    for (const row of [...withNames.mutants, ...withNames.survivorsByProcedure]) {
      row.coverageArmNames = ["Alpha"];
    }
    expect(conformsTo(reportSchema, withNames)).toEqual([]);
  });

  test("R252: coverageMode is additive under v3: a report without it validates, and with it", () => {
    // v3 was edited in place, which is sound only while the field stays OPTIONAL: required, it
    // would reject every report written before R252.
    const raw = readFileSync(
      join(REPO_ROOT, "docs/campaign/2026-08-16-gift-card/rehearsal.report.json"),
      "utf8",
    );
    expect(raw).not.toContain("coverageMode");
    const without = JSON.parse(raw) as Record<string, unknown>;
    expect(conformsTo(reportSchema, without)).toEqual([]);
    for (const mode of ["none", "procedure", "line", "fenced", "al-runner"]) {
      expect(conformsTo(reportSchema, { ...without, coverageMode: mode })).toEqual([]);
    }
    expect(conformsTo(reportSchema, { ...without, coverageMode: "None" })).not.toEqual([]);
  });

  test("R381: buildSymbols is additive under v3: optional, a report without it validates, and with it, [] included", () => {
    const without = JSON.parse(
      readFileSync(
        join(REPO_ROOT, "docs/campaign/2026-08-16-gift-card/rehearsal.report.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect("buildSymbols" in without).toBe(false);
    // Optional: required, it would reject every report written before R381.
    const props = (reportSchema as { properties: Record<string, unknown>; required: string[] })
      .properties;
    expect(props.buildSymbols).toBeDefined();
    expect((reportSchema as { required: string[] }).required).not.toContain("buildSymbols");
    expect(conformsTo(reportSchema, without)).toEqual([]);
    expect(conformsTo(reportSchema, { ...without, buildSymbols: [] })).toEqual([]);
    expect(conformsTo(reportSchema, { ...without, buildSymbols: ["A", "B"] })).toEqual([]);
    expect(conformsTo(reportSchema, { ...without, buildSymbols: "A" })).not.toEqual([]);
  });

  test("OLDER reports are also v2 and do NOT validate — the schema is one BUILD's shape (R157)", () => {
    // Pinned rather than hidden. `declarativeSites` and `preprocessorSymbols` are REQUIRED by
    // today's SessionReport and absent from reports written before they existed, while
    // schemaVersion stayed 2 throughout, because the versioning rule treats an added field as
    // additive. A required added field is not backward compatible for a VALIDATOR even when it is
    // for a reader, and a consumer validating an archived report meets that as a false rejection.
    const older = JSON.parse(
      readFileSync(
        join(REPO_ROOT, "docs/campaign/2026-08-08-r85-swap-population/rung2.report.json"),
        "utf8",
      ),
    );
    // R231: checked against the FROZEN v2 file, the version this report declares.
    const missing = conformsTo(reportV2Schema, older)
      .filter((v) => v.problem === "required but absent")
      .map((v) => v.path)
      .sort();
    expect(missing).toEqual([
      "$.declarativeSites",
      "$.preprocessorSymbols",
      "$.unplaceableCount",
      "$.unplaceableMutants",
    ]);
    // R325: `identityScheme` is absent from every report written before it and is OPTIONAL in the
    // schema, so it is not in the list above. Absent reads as scheme 1.
    expect("identityScheme" in older).toBe(false);
  });

  /**
   * R157's decision, made EXECUTABLE rather than written down and forgotten.
   *
   * The old rule said "additive fields do not require a bump". True for a reader, false for a
   * validator: `declarativeSites` and `preprocessorSymbols` were both added as REQUIRED while
   * `schemaVersion` stayed 2, so an archived v2 report is rejected by the published v2 schema. The
   * narrowed rule is that an added OPTIONAL field is free and an added REQUIRED field bumps.
   *
   * Pinning the root `required` SET of every published schema is what enforces it. Adding a
   * required field regenerates the schema (the freshness test forces that), which changes this set,
   * which reddens here with the decision named — instead of a second shape shipping under one
   * number the way it did twice already.
   *
   * The set is pinned per FILE rather than per version constant so a new surface cannot be added
   * without landing in this list.
   */
  test("the root required set of every published schema is pinned (R157)", () => {
    const rootRequired: Record<string, readonly string[]> = {};
    for (const file of [
      ...new Glob("*.schema.json").scanSync({ cwd: join(REPO_ROOT, "schemas") }),
    ]) {
      const doc = JSON.parse(readFileSync(join(REPO_ROOT, "schemas", file), "utf8")) as {
        required?: readonly string[];
      };
      rootRequired[file] = [...(doc.required ?? [])].sort();
    }
    expect(rootRequired).toEqual({
      "campaign-compare-v1.schema.json": [
        "baselinePath",
        "campaignCompareSchemaVersion",
        "coverage",
        "differences",
        "identical",
        "mutantCount",
        "stage",
      ],
      "doctor-v1.schema.json": ["checks", "doctorSchemaVersion", "notChecked", "ok"],
      "explain-v4.schema.json": [
        "caveats",
        "contract",
        "derivedFromReportSchemaVersion",
        "explainSchemaVersion",
        "notMeasured",
        "score",
        "survivorSelection",
        "survivors",
        "toolConditions",
      ],
      "explain-v5.schema.json": [
        "caveats",
        "contract",
        "derivedFromReportSchemaVersion",
        "explainSchemaVersion",
        "notMeasured",
        "score",
        "survivorSelection",
        "survivors",
        "toolConditions",
      ],
      "explain-v6.schema.json": [
        "caveats",
        "contract",
        "derivedFromReportSchemaVersion",
        "explainSchemaVersion",
        "notMeasured",
        "score",
        "survivorSelection",
        "survivors",
        "toolConditions",
      ],
      "explain-v7.schema.json": [
        "caveats",
        "contract",
        "derivedFromReportSchemaVersion",
        "explainSchemaVersion",
        "markIdentityScheme",
        "notMeasured",
        "score",
        "survivorSelection",
        "survivors",
        "toolConditions",
      ],
      "explain-v8.schema.json": [
        "caveats",
        "contract",
        "derivedFromReportSchemaVersion",
        "explainSchemaVersion",
        "markIdentityScheme",
        "notMeasured",
        "score",
        "survivorSelection",
        "survivors",
        "toolConditions",
      ],
      "explain-v9.schema.json": [
        "caveats",
        "contract",
        "derivedFromReportSchemaVersion",
        "explainSchemaVersion",
        "markIdentityScheme",
        "notMeasured",
        "score",
        "survivorSelection",
        "survivors",
        "toolConditions",
      ],
      "explain-v10.schema.json": [
        "caveats",
        "contract",
        "derivedFromReportSchemaVersion",
        "explainSchemaVersion",
        "markIdentityScheme",
        "notMeasured",
        "score",
        "survivorSelection",
        "survivors",
        "toolConditions",
      ],
      "explain-v11.schema.json": [
        "caveats",
        "contract",
        "derivedFromReportSchemaVersion",
        "explainSchemaVersion",
        "markIdentityScheme",
        "notMeasured",
        "score",
        "survivorSelection",
        "survivors",
        "toolConditions",
      ],
      "report-v2.schema.json": [
        "authoritative",
        "backend",
        "baselineGreen",
        "batches",
        "counts",
        "declarativeSites",
        "mutants",
        "mutationScore",
        "notInstrumented",
        "preprocessorSymbols",
        "schemaVersion",
        "survivorsByProcedure",
        "testFiles",
        "timings",
        "unplaceableCount",
        "unplaceableMutants",
        "unsupportedTests",
        "untargetedTriggerCount",
        "validity",
      ],
      "report-v3.schema.json": [
        "authoritative",
        "backend",
        "baselineGreen",
        "batches",
        "counts",
        "declarativeSites",
        "mutants",
        "mutationScore",
        "notInstrumented",
        "preprocessorSymbols",
        "schemaVersion",
        "survivorsByProcedure",
        "testFiles",
        "timings",
        "unplaceableCount",
        "unplaceableMutants",
        "unsupportedTests",
        "untargetedTriggerCount",
        "validity",
      ],
      // The stream schema describes ONE EVENT, a union whose members carry their own required
      // fields, so an empty root set is correct here and not an omission.
      "stream-v1.schema.json": [],
      "verify-v1.schema.json": [
        "counts",
        "exitCode",
        "newTests",
        "ok",
        "results",
        "timings",
        "verifySchemaVersion",
      ],
      "verify-v2.schema.json": [
        "counts",
        "exitCode",
        "newTests",
        "ok",
        "results",
        "timings",
        "verifySchemaVersion",
      ],
      "verify-v3.schema.json": [
        "counts",
        "exitCode",
        "newTests",
        "ok",
        "results",
        "timings",
        "verifySchemaVersion",
      ],
      "verify-v4.schema.json": [
        "counts",
        "exitCode",
        "newTests",
        "ok",
        "results",
        "timings",
        "verifySchemaVersion",
      ],
      // R-425: the same seven; `reachFilter` is optional (absent = not decided).
      "verify-v5.schema.json": [
        "counts",
        "exitCode",
        "newTests",
        "ok",
        "results",
        "timings",
        "verifySchemaVersion",
      ],
      // R-427: the same seven; v6 only grew newTests[].state.
      "verify-v6.schema.json": [
        "counts",
        "exitCode",
        "newTests",
        "ok",
        "results",
        "timings",
        "verifySchemaVersion",
      ],
    });
  });

  /**
   * R233, the value-domain half of R157's pin. `EXPLAIN_SCHEMA_VERSION`'s rule says a value domain
   * that changes in either direction bumps the version, and five commits grew v4's `caveat` and
   * `cause` sets without one. Every `enum` in the published explain schema is pinned here by PATH
   * against a LITERAL list, not against the runtime constant it copies (the test above does that,
   * and moves with the code). What it guards: a changed list at an existing path is a bump, and the
   * fix is a version bump plus a new list, never an edited one. ANY new enum path also reddens it,
   * and needs explicit review and a literal pin here; whether that bumps follows
   * `schemas/README.md` (adding an optional field does not), not the path's novelty alone. C02-09's
   * `gaps[].artifactIdAbsent` is that case: a new optional field whose list is asserted IDENTICAL
   * to `survivors[].artifactIdAbsent`'s below, so no new value domain appears.
   */
  test("every enum value set in the published explain schema is pinned (R233)", () => {
    const enums: Record<string, readonly unknown[]> = {};
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((n, i) => walk(n, `${path}[${i}]`));
        return;
      }
      if (typeof node !== "object" || node === null) return;
      for (const [k, v] of Object.entries(node)) {
        if (k === "enum") enums[path] = v as readonly unknown[];
        else walk(v, `${path}/${k}`);
      }
    };
    walk(loadSchema(`explain-v${EXPLAIN_SCHEMA_VERSION}.schema.json`), "#");
    expect(
      enums,
      "An explain value domain changed. R233: EXPLAIN_SCHEMA_VERSION bumps for ANY value added or " +
        "removed (explain.ts, its doc comment); bump it, publish a new schema file, then pin here.",
    ).toEqual({
      "#/properties/score/properties/reliability": [
        "full",
        "narrowed",
        "degraded",
        "narrowed-degraded",
      ],
      "#/properties/caveats/items/properties/caveat": [
        "baseline-red",
        "narrowed",
        "operator-narrowed",
        "line-narrowed",
        "tests-narrowed",
        "uninstrumentable-files",
        "files-refused",
        "stale-test-app",
        "tests-permission-refused",
        "tests-testpage-unsupported",
        "tests-testpage-refused",
        "runner-disagreement",
        "stop-hung-sessions",
        "resumed",
        "untargeted-triggers",
        "attribution-unplaceable",
        "platform-artifact-kills",
        "kills-without-assertion",
        "declarative-sites-dropped",
        "all-errors",
        "session-warm",
        "preproc-files-refused",
        "tests-compiled-out",
        "test-symbols-unverified",
      ],
      "#/properties/survivorSelection/properties/rankedBy": ["report-order", "actionability"],
      "#/properties/survivors/items/properties/attribution": [
        "exact",
        "object",
        "all-green",
        "not-measured",
      ],
      "#/properties/survivors/items/properties/guardEvidence": [
        "observed",
        "not-observed",
        "not-measured",
      ],
      "#/properties/survivors/items/properties/reach": [
        "reached-unnoticed",
        "covered-but-unreached",
        "unreached-and-uncovered",
        "not-decided",
      ],
      "#/properties/survivors/items/properties/reachGrain": ["statement", "enclosing", "unplaced"],
      "#/properties/survivors/items/properties/artifactIdAbsent": [
        "carried",
        "not-recorded",
        "not-published",
      ],
      "#/properties/gaps/items/properties/artifactIdAbsent": [
        "carried",
        "not-recorded",
        "not-published",
      ],
      "#/properties/notMeasured/items/properties/cause": [
        "deadline-exceeded",
        "unstable",
        "stranded",
        "result-lost",
        "group-run-error",
        "group-answer-malformed",
        "group-coverage-incomplete",
        "op-stopped",
        "stopped-after-completion",
        "session-reused",
        "warm-prefix-unstable",
        "warm-timeout-unconfirmed",
        "warm-confirmation-incomplete",
      ],
      "#/properties/toolConditions/items/properties/condition": ["quarantined", "stranded-skips"],
    });
    // C02-09: the one new enum path reuses the survivor's domain exactly, which is why it did not
    // bump the version.
    expect(enums["#/properties/gaps/items/properties/artifactIdAbsent"]).toEqual(
      enums["#/properties/survivors/items/properties/artifactIdAbsent"],
    );
  });

  test("the explain survivor row's required set is pinned (C02-01, R265)", () => {
    // Nested required lists are not covered by the R157 root pin. A new survivor field added to
    // this list would make an edited schema reject an explain output stored before it, which is why
    // R265's required `markKey` is a new file (v7) and v6 keeps its list.
    const required = (file: string) => {
      const schema = loadSchema(file);
      const items = ((schema.properties as Record<string, Schema>).survivors?.items ?? {}) as {
        required?: string[];
      };
      return [...(items.required ?? [])].sort();
    };
    const v6 = required("explain-v6.schema.json");
    expect(required("explain-v7.schema.json")).toEqual([...v6, "markKey"].sort());
    // R252's v8 changed a value domain, not the required set.
    expect(required("explain-v8.schema.json")).toEqual(required("explain-v7.schema.json"));
    // R214's v9 added a caveat value, not a required field.
    expect(required("explain-v9.schema.json")).toEqual(required("explain-v8.schema.json"));
    // R403's v10 added two caveat values, not a required field.
    expect(required("explain-v10.schema.json")).toEqual(required("explain-v9.schema.json"));
    // R307's v11 added a caveat value, not a required field.
    expect(required("explain-v11.schema.json")).toEqual(required("explain-v10.schema.json"));
    expect(v6).toEqual([
      "attribution",
      "codeunitName",
      "coveringTests",
      "executionProven",
      "file",
      "guardEvidence",
      "guardInterpretation",
      "interpretation",
      "line",
      "mutantCode",
      "mutatedText",
      "operatorName",
      "originalText",
      "procedureName",
      "reach",
      "reachInterpretation",
    ]);
  });

  test("every line of the committed event stream validates, header excepted", () => {
    // The header is NOT a RunEvent — the sink writes it itself, and it carries `ndjsonHeader: true`
    // with no `seq` precisely so a consumer can tell the two apart. A schema that accepted it would
    // erase that distinction.
    const text = readFileSync(
      join(REPO_ROOT, "docs/campaign/2026-08-16-gift-card/rehearsal.events.ndjson"),
      "utf8",
    );
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
    expect(lines.length).toBeGreaterThan(10);

    const header = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(header.ndjsonHeader).toBe(true);
    expect(header.seq).toBeUndefined();
    expect(conformsTo(streamSchema, header).length).toBeGreaterThan(0);

    for (const [i, line] of lines.slice(1).entries()) {
      const event = JSON.parse(line) as Record<string, unknown>;
      // R211 closed: seq 5 (`mutation-set-generated`) used to be pinned as a known failure because
      // the stream predated hangCapableCount and excludedByExclude. The R231 re-freeze re-ran the
      // stage live, so every line, seq 5 included, now carries measured values and must validate.
      expect(conformsTo(streamSchema, event), `line ${i + 2} (${String(event.type)})`).toEqual([]);
    }
  });

  test("the report schema REFUSES a document it should refuse", () => {
    // Without this the four green tests above could all be passing on a validator that says yes to
    // everything.
    const doc = JSON.parse(
      readFileSync(
        join(REPO_ROOT, "docs/campaign/2026-08-16-gift-card/rehearsal.report.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(conformsTo(reportSchema, { ...doc, schemaVersion: 99 }).length).toBeGreaterThan(0);
    expect(conformsTo(reportSchema, { ...doc, surprise: true }).map((v) => v.problem)).toContain(
      "not described by the schema",
    );
    const { counts: _dropped, ...missing } = doc;
    expect(conformsTo(reportSchema, missing)).toContainEqual({
      path: "$.counts",
      problem: "required but absent",
    });
  });
});

describe("published JSON Schema - campaign compare (R357)", () => {
  const compareSchema = loadSchema(
    `campaign-compare-v${CAMPAIGN_COMPARE_SCHEMA_VERSION}.schema.json`,
  );
  const RECORDS = "campaign-records/r357";
  const mutant = (code: string, verdict: string, line: number) => ({
    mutantCode: code,
    file: "A.Codeunit.al",
    line,
    operatorName: "conditional-boundary",
    verdict,
    batchIndex: 0,
    astHash: `hash-${code}`,
    codeunitName: "A",
    operatorMajor: 1,
    runner: "fenced",
    durationMs: 0,
    procedureName: "P",
    startIndex: 0,
    endIndex: 1,
    originalText: "x",
    mutatedText: "y",
    coveringTests: [],
  });
  const reportWith = (coverageMode: string) => ({
    coverageMode,
    mutants: [mutant("M0001", "killed", 1), mutant("M0002", "survived", 2)],
    batches: 1,
  });
  const entries = normalizeForComparison(reportWith("fenced") as never);

  let repo: string;
  let out: string;
  const args = (stage: string) => ({
    manifestPath: join(repo, "campaign.json"),
    stage,
    reportPath: join(out, "fenced.json"),
    log: () => {},
  });

  beforeAll(async () => {
    repo = await makeGitRepo({
      "campaign.json": JSON.stringify({ recordsDir: RECORDS, campaignId: "r357" }),
      [`${RECORDS}/verified.precommit.md`]: "# v\n",
      [`${RECORDS}/verified.baseline.json`]: JSON.stringify({ coverageMode: "fenced", entries }),
      [`${RECORDS}/legacy.precommit.md`]: "# l\n",
      [`${RECORDS}/legacy.baseline.json`]: JSON.stringify(entries),
      [`${RECORDS}/other.precommit.md`]: "# o\n",
      [`${RECORDS}/other.baseline.json`]: JSON.stringify({ coverageMode: "none", entries }),
    });
    out = mkdtempSync(join(tmpdir(), "r357-"));
    writeFileSync(join(out, "fenced.json"), JSON.stringify(reportWith("fenced")));
  }, 60_000);

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });

  test("a matching stage validates, and an UNVERIFIED old stage validates with its statement", async () => {
    const verified = await compareCampaignStage(args("verified"));
    expect(verified.coverage.verified).toBe(true);
    expect(conformsTo(compareSchema, verified)).toEqual([]);

    const legacy = await compareCampaignStage(args("legacy"));
    expect(legacy.coverage.verified).toBe(false);
    expect(conformsTo(compareSchema, legacy)).toEqual([]);

    // The validator must be able to say no: an unverified result WITHOUT its statement.
    const { statement: _dropped, ...bare } = legacy.coverage as Record<string, unknown>;
    expect(conformsTo(compareSchema, { ...legacy, coverage: bare }).length).toBeGreaterThan(0);
  }, 60_000);

  test("a coverage-mode mismatch is a refusal: it throws, so there is no document to validate", async () => {
    await expect(compareCampaignStage(args("other"))).rejects.toThrow(/coverageMode "none"/);
  }, 60_000);

  test("the schema pins the version its build emits", () => {
    const props = compareSchema.properties as Record<string, Schema>;
    expect(props.campaignCompareSchemaVersion?.const).toBe(CAMPAIGN_COMPARE_SCHEMA_VERSION);
    expect(compareSchema.$id).toContain(`campaign-compare-v${CAMPAIGN_COMPARE_SCHEMA_VERSION}`);
  });
});
