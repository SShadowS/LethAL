import { parseSymbolReferenceJson, readPackageEntry } from "./app-package";
import { symbolPackageIdentity, unwrapSymbolPackage } from "./published-test-app";

/** PR-128 (R1110): one table field that declares `OptimizeForTextSearch`. */
export interface TextSearchField {
  readonly table: string;
  readonly field: string;
}

/** A package that declares at least one such field, with its identity. */
export interface TextSearchApp {
  readonly id: string;
  readonly name: string;
  readonly publisher: string;
  readonly version: string;
  readonly fields: readonly TextSearchField[];
}

const isOn = (v: unknown): boolean =>
  !(typeof v === "string" && ["0", "false"].includes(v.toLowerCase())) && v !== false && v !== 0;

function walk(scope: Record<string, unknown>, out: TextSearchField[]): void {
  for (const key of ["Tables", "TableExtensions"]) {
    const objects = scope[key];
    if (!Array.isArray(objects)) continue;
    for (const obj of objects as Record<string, unknown>[]) {
      const fields = obj?.Fields;
      if (!Array.isArray(fields)) continue;
      for (const f of fields as Record<string, unknown>[]) {
        const props = Array.isArray(f?.Properties)
          ? (f.Properties as Record<string, unknown>[])
          : [];
        const hit = props.some(
          (p) =>
            typeof p?.Name === "string" &&
            p.Name.toLowerCase() === "optimizefortextsearch" &&
            isOn(p.Value),
        );
        if (hit) out.push({ table: String(obj.Name), field: String(f.Name) });
      }
    }
  }
  if (Array.isArray(scope.Namespaces)) {
    for (const child of scope.Namespaces) {
      if (child !== null && typeof child === "object") walk(child as Record<string, unknown>, out);
    }
  }
}

/**
 * The table fields a package's `SymbolReference.json` declares with `OptimizeForTextSearch`, at any
 * namespace depth. Reads through a Ready-to-Run wrapper. `undefined` when the package has no
 * `SymbolReference.json` (nothing to say); a corrupt one throws.
 */
export function textSearchFields(bytes: Buffer): readonly TextSearchField[] | undefined {
  const entry = readPackageEntry(unwrapSymbolPackage(bytes), "SymbolReference.json");
  if (entry === null) return undefined;
  const json = parseSymbolReferenceJson(entry);
  const out: TextSearchField[] = [];
  if (json !== null && typeof json === "object") walk(json as Record<string, unknown>, out);
  return out;
}

/** The package as a `TextSearchApp`, or `undefined` when it declares no such field. */
export function textSearchApp(bytes: Buffer): TextSearchApp | undefined {
  const fields = textSearchFields(bytes);
  if (fields === undefined || fields.length === 0) return undefined;
  return { ...symbolPackageIdentity(bytes), fields };
}

/** One cached package as doctor's closure scan sees it. `fields` is undefined: no SymbolReference.json. */
export interface CachedPackage {
  readonly id: string;
  readonly name: string;
  readonly publisher: string;
  readonly version: string;
  /** The manifest's `<Dependency Id MinVersion>` entries. */
  readonly deps: readonly { readonly id: string; readonly version: string }[];
  readonly fields: readonly TextSearchField[] | undefined;
}

/** Identity, manifest dependencies and text-search fields of a package (through a Ready-to-Run wrapper). */
export function readCachedPackage(bytes: Buffer): CachedPackage {
  const inner = unwrapSymbolPackage(bytes);
  const manifest = readPackageEntry(inner, "NavxManifest.xml")?.toString("utf8") ?? "";
  const deps = [...manifest.matchAll(/<Dependency\b[^>]*>/g)].flatMap((m) => {
    const attr = (k: string) => new RegExp(`\\s${k}="([^"]*)"`).exec(m[0])?.[1];
    const id = attr("Id");
    return id === undefined ? [] : [{ id, version: attr("MinVersion") ?? "0.0.0.0" }];
  });
  return { ...symbolPackageIdentity(inner), deps, fields: textSearchFields(inner) };
}

/** The most field names one note lists. */
const MAX_FIELDS_IN_NOTE = 5;

/** The note `lethal doctor` and `bc-continia-publish --predict` print for one such app. */
export function textSearchNote(app: TextSearchApp): string {
  const shown = app.fields.slice(0, MAX_FIELDS_IN_NOTE).map((f) => `${f.table}.${f.field}`);
  const more = app.fields.length - shown.length;
  const where = shown.join(", ") + (more > 0 ? ` ... and ${more} more` : "");
  return `${app.publisher} ${app.name} ${app.version} (${app.id}) declares OptimizeForTextSearch on ${where}: installing it needs SQL Server Full-Text Search on the server's SQL Server; LethAL cannot read whether it is there; without it the publish fails with HTTP 422 'Text optimized index cannot be created'`;
}
