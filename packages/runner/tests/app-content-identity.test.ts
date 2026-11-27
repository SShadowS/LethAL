/**
 * PR-476 (R1234): `appContentIdentity`, the recompile-stable test-app identity, on invented NAVX
 * packages (tests 1, 2, 3, 8 and the shared-function half of 9 of the spec).
 */
import { describe, expect, test } from "bun:test";
import { appContentIdentity, hashPackage, testAppHashFor } from "../src/baseline-snapshot";
import {
  LONG_AL,
  type ManifestOptions,
  entriesOf,
  manifestOf,
  navxPackage,
  zipOf,
} from "./helpers/navx-package";

const C2 = /^package:c2:[0-9a-f]{64}$/;
const OLD = /^package:[0-9a-f]{64}$/;

type Variant = ManifestOptions & { al?: string; symbols?: string };
const build = (v: Variant = {}, id = 1, level: number | "stored" = "stored", time = 0) =>
  navxPackage({ id, level, time, entries: entriesOf(v) });

describe("appContentIdentity: a recompile of unchanged source (test 1)", () => {
  // Three invented "compiles": another package id, another deflate level, another entry time,
  // another Build Timestamp value, and so another zip length (header bytes 28..35).
  const a = build({ timestamp: "2026-11-27T10:00:00.0000001Z" }, 1, "stored", 0);
  const b = build({ timestamp: "2026-11-27T10:05:00.9999999Z" }, 2, 9, 0x6000);
  const c = build({ timestamp: "2026-11-27T10:09:00.5000000Z" }, 3, 1, 0x7f00);

  test("the fixtures really differ where a recompile differs", () => {
    const len = (p: Buffer) => p.readBigUInt64LE(28);
    expect(len(a)).not.toBe(len(b));
    expect(a.subarray(12, 28)).not.toEqual(b.subarray(12, 28));
    expect(hashPackage(a)).not.toBe(hashPackage(b));
    expect(hashPackage(b)).not.toBe(hashPackage(c));
    expect(hashPackage(a)).not.toBe(hashPackage(c));
  });
  test("c2 is equal across them, and has the c2 form", () => {
    const ids = [a, b, c].map((p) => appContentIdentity(p));
    expect(ids[0]).toMatch(C2);
    expect(new Set(ids).size).toBe(1);
  });
  test("c2 never equals an old-form value", () => {
    expect(appContentIdentity(a)).not.toMatch(OLD);
    expect(appContentIdentity(a)).not.toBe(`package:${hashPackage(a)}`);
  });
  test("the caller's buffer is untouched", () => {
    const copy = Buffer.from(a);
    appContentIdentity(a);
    expect(a.equals(copy)).toBe(true);
  });
});

describe("appContentIdentity: each change of content changes it (test 2)", () => {
  const base = appContentIdentity(build());
  const changes: Record<string, Variant> = {
    "one character of AL source": { al: LONG_AL.replace("Probe", "Probf") },
    "AL source one byte longer (an uncompressed size)": { al: `${LONG_AL}\n` },
    "SymbolReference.json": { symbols: '{"Codeunits":[{"Id":50101,"Name":"Invented Tests"}]}' },
    "app version": { version: "1.0.0.4" },
    "app id": { id: "11111111-2222-3333-4444-555555555556" },
    "app name": { name: "Invented Tests 2" },
    publisher: { publisher: "Other" },
    "a dependency's version": { dependencyVersion: "1.0.0.1" },
    CompilerVersion: { compilerVersion: "17.0.9.9" },
    runtime: { runtime: "16.0" },
    "a second Build attribute": { buildAttrs: ' Extra="x"' },
  };
  for (const [what, v] of Object.entries(changes)) {
    test(what, () => {
      expect(appContentIdentity(build(v))).not.toBe(base);
    });
  }
  const entries = entriesOf();
  const of = (e: typeof entries) => appContentIdentity(navxPackage({ id: 1, entries: e }));
  test("an added entry", () => {
    expect(of([...entries, ["extra.txt", "x"]])).not.toBe(of(entries));
  });
  test("a removed entry", () => {
    expect(of(entries.slice(0, 2))).not.toBe(of(entries));
  });
  test("a renamed entry", () => {
    const renamed = entries.map(
      ([n, d]) => [n === "SymbolReference.json" ? "Symbols.json" : n, d] as const,
    );
    expect(of(renamed)).not.toBe(of(entries));
  });
  test("the entry order does not matter (sorted by name)", () => {
    expect(of([...entries].reverse())).toBe(of(entries));
  });
  test("a changed header byte outside the id and the length (the format version)", () => {
    const p = build();
    const q = Buffer.from(p);
    q.writeUInt32LE(3, 8); // not the known shape now: falls back, and so differs
    expect(appContentIdentity(q)).not.toBe(appContentIdentity(p));
  });
});

