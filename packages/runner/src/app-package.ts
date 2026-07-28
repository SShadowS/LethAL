import { readFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

/**
 * Minimal ZIP-central-directory reader for extracting one named entry from a
 * compiled AL `.app` package.
 *
 * `.app` files are a NAV/BC-specific header PREPENDED to a standard ZIP
 * archive (`file(1)` on a compiled fixture app reports "Zip archive, with
 * extra data prepended" — verified 2026-07-18) — the End Of Central
 * Directory record must be located by scanning backward from the end of the
 * file, and every offset the central directory stores is relative to where
 * the zip portion actually starts, not byte 0 of the `.app` file. This is
 * the same "self-extracting archive" adjustment every general-purpose zip
 * reader (Python's `zipfile`, `unzip`, .NET's `ZipFile`) applies automatically.
 *
 * Deliberately hand-rolled instead of adding a zip dependency: only one
 * small, known-by-name entry (`SymbolReference.json`) is ever read, from a
 * package we just compiled ourselves.
 */
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const CENTRAL_DIR_FIXED_SIZE = 46;
const LOCAL_HEADER_FIXED_SIZE = 30;
const MAX_COMMENT_SIZE = 65535;

function findEndOfCentralDirectory(buf: Buffer): number {
  const start = Math.max(0, buf.length - EOCD_MIN_SIZE - MAX_COMMENT_SIZE);
  for (let i = buf.length - EOCD_MIN_SIZE; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new Error("not a zip archive: no End Of Central Directory record found");
}

/** Reads and inflates one named entry from a zip (or zip-with-prepended-header) archive. */
function extractZipEntry(buf: Buffer, entryName: string): Buffer {
  const eocdPos = findEndOfCentralDirectory(buf);
  const centralDirSize = buf.readUInt32LE(eocdPos + 12);
  const centralDirOffsetRaw = buf.readUInt32LE(eocdPos + 16);
  // Bytes prepended before the zip portion actually begins (0 for a plain zip).
  const baseOffset = eocdPos - centralDirSize - centralDirOffsetRaw;

  let pos = baseOffset + centralDirOffsetRaw;
  const centralDirEnd = pos + centralDirSize;
  while (pos < centralDirEnd) {
    if (buf.readUInt32LE(pos) !== CENTRAL_DIR_SIGNATURE) {
      throw new Error(`corrupt zip central directory at offset ${pos}`);
    }
    const compressionMethod = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localHeaderOffsetRaw = buf.readUInt32LE(pos + 42);
    const name = buf.toString(
      "utf8",
      pos + CENTRAL_DIR_FIXED_SIZE,
      pos + CENTRAL_DIR_FIXED_SIZE + nameLen,
    );

    if (name === entryName) {
      const localPos = baseOffset + localHeaderOffsetRaw;
      if (buf.readUInt32LE(localPos) !== LOCAL_HEADER_SIGNATURE) {
        throw new Error(`corrupt zip local file header for ${entryName}`);
      }
      const localNameLen = buf.readUInt16LE(localPos + 26);
      const localExtraLen = buf.readUInt16LE(localPos + 28);
      const dataStart = localPos + LOCAL_HEADER_FIXED_SIZE + localNameLen + localExtraLen;
      const compressed = buf.subarray(dataStart, dataStart + compressedSize);
      if (compressionMethod === 0) return Buffer.from(compressed); // stored, no compression
      if (compressionMethod === 8) return inflateRawSync(compressed); // deflate
      throw new Error(`unsupported zip compression method ${compressionMethod} for ${entryName}`);
    }

    pos += CENTRAL_DIR_FIXED_SIZE + nameLen + extraLen + commentLen;
  }
  throw new Error(`zip entry not found: ${entryName}`);
}

// WIRE: ObjectTypeWrapper values, matching bc-dev-mcp's AL_OBJECT_TYPE (tw-decomp
// ObjectTypeWrapper.cs) — coverage entries report these same integers for objectType.
const OBJECT_TYPE_NAME: Record<number, string> = {
  1: "Table",
  3: "Report",
  5: "Codeunit",
  6: "XmlPort",
  8: "Page",
  9: "Query",
  // MEASURED against a live BC 28 server (2026-07-27,
  // `docs/measurements/tableextension-coverage-probe.al`), not read from documentation: a probe
  // exercising a tableextension's and a pageextension's own procedures came back as `15:<id>` and
  // `14:<id>`, under each EXTENSION's own object id rather than the base object's. Without these
  // two entries `objectTypeName` fell through to `String(objectType)`, so coverage keyed
  // `"15:79481"` while the mutant manifest keyed `"tableextension:79481"` — the two never matched
  // and every extension mutant would have been reported `no-coverage`.
  14: "PageExtension",
  15: "TableExtension",
};

// SymbolReference.json top-level arrays that carry {Id, Name, Methods: [{Id, Name}]}
// entries, keyed by the numeric object type they correspond to.
const SYMBOL_ARRAYS: ReadonlyArray<{ key: string; objectType: number }> = [
  { key: "Tables", objectType: 1 },
  { key: "Reports", objectType: 3 },
  { key: "Codeunits", objectType: 5 },
  { key: "XmlPorts", objectType: 6 },
  { key: "Pages", objectType: 8 },
  { key: "Queries", objectType: 9 },
];

/**
 * The arrays above PLUS the two extension kinds — every SymbolReference.json array that declares an
 * object carrying a numeric id, which is what `declaredObjects()` scopes R58's line map by.
 *
 * MEASURED 2026-07-28, not assumed: a probe project with one `tableextension` and one
 * `pageextension` compiled offline by `alc` 18.0.38.8509 writes `TableExtensions` and
 * `PageExtensions` arrays, shaped exactly like the rest (`Id`, `Name`, `Methods`) plus a
 * `TargetObject`. Guessing the names was not an option: an array named wrong means the extension is
 * silently NOT declared, its fenced coverage rows are skipped, and every mutant in it reports
 * `no-coverage` — a quiet loss with no error anywhere.
 *
 * Deliberately SEPARATE from `SYMBOL_ARRAYS` rather than merged into it: `SYMBOL_ARRAYS` feeds
 * `AppMethodIndex.lookup`, which the HUB path uses to name a coverage `methodId`, and adding the
 * extension arrays there would change hub attribution for extension objects (today they fall
 * through to `findLocalProcedureNames`). That is a real gap — filed as its own roadmap item — but
 * it is not R58's, and moving it under cover of this change would make the differential gate
 * compare two things at once.
 */
const DECLARED_OBJECT_ARRAYS: ReadonlyArray<{ key: string; objectType: number }> = [
  ...SYMBOL_ARRAYS,
  { key: "PageExtensions", objectType: 14 },
  { key: "TableExtensions", objectType: 15 },
];

interface SymbolMethod {
  readonly Id: number;
  readonly Name: string;
}

interface SymbolObject {
  readonly Id: number;
  readonly Name: string;
  readonly Methods?: readonly SymbolMethod[];
}

/**
 * Resolves `(objectType, objectId, methodId)` — the identifiers bc-dev-mcp's
 * `bcdev_test_run` coverage payload reports — to a human-readable procedure
 * name and object-type label.
 *
 * The BC coverage wire protocol (verified against a real server, 2026-07-18)
 * reports numeric `methodId`s only (e.g. `-352596841`), not names — these
 * are NOT small sequential/declaration-order ids and are NOT safely
 * guessable (they looked like process-random hash values until compared
 * against the compiled app itself). They turned out to be exactly the `Id`
 * fields the AL compiler assigns each method in the package's own
 * `SymbolReference.json` (confirmed byte-for-byte against a real compiled
 * fixture .app) — a stable identifier baked in at compile time, extractable
 * locally from the same .app `ArtifactCompiler.compile()` just produced, with no
 * extra server round-trip.
 */
export class AppMethodIndex {
  private readonly byKey = new Map<string, string>();
  private readonly declared = new Set<string>();

  private constructor() {}

  static fromSymbolReference(json: unknown): AppMethodIndex {
    const index = new AppMethodIndex();
    const root = json as Record<string, unknown>;
    for (const { key, objectType } of SYMBOL_ARRAYS) {
      const objects = root[key] as SymbolObject[] | undefined;
      for (const obj of objects ?? []) {
        for (const method of obj.Methods ?? []) {
          index.byKey.set(`${objectType}:${obj.Id}:${method.Id}`, method.Name);
        }
      }
    }
    for (const { key, objectType } of DECLARED_OBJECT_ARRAYS) {
      const objects = root[key] as SymbolObject[] | undefined;
      for (const obj of objects ?? []) {
        if (typeof obj.Id !== "number") continue;
        index.declared.add(`${objectTypeName(objectType).toLowerCase()}:${obj.Id}`);
      }
    }
    return index;
  }

  /**
   * The `(objectType, objectId)` pairs THIS artifact declares, keyed `"<lowercase type>:<id>"` —
   * the same key `line-map.ts` builds, so the two can be compared directly.
   *
   * R58's scope rule. `CoverageArray` serializes the ENTIRE `Code Coverage` table (Base App, System
   * App, Test Runner, the test app, Continia Core, LethAL's own control codeunits), so the fenced
   * path needs a hard answer to "is this row from the artifact we compiled?" before it dares name a
   * procedure. The compiled package's own symbol reference is that answer — and it is the reason
   * the map must NOT be built by walking the batch dir: `prepareBatchProject` deliberately copies
   * Document Output's 137 `.dependencies` sources (R39), whose objects are published by their OWN
   * apps, and naming a member from that copied text would be R29 with extra steps.
   */
  declaredObjects(): ReadonlySet<string> {
    return this.declared;
  }

  static async fromAppFile(appPath: string): Promise<AppMethodIndex> {
    const buf = await readFile(appPath);
    const symbolReferenceBytes = extractZipEntry(buf, "SymbolReference.json");
    // AL writes SymbolReference.json with a UTF-8 BOM — strip it before JSON.parse.
    let text = symbolReferenceBytes.toString("utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return AppMethodIndex.fromSymbolReference(JSON.parse(text));
  }

  /** Undefined when the object/method isn't in this app's own symbol reference
   * (e.g. platform/base-app code incidentally covered) — callers should skip it. */
  lookup(objectType: number, objectId: number, methodId: number): string | undefined {
    return this.byKey.get(`${objectType}:${objectId}:${methodId}`);
  }
}

const warnedUnknownObjectTypes = new Set<number>();

/**
 * BC's numeric object type -> the name coverage keys are built from.
 *
 * An unmapped type still falls back to its number rather than throwing — aborting a run over an
 * object kind that merely APPEARS in coverage would be worse than the gap. But it now warns once
 * per type, because the silent version of this fallback is exactly what hid the extension defect:
 * coverage keyed `"15:79481"` against a manifest keying `"tableextension:79481"`, which is
 * indistinguishable from "nothing covered this object" at every downstream layer.
 */
export function objectTypeName(objectType: number): string {
  const name = OBJECT_TYPE_NAME[objectType];
  if (name !== undefined) return name;
  if (!warnedUnknownObjectTypes.has(objectType)) {
    warnedUnknownObjectTypes.add(objectType);
    console.warn(
      `[lethal] coverage reported unmapped BC object type ${objectType}; its entries key as "${objectType}:<id>" and will not match a mutant manifest that names the kind. Add it to OBJECT_TYPE_NAME (measure it — see docs/measurements/).`,
    );
  }
  return String(objectType);
}
