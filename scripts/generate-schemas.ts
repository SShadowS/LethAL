#!/usr/bin/env bun
/**
 * Generate the JSON Schemas for the two BIG output surfaces from their TypeScript declarations.
 *
 *   bun scripts/generate-schemas.ts            # writes schemas/report-v2.schema.json + stream-v1
 *   bun scripts/generate-schemas.ts --check     # exits 1 if a committed schema is stale
 *
 * WHY GENERATED, WHEN THE OTHER TWO ARE HAND-WRITTEN. `explain` (34 leaves) and `doctor` (8) are
 * small enough that a hand-written schema pinned against the declaration is the cheaper guarantee —
 * see `schemas/README.md`. `SessionReport` has **130 leaves** and the event stream is a union of
 * event shapes; at that size a hand-written file is not a guarantee, it is a second copy of the
 * type that someone will forget. The decision is about size, not principle, and R152 records it.
 *
 * FAILS LOUDLY on any type construct it does not understand, exactly like `typeLeafPaths` does:
 * emitting `{}` for a shape it could not read would produce a schema that validates everything,
 * which is worse than no schema because it looks like coverage.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { STREAM_SCHEMA_VERSION } from "../packages/runner/src/events";
import { REPORT_SCHEMA_VERSION } from "../packages/runner/src/report";

const SRC = join(import.meta.dir, "..", "packages", "runner", "src");
const SCHEMAS = join(import.meta.dir, "..", "schemas");

/** Every file whose declarations may be expanded. A type reference to something outside this set is
 *  an error, never a silent `{}`. */
const FILES = [
  "report.ts",
  "interpretation.ts",
  "selection.ts",
  "store.ts",
  "events.ts",
  "backend.ts",
  "al-runner-canary.ts",
  "permission-canary.ts",
  "assertion-screen.ts",
  "operation-outcome.ts",
].map((f) => join(SRC, f));

/** Types the report references from OTHER packages. Listed explicitly for the same reason as above:
 *  an unresolved reference must be an error, so every file that can satisfy one is named. */
const CROSS_PACKAGE = [
  join(import.meta.dir, "..", "packages", "schemata", "src", "project.ts"),
  join(import.meta.dir, "..", "packages", "schemata", "src", "id-ranges.ts"),
  join(import.meta.dir, "..", "packages", "engine", "src", "operator", "interface.ts"),
];

type Schema = Record<string, unknown>;

class UnsupportedType extends Error {
  constructor(what: string, at: string) {
    super(
      `generate-schemas: ${at} has type ${what}, which this generator does not understand. Emitting an open object here would produce a schema that validates anything, so it refuses. Extend the generator, or simplify the type.`,
    );
    this.name = "UnsupportedType";
  }
}

function collectDeclarations(files: readonly string[]): Map<string, ts.TypeNode> {
  const out = new Map<string, ts.TypeNode>();
  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const stmt of source.statements) {
      if (ts.isInterfaceDeclaration(stmt)) {
        out.set(
          stmt.name.text,
          ts.factory.createTypeLiteralNode(stmt.members.filter(ts.isPropertySignature)),
        );
      } else if (ts.isTypeAliasDeclaration(stmt)) {
        out.set(stmt.name.text, stmt.type);
      }
    }
  }
  return out;
}

const declarations = collectDeclarations([...FILES, ...CROSS_PACKAGE]);

/**
 * The `const X = ["a", "b"] as const` arrays this codebase derives its closed sets from, so that
 * `(typeof X)[number]` resolves to the same enum a consumer branches on. That pattern is used
 * deliberately here — the runtime array is the source and the type is derived from it, so the two
 * cannot drift — and a generator that could not read it would refuse half the report's value
 * domains.
 */
function collectConstArrays(files: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const stmt of source.statements) {
      if (!ts.isVariableStatement(stmt)) continue;
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) continue;
        // `[...] as const`, and `[...] as const satisfies readonly Caveat[]` — this codebase uses
        // the second form to couple a runtime array to a type, so both wrappers have to come off.
        let init: ts.Expression = decl.initializer;
        while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init)) init = init.expression;
        if (!ts.isArrayLiteralExpression(init)) continue;
        const values = init.elements.filter(ts.isStringLiteral).map((e) => e.text);
        if (values.length === init.elements.length && values.length > 0) {
          out.set(decl.name.text, values);
        }
      }
    }
  }
  return out;
}

const constArrays = collectConstArrays([...FILES, ...CROSS_PACKAGE]);

