import { describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import type { PublishedPackageRead } from "../src/backend";
import {
  type AppDependency,
  DependencyUnreadableError,
  type MicrosoftMode,
  appInputsOfAppJson,
  dependencyFingerprint,
} from "../src/digest-inputs";
import { CONTROL_APP_ID } from "../src/harness";

// PR-457 (R1230): System is hashed by content. The fixtures are SYNTHETIC packages: a NAVX-style
// header plus a zip built here. Real System packages are Microsoft binaries and are never committed.

const SYSTEM_ID = "8874ed3a-0643-4247-9ced-7a7002f7135d";
const DEP = "22222222-2222-2222-2222-222222222222";
const CONTROL_VERSION = "1.0.0.20";

const manifest = (id: string, name: string, publisher: string, version = "1.0.0.0") =>
  `<?xml version="1.0" encoding="utf-8"?><Package xmlns="http://schemas.microsoft.com/navx/2015/manifest"><App Id="${id}" Name="${name}" Publisher="${publisher}" Version="${version}" /><Dependencies></Dependencies></Package>`;

type Entries = readonly (readonly [string, string | Buffer])[];

interface ZipOpts {
  header?: string;
  /** DOS time and date stamped on every entry. */
  time?: number;
  date?: number;
  /** zlib level; 0 stores the entry. */
  level?: number;
  /** Overwrite src/B.al's deflated data with 0xff bytes (the manifest stays readable). */
  corrupt?: boolean;
  /** Declare every entry two bytes smaller than it is (one smaller still fits the size+1 bound). */
  sizeShort?: boolean;
  /** End src/B.al's name with the invalid UTF-8 byte 0xff. */
  badName?: boolean;
  /** Declare every entry one byte larger than it is. */
  sizeLie?: boolean;
  /** Set the encryption flag. */
  encrypted?: boolean;
  /** Declare this compression method on every entry. */
  method?: number;
  /** Declare this many entries in the end record. */
  eocdCount?: number;
}

/** A header followed by a zip, with the offsets the real reader expects (relative to the zip). */
function zip(entries: Entries, o: ZipOpts = {}): Buffer {
  const header = Buffer.from(o.header ?? "NAVX-header-0001", "utf8");
  const level = o.level ?? 6;
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [entryName, content] of entries) {
    const name =
      o.badName === true && entryName === "src/B.al"
        ? Buffer.concat([Buffer.from(entryName, "utf8"), Buffer.from([0xff])])
        : Buffer.from(entryName, "utf8");
    const data = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    let body = level === 0 ? data : deflateRawSync(data, { level });
    if (o.corrupt === true && level !== 0 && entryName === "src/B.al")
      body = Buffer.alloc(body.length, 0xff);
    // The method lie is told on src/B.al only: openPackage reads the manifest first and would
    // refuse for its own reason, hiding whether the content walk refuses.
    const method =
      o.method !== undefined && entryName === "src/B.al" ? o.method : level === 0 ? 0 : 8;
    const usize =
      o.sizeLie === true ? data.length + 1 : o.sizeShort === true ? data.length - 2 : data.length;
    const flags = o.encrypted === true ? 1 : 0;
    const time = o.time ?? 0;
    const date = o.date ?? 0;

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(usize, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(usize, 24);
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
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(o.eocdCount ?? centrals.length, 8);
  eocd.writeUInt16LE(o.eocdCount ?? centrals.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(localBytes.length, 16);
  return Buffer.concat([header, localBytes, centralBytes, eocd]);
}

const SYSTEM_MANIFEST = manifest(SYSTEM_ID, "System", "Microsoft");
const BASE: Entries = [
  ["NavxManifest.xml", SYSTEM_MANIFEST],
  ["SymbolReference.json", "{}"],
  [
    "src/A.al",
    "codeunit 1 A {} // some longer text so that deflate has something to do ".repeat(8),
  ],
  ["src/B.al", "codeunit 2 B {}"],
];
const edit = (entries: Entries, name: string, text: string): Entries =>
  entries.map(([n, t]) => [n, n === name ? text : t] as const);

const controlPkg = zip([
  ["NavxManifest.xml", manifest(CONTROL_APP_ID, "LethAL Control", "LethAL", CONTROL_VERSION)],
]);

function mode(system: PublishedPackageRead): MicrosoftMode {
  return {
    kind: "bytes",
    readSystem: async () => system,
    readControl: async () => controlPkg,
    controlVersion: async () => CONTROL_VERSION,
    installed: async () => ["1.0.0.0"],
  };
}

const ROOT = appInputsOfAppJson({});
const noDeps = async (_d: AppDependency): Promise<readonly Uint8Array[]> => [];
const fp = (system: PublishedPackageRead) => dependencyFingerprint(ROOT, noDeps, mode(system));

describe("PR-457: System content digest", () => {
  test("1: equal content in different zips gives the SAME digest", async () => {
    const a = zip(BASE, { time: 100, date: 7, level: 6 });
    const reordered = zip([...BASE].reverse(), { time: 9999, date: 1234, level: 1 });
    const stored = zip(BASE, { time: 5, level: 0 });
    const lvl9 = zip(BASE, { time: 5, level: 9 });
    expect(a.equals(reordered)).toBe(false);
    expect(a.equals(stored)).toBe(false);
    expect(a.equals(lvl9)).toBe(false);
    const want = await fp(a);
    expect(await fp(reordered)).toBe(want);
    expect(await fp(stored)).toBe(want); // stored against deflated
    expect(await fp(lvl9)).toBe(want); // two deflate levels
    expect(await fp(zip(BASE, { level: 1 }))).toBe(want);
  });

  test("2: a DEFLATED entry's bytes edited at the same size gives a different digest", async () => {
    const text = "codeunit 1 Z {}";
    expect(text.length).toBe("codeunit 1 A {}".length);
    const a = edit(BASE, "src/B.al", text);
    expect(await fp(zip(a, { level: 6 }))).not.toBe(await fp(zip(BASE, { level: 6 })));
  });

  test("3: an entry added gives a different digest", async () => {
    expect(await fp(zip([...BASE, ["src/C.al", "x"]]))).not.toBe(await fp(zip(BASE)));
  });

  test("4: an entry removed gives a different digest", async () => {
    expect(await fp(zip(BASE.slice(0, 3)))).not.toBe(await fp(zip(BASE)));
  });

  test("5: an entry renamed gives a different digest", async () => {
    const renamed = BASE.map(([n, t]) => [n === "src/B.al" ? "src/C.al" : n, t] as const);
    expect(await fp(zip(renamed))).not.toBe(await fp(zip(BASE)));
  });

  test("6: the header bytes before the zip changed gives a different digest", async () => {
    expect(await fp(zip(BASE, { header: "NAVX-header-0002" }))).not.toBe(await fp(zip(BASE)));
  });

  // The refusal must come from the content digest (not from openPackage's own read) and from the
  // named branch, so each test names a phrase only its branch writes.
  const refuses = async (system: PublishedPackageRead, phrase: string): Promise<void> => {
    const err = await fp(system).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DependencyUnreadableError);
    const text = (err as Error).message;
    expect(text).toContain("System");
    expect(text).toContain("has no readable content");
    expect(text).toContain(phrase);
  };

  test("7a: a duplicate entry name refuses", async () => {
    await refuses(zip([...BASE, ["src/A.al", "again"]]), "duplicate zip entry name");
  });
  test("7b: an entry that cannot be inflated refuses", async () => {
    await refuses(zip(BASE, { corrupt: true }), "cannot be inflated");
  });
  test("7c: a size that differs from the central directory's refuses (stored)", async () => {
    await refuses(zip(BASE, { sizeLie: true, level: 0 }), "the central directory says");
  });
  test("7d: a size that differs from the central directory's refuses (deflated)", async () => {
    await refuses(zip(BASE, { sizeLie: true, level: 6 }), "the central directory says");
  });
  test("7d2: a central directory size SMALLER than the real one refuses (deflated, bounded inflate)", async () => {
    await refuses(zip(BASE, { sizeShort: true, level: 6 }), "cannot be inflated");
  });
  test("7e: the encryption flag refuses", async () => {
    await refuses(zip(BASE, { encrypted: true }), "is encrypted");
  });
  test("7f: an unsupported compression method (14) refuses", async () => {
    await refuses(zip(BASE, { method: 14 }), "unsupported zip compression method");
  });
  test("7g: an end-record entry count that differs from the entries walked refuses", async () => {
    await refuses(zip(BASE, { eocdCount: BASE.length + 1 }), "entries in its end record");
  });
  test("7h: an entry name with a control character refuses", async () => {
    await refuses(zip([...BASE, ["src/a\u0001.al", "x"]]), "control character");
  });
  test("7i: an entry name that is not valid UTF-8 refuses", async () => {
    await refuses(zip(BASE, { badName: true }), "not valid UTF-8");
  });

  test("8: a partner X line is still raw bytes: re-zipping a partner package changes it", async () => {
    const partner = (time: number) =>
      zip([["NavxManifest.xml", manifest(DEP, "Dep", "Other")]], { time });
    const x = (time: number) =>
      dependencyFingerprint(
        appInputsOfAppJson({
          dependencies: [{ id: DEP, name: "Dep", publisher: "Other", version: "1.0.0.0" }],
        }),
        async () => [partner(time)],
        mode(zip(BASE)),
      );
    expect(await x(1)).toBe(await x(1));
    expect(await x(1)).not.toBe(await x(2));
  });

  test("9: end to end, two re-zips of one content fingerprint equally", async () => {
    expect(await fp(zip(BASE, { time: 1 }))).toBe(await fp(zip(BASE, { time: 2, level: 9 })));
  });

  test("9b: end to end, a re-zip with ONE entry's bytes changed fingerprints differently", async () => {
    const changed = edit(BASE, "src/B.al", "codeunit 2 Z {}");
    expect(await fp(zip(changed, { time: 2, level: 9 }))).not.toBe(
      await fp(zip(BASE, { time: 1 })),
    );
  });

  test("10: two entries swapping contents gives a different digest", async () => {
    const a = BASE.find(([n]) => n === "src/A.al")?.[1] ?? "";
    const b = BASE.find(([n]) => n === "src/B.al")?.[1] ?? "";
    const swapped = BASE.map(
      ([n, t]) => [n, n === "src/A.al" ? b : n === "src/B.al" ? a : t] as const,
    );
    expect(await fp(zip(swapped))).not.toBe(await fp(zip(BASE)));
  });

  test("a Ready-to-Run wrapper is hashed whole: its timestamps do not count, its inner app does", async () => {
    const inner = (text: string) => zip(edit(BASE, "src/A.al", text), { level: 0 });
    const wrap = (innerApp: Buffer, extra: string, time: number) =>
      zip(
        [
          ["readytorunappmanifest.json", JSON.stringify({ EmbeddedAppId: SYSTEM_ID })],
          ["wrapper.txt", extra],
          ["System.app", innerApp],
        ],
        { time, level: 0 },
      );
    expect(await fp(wrap(inner("a"), "w", 1))).toBe(await fp(wrap(inner("a"), "w", 2)));
    expect(await fp(wrap(inner("a"), "w", 1))).not.toBe(await fp(wrap(inner("a"), "w2", 1)));
    expect(await fp(wrap(inner("a"), "w", 1))).not.toBe(await fp(wrap(inner("b"), "w", 1)));
  });
});
