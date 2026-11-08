/**
 * R870: a JSON Schema validator for exactly the keywords the bc-toolbox envelope schema uses. The
 * shared one in `schemas.test.ts` has no `oneOf`, `pattern` or `propertyNames`. `KEYWORDS` is what
 * this one knows, so a test can refuse a schema that uses any other: an ignored keyword would pass
 * whatever it was meant to stop.
 */
export const KEYWORDS = new Set([
  "$schema",
  "oneOf",
  "type",
  "const",
  "enum",
  "pattern",
  "minLength",
  "properties",
  "required",
  "additionalProperties",
  "propertyNames",
  "items",
  "minItems",
]);

type Schema = Readonly<Record<string, unknown>>;

/** Every keyword a schema uses, at any depth, that this validator does not know. */
export function unknownKeywords(schema: unknown): string[] {
  const out = new Set<string>();
  const walk = (s: unknown) => {
    if (s === null || typeof s !== "object" || Array.isArray(s)) return;
    for (const [k, v] of Object.entries(s)) {
      if (!KEYWORDS.has(k)) out.add(k);
      if (k === "properties") for (const p of Object.values(v as object)) walk(p);
      else if (k === "oneOf") for (const b of v as unknown[]) walk(b);
      else if (k === "items" || k === "propertyNames" || k === "additionalProperties") walk(v);
    }
  };
  walk(schema);
  return [...out];
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

/** The problems with `value` under `schema`; empty when it conforms. */
export function violations(schema: Schema, value: unknown, path = "$"): string[] {
  const out: string[] = [];
  if (Array.isArray(schema.oneOf)) {
    const passing = (schema.oneOf as Schema[]).filter(
      (b) => violations(b, value, path).length === 0,
    );
    if (passing.length !== 1)
      out.push(`${path}: matches ${passing.length} branches of oneOf, not 1`);
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const t = typeOf(value);
    if (!types.includes(t) && !(t === "integer" && types.includes("number"))) {
      out.push(`${path}: is ${t}, not ${types.join("|")}`);
      return out;
    }
  }
  if ("const" in schema && value !== schema.const)
    out.push(`${path}: is not ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) out.push(`${path}: not in enum`);
  if (typeof value === "string") {
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) {
      out.push(`${path}: does not match ${schema.pattern}`);
    }
    if (typeof schema.minLength === "number" && [...value].length < schema.minLength) {
      out.push(`${path}: shorter than ${schema.minLength}`);
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      out.push(`${path}: fewer than ${schema.minItems} items`);
    }
    if (schema.items !== undefined) {
      value.forEach((v, i) => {
        out.push(...violations(schema.items as Schema, v, `${path}[${i}]`));
      });
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    for (const r of (schema.required ?? []) as string[]) {
      if (!(r in obj)) out.push(`${path}: missing ${r}`);
    }
    for (const [k, v] of Object.entries(obj)) {
      const p = props[k];
      if (schema.propertyNames !== undefined)
        out.push(...violations(schema.propertyNames as Schema, k, `${path}.${k}(name)`));
      if (p !== undefined) out.push(...violations(p, v, `${path}.${k}`));
      else if (schema.additionalProperties === false) out.push(`${path}: unexpected property ${k}`);
      else if (
        typeof schema.additionalProperties === "object" &&
        schema.additionalProperties !== null
      ) {
        out.push(...violations(schema.additionalProperties as Schema, v, `${path}.${k}`));
      }
    }
  }
  return out;
}