/** `ReportValidity["reliability"]` — resolve the member out of the referenced declaration. */
function indexedAccess(node: ts.IndexedAccessTypeNode, at: string): ts.TypeNode {
  if (!ts.isTypeReferenceNode(node.objectType) || !ts.isIdentifier(node.objectType.typeName)) {
    throw new UnsupportedType("an indexed access on a non-reference", at);
  }
  const target = declarations.get(node.objectType.typeName.text);
  if (target === undefined || !ts.isTypeLiteralNode(target)) {
    throw new UnsupportedType(`an indexed access into ${node.objectType.typeName.text}`, at);
  }
  if (!ts.isLiteralTypeNode(node.indexType) || !ts.isStringLiteral(node.indexType.literal)) {
    throw new UnsupportedType("an indexed access by a non-literal", at);
  }
  const wanted = node.indexType.literal.text;
  for (const member of target.members) {
    if (!ts.isPropertySignature(member) || member.type === undefined) continue;
    const name = member.name;
    const text = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : "";
    if (text === wanted) return member.type;
  }
  throw new UnsupportedType(`an indexed access to a missing member ${wanted}`, at);
}

const PRIMITIVES = new Map<ts.SyntaxKind, string>([
  [ts.SyntaxKind.StringKeyword, "string"],
  [ts.SyntaxKind.NumberKeyword, "number"],
  [ts.SyntaxKind.BooleanKeyword, "boolean"],
]);

function schemaFor(node: ts.TypeNode, at: string): Schema {
  if (ts.isParenthesizedTypeNode(node)) return schemaFor(node.type, at);

  // `readonly T[]`
  if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword) {
    return schemaFor(node.type, at);
  }

  if (ts.isArrayTypeNode(node)) {
    return { type: "array", items: schemaFor(node.elementType, `${at}[]`) };
  }

  const primitive = PRIMITIVES.get(node.kind);
  if (primitive !== undefined) return { type: primitive };

  if (ts.isLiteralTypeNode(node)) {
    const literal = node.literal;
    if (ts.isStringLiteral(literal)) return { const: literal.text };
    if (ts.isNumericLiteral(literal)) return { const: Number(literal.text) };
    if (literal.kind === ts.SyntaxKind.NullKeyword) return { type: "null" };
    if (literal.kind === ts.SyntaxKind.TrueKeyword) return { const: true };
    if (literal.kind === ts.SyntaxKind.FalseKeyword) return { const: false };
    throw new UnsupportedType("an unrecognised literal", at);
  }

  if (ts.isUnionTypeNode(node)) {
    const parts = node.types.filter((t) => t.kind !== ts.SyntaxKind.UndefinedKeyword);
    const subs = parts.map((t) => schemaFor(t, at));
    // A union of string literals is an ENUM, which is the shape a consumer actually branches on.
    if (subs.every((s) => typeof s.const === "string")) {
      return { type: "string", enum: subs.map((s) => s.const) };
    }
    // `number | null` and friends collapse to a type list rather than a noisy anyOf.
    if (subs.every((s) => typeof s.type === "string" && Object.keys(s).length === 1)) {
      return { type: subs.map((s) => s.type) };
    }
    return { anyOf: subs };
  }

  if (ts.isTypeLiteralNode(node)) return objectSchema(node, at);

  // `RunEvent = RunEventInput & Base` — a union of event shapes, each of which also carries the
  // base fields. MERGED rather than emitted as `allOf`, because every part sets
  // `additionalProperties: false`, and an allOf of closed objects rejects every document: each part
  // would refuse the other's properties. Merging distributes the base over each variant, which is
  // what the type means and what a consumer needs to validate one line of the stream.
  if (ts.isIntersectionTypeNode(node)) {
    const parts = node.types.map((t) => schemaFor(t, at));
    const variants = parts.filter((p) => Array.isArray(p.anyOf));
    const plain = parts.filter((p) => !Array.isArray(p.anyOf));
    const mergeInto = (target: Schema, extra: Schema): Schema => ({
      type: "object",
      additionalProperties: false,
      required: [
        ...new Set([
          ...((target.required as string[] | undefined) ?? []),
          ...((extra.required as string[] | undefined) ?? []),
        ]),
      ],
      properties: {
        ...((target.properties as Record<string, Schema> | undefined) ?? {}),
        ...((extra.properties as Record<string, Schema> | undefined) ?? {}),
      },
    });
    const base = plain.reduce<Schema>((acc, p) => mergeInto(acc, p), {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {},
    });
    if (variants.length === 0) return base;
    if (variants.length > 1) {
      throw new UnsupportedType("an intersection of several unions", at);
    }
    const [only] = variants;
    const anyOf = (only?.anyOf as Schema[]) ?? [];
    return { anyOf: anyOf.map((variant) => mergeInto(variant, base)) };
  }

  if (ts.isIndexedAccessTypeNode(node)) {
    // `(typeof BASELINE_CLASSIFICATIONS)[number]` — the closed set is the runtime array. The
    // parentheses are part of the syntax, so unwrap before testing for the typeof query.
    const objectType = ts.isParenthesizedTypeNode(node.objectType)
      ? node.objectType.type
      : node.objectType;
    if (ts.isTypeQueryNode(objectType) && ts.isIdentifier(objectType.exprName)) {
      const values = constArrays.get(objectType.exprName.text);
      if (values === undefined) {
        throw new UnsupportedType(`a typeof over ${objectType.exprName.text}`, at);
      }
      return { type: "string", enum: values };
    }
    return schemaFor(indexedAccess(node, at), at);
  }

  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    const name = node.typeName.text;
    // `Readonly<X>` is transparent; `Record<string, V>` becomes an open map of V.
    if (name === "Readonly" && node.typeArguments?.[0] !== undefined) {
      return schemaFor(node.typeArguments[0], at);
    }
    if (name === "ReadonlyArray" || name === "Array") {
      const item = node.typeArguments?.[0];
      if (item === undefined) throw new UnsupportedType(`${name} without an item type`, at);
      return { type: "array", items: schemaFor(item, `${at}[]`) };
    }
    if (name === "Record" || name === "ReadonlyMap") {
      const value = node.typeArguments?.[1];
      if (value === undefined) throw new UnsupportedType(`${name} without a value type`, at);
      return { type: "object", additionalProperties: schemaFor(value, `${at}.*`) };
    }
    const declared = declarations.get(name);
    if (declared === undefined) throw new UnsupportedType(`the unresolved reference ${name}`, at);
    return schemaFor(declared, at);
  }

  throw new UnsupportedType(ts.SyntaxKind[node.kind] ?? "an unknown node", at);
}

