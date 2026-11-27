/**
 * PR-476 (R1234): builds an INVENTED NAVX package in test code: a 40-byte header (package id at
 * 12..27, the zip's length at 28..35) in front of a zip whose entries are deflated at a chosen level
 * and carry a chosen entry time. Two builds of the same entries that differ only in `id`, `level`,
 * `time` (and the manifest's Build Timestamp value) are what two alc compiles of unchanged source look
 * like. The zip's CRC is left 0, as `buildFakeAppWithEntries` does: the readers never check it.
 */
import { deflateRawSync } from "node:zlib";

export interface NavxOptions {
  /** The package id byte, filled across header bytes 12..27. */
  readonly id?: number;
  /** Deflate level 0-9, or `"stored"` for method 0. */
  readonly level?: number | "stored";
  /** The zip entries' DOS time field. */
  readonly time?: number;
  /** Bytes appended after the zip's end-of-central-directory as its comment (changes the length). */
  readonly comment?: string;
  /** Entry names in this order (the central directory keeps it); default the given order. */
  readonly entries: readonly (readonly [string, string | Buffer])[];
}

export function zipOf(o: NavxOptions): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const level = o.level ?? "stored";
  for (const [entryName, content] of o.entries) {
    const name = Buffer.from(entryName, "utf8");
    const data = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const method = level === "stored" ? 0 : 8;
    const body = level === "stored" ? data : deflateRawSync(data, { level });
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(o.time ?? 0, 10);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(o.time ?? 0, 12);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    const section = Buffer.concat([local, body]);
    offset += section.length;
    locals.push(section);
    centrals.push(central);
  }
  const localBytes = Buffer.concat(locals);
  const centralBytes = Buffer.concat(centrals);
  const comment = Buffer.from(o.comment ?? "", "latin1");
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(centrals.length, 8);
  eocd.writeUInt16LE(centrals.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(localBytes.length, 16);
  eocd.writeUInt16LE(comment.length, 20);
  return Buffer.concat([localBytes, centralBytes, eocd, comment]);
}

/** A zip behind the 40-byte NAVX header, as `hashPackage` knows it. */
export function navxWrap(zip: Buffer, id: number): Buffer {
  const h = Buffer.alloc(40);
  h.write("NAVX", 0, "latin1");
  h.writeUInt32LE(40, 4);
  h.writeUInt32LE(2, 8);
  h.fill(id, 12, 28);
  h.writeBigUInt64LE(BigInt(zip.length), 28);
  h.write("NAVX", 36, "latin1");
  return Buffer.concat([h, zip]);
}

export function navxPackage(o: NavxOptions): Buffer {
  return navxWrap(zipOf(o), o.id ?? 1);
}

export interface ManifestOptions {
  readonly version?: string;
  readonly timestamp?: string;
  /** Extra attributes on the `<Build>` element, as written. */
  readonly buildAttrs?: string;
  readonly compilerVersion?: string;
  /** Replaces the whole `<Build .../>` element text (for the scope tests). */
  readonly build?: string;
  /** Extra text inside `<Package>` after `<App>`. */
  readonly extra?: string;
  readonly appAttrs?: string;
  readonly name?: string;
  readonly id?: string;
  readonly publisher?: string;
  readonly dependencyVersion?: string;
  readonly runtime?: string;
}

/** An invented `NavxManifest.xml`. Every field a test varies has its own option. */
export function manifestOf(o: ManifestOptions = {}): string {
  const build =
    o.build ??
    `<Build Timestamp="${o.timestamp ?? "2026-11-27T10:00:00.1234567Z"}" CompilerVersion="${o.compilerVersion ?? "17.0.1.2"}"${o.buildAttrs ?? ""} />`;
  return `<?xml version="1.0" encoding="utf-8"?><Package xmlns="http://schemas.microsoft.com/navx/2015/manifest"><App Id="${o.id ?? "11111111-2222-3333-4444-555555555555"}" Name="${o.name ?? "Invented Tests"}" Publisher="${o.publisher ?? "Invented"}" Version="${o.version ?? "1.0.0.3"}" Runtime="${o.runtime ?? "17.0"}"${o.appAttrs ?? ""} /><Dependencies><Dependency Id="99999999-8888-7777-6666-555555555555" Name="Dep" Publisher="Invented" MinVersion="${o.dependencyVersion ?? "1.0.0.0"}" /></Dependencies>${build}${o.extra ?? ""}</Package>`;
}

/**
 * Two NAVX packages with the SAME content and different bytes: another package id, and another time
 * on the first zip entry. Their `appContentIdentity` is equal and their `hashPackage` differs, which
 * is what a republish of unchanged source looks like within one session.
 */
export function sameContentOtherBytes(zip: Uint8Array): readonly [Uint8Array, Uint8Array] {
  const other = Buffer.from(zip);
  other.writeUInt16LE(0x4321, 10); // the first entry's local-header time
  return [navxWrap(Buffer.from(zip), 1), navxWrap(other, 2)];
}

/** Repetitive AL-ish text, long enough that deflate levels give different lengths. */
export const LONG_AL = `codeunit 50100 "Invented Tests"\n{\n${"    procedure Probe(): Boolean\n    begin\n        exit(true);\n    end;\n".repeat(40)}}\n`;

/** The standard invented entry set. */
export function entriesOf(
  o: ManifestOptions & { readonly al?: string; readonly symbols?: string } = {},
): ReadonlyArray<readonly [string, string | Buffer]> {
  return [
    ["NavxManifest.xml", manifestOf(o)],
    ["SymbolReference.json", o.symbols ?? '{"Codeunits":[{"Id":50100,"Name":"Invented Tests"}]}'],
    ["src/Tests.Codeunit.al", o.al ?? LONG_AL],
  ];
}
