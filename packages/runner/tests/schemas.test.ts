import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import {
  DOCTOR_AL_RUNNER_ONLY_CAVEAT,
  DOCTOR_CAVEAT_KINDS,
  DOCTOR_CREATE_MODE_CAVEAT,
  DOCTOR_NOT_CHECKED_TOKENS,
  DOCTOR_SCHEMA_VERSION,
  doctorJson,
} from "../src/cli";
import { STREAM_SCHEMA_VERSION } from "../src/events";
import { EXPLAIN_SCHEMA_VERSION, SURVIVOR_RANKINGS, TOOL_CONDITIONS } from "../src/explain";
import { assertExplainableReport, explain } from "../src/explain";
import {
  CAVEAT_INTERPRETATIONS,
  ERROR_CAUSE_INTERPRETATIONS,
  GUARD_EVIDENCE_INTERPRETATIONS,
  REACH_INTERPRETATIONS,
  REPORT_SCHEMA_VERSION,
} from "../src/report";
import { ATTRIBUTION_INTERPRETATIONS } from "../src/selection";
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
  const explainSchema = loadSchema("explain-v4.schema.json");
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
        "SurvivorRanking",
        "MutantErrorCause",
        "ToolCondition",
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
      Object.keys(ATTRIBUTION_INTERPRETATIONS),
    );
    expect(enumAt(explainSchema, "$.survivors[].guardEvidence")).toEqual(
      Object.keys(GUARD_EVIDENCE_INTERPRETATIONS),
    );
    expect(enumAt(explainSchema, "$.survivors[].reach")).toEqual(
      Object.keys(REACH_INTERPRETATIONS),
    );
    expect(enumAt(explainSchema, "$.notMeasured[].cause")).toEqual(
      Object.keys(ERROR_CAUSE_INTERPRETATIONS),
    );
    expect(enumAt(explainSchema, "$.toolConditions[].condition")).toEqual([...TOOL_CONDITIONS]);
    expect(enumAt(explainSchema, "$.survivorSelection.rankedBy")).toEqual([...SURVIVOR_RANKINGS]);
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
 * The two BIG surfaces are GENERATED (`scripts/generate-schemas.ts`) rather than hand-written:
 * `SessionReport` has 130 leaves and the stream is a union of 20 event shapes, and at that size a
 * hand-written file is a second copy of the type rather than a guarantee. So the tests differ too —
 * freshness against the generator replaces the leaf-path pin, and both are checked against real
 * committed data.
 */
describe("generated JSON Schemas — report and stream (R152)", () => {
  const reportSchema = loadSchema("report-v2.schema.json");
  const streamSchema = loadSchema("stream-v1.schema.json");

  test("the committed schemas are what the generator produces from today's types", () => {
    // The whole guarantee for a generated artifact: edit the type, forget to regenerate, and this
    // reddens instead of a consumer discovering it.
    const r = spawnSync("bun", [join(REPO_ROOT, "scripts/generate-schemas.ts"), "--check"], {
      encoding: "utf8",
      cwd: REPO_ROOT,
    });
    expect(r.stdout + r.stderr).not.toContain("STALE");
    expect(r.status).toBe(0);
  });

  test("each pins its own version constant, and its filename agrees", () => {
    const props = reportSchema.properties as Record<string, Schema>;
    expect(props.schemaVersion?.const).toBe(REPORT_SCHEMA_VERSION);
    expect(reportSchema.$id).toContain(`report-v${REPORT_SCHEMA_VERSION}`);
    expect(streamSchema.$id).toContain(`stream-v${STREAM_SCHEMA_VERSION}`);
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
    const missing = conformsTo(reportSchema, older)
      .filter((v) => v.problem === "required but absent")
      .map((v) => v.path)
      .sort();
    expect(missing).toEqual(["$.declarativeSites", "$.preprocessorSymbols"]);
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
