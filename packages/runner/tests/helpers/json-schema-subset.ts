/**
 * The tests' one JSON Schema validator (PR-148 merged R870's envelope validator into `schemas.test.ts`'s
 * `conformsTo`, the stricter of the two, and deleted the other).
 *
 * It is a deliberately small validator, not a JSON Schema implementation: the keywords in
 * `KNOWN_KEYWORDS` and local `#/$defs/<name>` refs. Any other keyword throws (a skipped keyword would
 * make every document "conform" to that rule), and `schemaKeywordsUnknown` finds one at any node of a
 * schema, reached by a document or not. If a schema needs more, add the dependency rather than grow this.
 */

export type Schema = Record<string, unknown>;

export interface Violation {
  readonly path: string;
  readonly problem: string;
}

/** Resolves a local `#/$defs/x` pointer. Anything else throws: a schema reaching outside this file
 *  would make the leaf walk and the validator quietly incomplete. */
export function deref(root: Schema, node: Schema): Schema {
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
 * PR-147: every keyword `conformsTo` handles or may ignore (annotations). Any other keyword throws: a
 * keyword it silently skipped would make every document "conform" to that rule (minimum, pattern,
 * oneOf, propertyNames and minLength were skipped until PR-147). The throw sees only the nodes a
 * document reaches, so `schemaKeywordsUnknown` walks every node of every schema file as well.
 */
export const KNOWN_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "$ref",
  "anyOf",
  "oneOf",
  "minItems",
  "minimum",
  "minLength",
  "pattern",
  "propertyNames",
  // annotations, nothing to check
  "description",
  "title",
  "$schema",
  "$id",
  "$defs",
]);

/** PR-147 (review 1): every keyword outside KNOWN_KEYWORDS, at any node of `schema`, reached or not. */
export function schemaKeywordsUnknown(schema: unknown, at = "$", out: string[] = []): string[] {
  if (schema === null || typeof schema !== "object") return out;
  if (Array.isArray(schema)) {
    schema.forEach((s, i) => schemaKeywordsUnknown(s, `${at}[${i}]`, out));
    return out;
  }
  for (const [k, v] of Object.entries(schema)) {
    if (!KNOWN_KEYWORDS.has(k)) out.push(`${at}.${k}`);
    if (k === "properties" || k === "$defs")
      for (const [name, sub] of Object.entries(v as object))
        schemaKeywordsUnknown(sub, `${at}.${k}.${name}`, out);
    else if (["items", "additionalProperties", "propertyNames", "anyOf", "oneOf"].includes(k))
      schemaKeywordsUnknown(v, `${at}.${k}`, out);
  }
  return out;
}

/** The problems with `value` under `node` (default the root); empty when it conforms. */
export function conformsTo(
  root: Schema,
  value: unknown,
  node: Schema = root,
  path = "$",
): Violation[] {
  const schema = deref(root, node);
  const out: Violation[] = [];
  const unknownKeyword = Object.keys(schema).find((k) => !KNOWN_KEYWORDS.has(k));
  if (unknownKeyword !== undefined) {
    throw new Error(
      `conformsTo: schema keyword "${unknownKeyword}" at ${path} is not implemented; implement it rather than pass every document (PR-147)`,
    );
  }
  // PR-147: oneOf — exactly one branch.
  const oneOf = schema.oneOf as Schema[] | undefined;
  if (oneOf !== undefined) {
    const passing = oneOf.filter((branch) => conformsTo(root, value, branch, path).length === 0);
    if (passing.length !== 1) {
      out.push({ path, problem: `matches ${passing.length} branches of oneOf, not exactly 1` });
    }
  }
  if (typeof value === "number" && typeof schema.minimum === "number" && value < schema.minimum) {
    out.push({ path, problem: `${value} is below the minimum ${schema.minimum}` });
  }
  if (typeof value === "string") {
    // code points, as JSON Schema counts them
    if (typeof schema.minLength === "number" && [...value].length < schema.minLength) {
      out.push({ path, problem: `shorter than ${schema.minLength} character(s)` });
    }
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) {
      out.push({ path, problem: `${JSON.stringify(value)} does not match ${schema.pattern}` });
    }
  }

  if (schema.const !== undefined && value !== schema.const) {
    out.push({ path, problem: `expected const ${JSON.stringify(schema.const)}` });
  }
  // `anyOf` — the stream's root is a union of event shapes, and a validator that ignored it would
  // return [] for EVERY document against that schema: the empty-vs-empty pass these tests exist to
  // prevent. Sibling keywords must hold too (PR-147 review 2), so a passing branch keeps `out`.
  const anyOf = schema.anyOf as Schema[] | undefined;
  if (anyOf !== undefined) {
    const branches = anyOf.map((branch) => conformsTo(root, value, branch, path));
    if (!branches.some((v) => v.length === 0)) {
      const best = branches.reduce((a, b) => (a.length <= b.length ? a : b));
      out.push({
        path,
        problem: `matches no branch of anyOf; closest complaint: ${best[0]?.problem ?? "?"}`,
      });
    }
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
    const names = schema.propertyNames as Schema | undefined;
    for (const [key, entry] of Object.entries(record)) {
      // PR-147: propertyNames — every key against its schema
      if (names !== undefined) out.push(...conformsTo(root, key, names, `${path}.${key} (name)`));
      const child = properties[key];
      if (child === undefined) {
        if (schema.additionalProperties === false) {
          out.push({ path: `${path}.${key}`, problem: "not described by the schema" });
        } else if (
          typeof schema.additionalProperties === "object" &&
          schema.additionalProperties !== null
        ) {
          // PR-147: an additionalProperties schema checks every undeclared key's value
          out.push(
            ...conformsTo(root, entry, schema.additionalProperties as Schema, `${path}.${key}`),
          );
        }
        continue;
      }
      out.push(...conformsTo(root, entry, child, `${path}.${key}`));
    }
  }
  return out;
}