function objectSchema(node: ts.TypeLiteralNode, at: string): Schema {
  const properties: Record<string, Schema> = {};
  const required: string[] = [];
  for (const member of node.members) {
    if (!ts.isPropertySignature(member) || member.type === undefined) continue;
    const name = member.name;
    if (!ts.isIdentifier(name) && !ts.isStringLiteral(name)) continue;
    properties[name.text] = schemaFor(member.type, `${at}.${name.text}`);
    if (member.questionToken === undefined) required.push(name.text);
  }
  return {
    type: "object",
    additionalProperties: false,
    ...(required.length > 0 ? { required } : {}),
    properties,
  };
}

/** Pin a version property to the constant this build emits. The type says `number` — correct for
 *  the type, and useless in a schema whose FILENAME claims a version: a v2 schema that accepts a v3
 *  document tells a consumer nothing. */
function pinVersion(schema: Schema, property: string, version: number): Schema {
  const properties = schema.properties as Record<string, Schema> | undefined;
  const target = properties?.[property];
  if (target === undefined) throw new Error(`generate-schemas: no ${property} to pin`);
  target.const = version;
  return schema;
}

function build(root: string, id: string, title: string, description: string): Schema {
  const declared = declarations.get(root);
  if (declared === undefined) throw new Error(`generate-schemas: no declaration for ${root}`);
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `https://github.com/SShadowS/LethAL/blob/master/schemas/${id}`,
    title,
    description,
    ...schemaFor(declared, "$"),
  };
}

const targets = [
  {
    file: "report-v2.schema.json",
    schema: pinVersion(
      build(
        "SessionReport",
        "report-v2.schema.json",
        "LethAL session report",
        "The JSON report a run writes with --out. GENERATED from the SessionReport TypeScript declaration by scripts/generate-schemas.ts — edit the type, not this file. It describes the shape THIS build writes: additive fields do not bump schemaVersion, so a report written by an older build of the same version can lack a property this schema requires. Read `validity` before quoting `mutationScore`.",
      ),
      "schemaVersion",
      REPORT_SCHEMA_VERSION,
    ),
  },
  {
    file: "stream-v1.schema.json",
    schema: build(
      "RunEvent",
      "stream-v1.schema.json",
      "LethAL run event",
      "One line of the NDJSON stream written with --progress-out, excluding the header line the sink writes first (which carries ndjsonHeader: true and no seq). Versioned by streamSchemaVersion. EVERY verdict-carrying line is PROVISIONAL until a session-finished event: a later batch-invalidated can supersede it. Unknown event types are ignored by design. GENERATED by scripts/generate-schemas.ts.",
    ),
  },
];

const check = process.argv.includes("--check");
let stale = 0;
for (const { file, schema } of targets) {
  const path = join(SCHEMAS, file);
  const text = `${JSON.stringify(schema, null, 2)}\n`;
  const current = (() => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  })();
  if (check) {
    if (current !== text) {
      console.error(
        `STALE: ${file} does not match the TypeScript declaration it is generated from`,
      );
      stale += 1;
    } else {
      console.log(`ok: ${file}`);
    }
    continue;
  }
  writeFileSync(path, text, "utf8");
  console.log(
    `wrote ${file} (${Object.keys(schema.properties ?? {}).length} top-level properties)`,
  );
}
if (check && stale > 0) {
  console.error(
    `\n${stale} schema(s) are stale. Run \`bun scripts/generate-schemas.ts\` and commit the result — a published schema that has drifted calls a correct document invalid at every consumer.`,
  );
  process.exit(1);
}