describe("appContentIdentity: the Timestamp blanking is that one value only (test 3)", () => {
  const pair = (mk: (stamp: string) => ManifestOptions) => [
    appContentIdentity(build(mk("2026-01-01T00:00:00Z"))),
    appContentIdentity(build(mk("2026-02-02T00:00:00Z"))),
  ];
  test("control: exactly one <Build> with one Timestamp is blanked", () => {
    const [x, y] = pair((t) => ({ timestamp: t }));
    expect(x).toBe(y);
  });
  test("two <Build> elements: nothing is blanked", () => {
    const [x, y] = pair((t) => ({
      build: `<Build Timestamp="${t}" CompilerVersion="1" /><Build Timestamp="${t}" CompilerVersion="2" />`,
    }));
    expect(x).not.toBe(y);
  });
  test("no <Build>, a Timestamp on <App>: nothing is blanked", () => {
    const [x, y] = pair((t) => ({ build: "", appAttrs: ` Timestamp="${t}"` }));
    expect(x).not.toBe(y);
  });
  test("XTimestamp on <Build> is not Timestamp", () => {
    const [x, y] = pair((t) => ({ build: `<Build XTimestamp="${t}" CompilerVersion="1" />` }));
    expect(x).not.toBe(y);
  });
  test("a Timestamp on a <BuildInfo> element is not on <Build>", () => {
    const [x, y] = pair((t) => ({ build: `<BuildInfo Timestamp="${t}" CompilerVersion="1" />` }));
    expect(x).not.toBe(y);
  });
  test("two Timestamp attributes on the one <Build>: nothing is blanked", () => {
    const [x, y] = pair((t) => ({ build: `<Build Timestamp="${t}" Timestamp="${t}" />` }));
    expect(x).not.toBe(y);
  });
  test("a timestamp-like text inside another attribute's value is hashed", () => {
    const [x, y] = pair((t) => ({ build: `<Build Timestamp="x" Note="a Timestamp='${t}'" />` }));
    expect(x).not.toBe(y);
  });
  test("only NavxManifest.xml is blanked: the same text in another entry is hashed", () => {
    const other = (t: string) =>
      appContentIdentity(
        navxPackage({
          id: 1,
          entries: [...entriesOf(), ["notes.xml", `<Build Timestamp="${t}" />`]],
        }),
      );
    expect(other("a")).not.toBe(other("b"));
  });
  test("single-quoted Timestamp value is blanked too", () => {
    const m = (t: string) => ({ build: `<Build Timestamp='${t}' CompilerVersion="1" />` });
    const [x, y] = pair(m);
    expect(x).toBe(y);
  });
});

describe("appContentIdentity: the fallback (test 8)", () => {
  test("bytes that are not NAVX: package:<hashPackage>, as before", () => {
    const plain = zipOf({ entries: entriesOf() });
    expect(appContentIdentity(plain)).toBe(`package:${hashPackage(plain)}`);
    expect(appContentIdentity(plain)).toMatch(OLD);
  });
  test("a signed (wrapped) package: bytes after the zip break the length check, so the old form", () => {
    const signed = Buffer.concat([build(), Buffer.from("SIGNATURE-BYTES")]);
    expect(appContentIdentity(signed)).toBe(`package:${hashPackage(signed)}`);
  });
  test("a NAVX package with a wrong length field is the old form", () => {
    const odd = Buffer.from(build());
    odd.writeBigUInt64LE(40n, 28);
    expect(appContentIdentity(odd)).toBe(`package:${hashPackage(odd)}`);
  });
  test("a NAVX-shaped package whose zip cannot be walked THROWS, never a partial digest", () => {
    const broken = Buffer.from(build());
    broken.writeUInt32LE(0, broken.length - 22); // the end-of-central-directory signature
    expect(() => appContentIdentity(broken)).toThrow();
  });
});

describe("the shared function (test 9, the testAppHashFor half)", () => {
  test("testAppHashFor reads c2, so two recompiles give one identity", async () => {
    const a = build({}, 1, "stored", 0);
    const b = build({ timestamp: "2026-11-27T11:11:11.1111111Z" }, 2, 9, 5);
    expect(await testAppHashFor(async () => a, "/nonexistent")).toBe(appContentIdentity(a));
    expect(await testAppHashFor(async () => a, "/nonexistent")).toBe(
      await testAppHashFor(async () => b, "/nonexistent"),
    );
  });
  test("manifestOf with a Build element is what the fixtures use", () => {
    expect(manifestOf()).toContain("<Build Timestamp=");
  });
});
