import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { InstalledArtifactError } from "../src/artifact";
import {
  BUNDLE_LIMITS,
  InstalledBundleError,
  bundleOfParts,
  openInstalledBundle,
  readBatchBundle,
} from "../src/installed-bundle";
import { scratchDirs } from "./helpers/scratch";

const scratch = scratchDirs();
const REC = { runId: 7, batchIndex: 0 };

/** A batch dir as step 3d leaves it: app.json, the manifest, flat `.al` files, and the `.app`. */
function batch(al: Record<string, string> = { "A.Codeunit.al": 'codeunit 1 "A" { }' }) {
  const dir = scratch("lethal-bundle-");
  writeFileSync(join(dir, "app.json"), '{"id":"x"}');
  writeFileSync(join(dir, "mutant-manifest.json"), '{"artifactId":"a","mutants":[]}');
  for (const [name, text] of Object.entries(al)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  const appPath = join(dir, "x.app");
  writeFileSync(appPath, "APPBYTES");
  return { dir, appPath, appSha: Bun.SHA256.hash("APPBYTES", "hex") };
}

describe("installed bundle (R360)", () => {
  test("a bundle read from a batch dir opens back to the same files, sorted, and its digest matches", async () => {
    const b = batch({ "Z.al": "codeunit 2 Z { }", "A.al": "codeunit 1 A { }" });
    const w = await readBatchBundle(b.dir, b.appPath, b.appSha);
    expect(w.files.map((f) => f.path)).toEqual(["A.al", "Z.al"]);
    const o = openInstalledBundle(w, { ...REC, payloadSha256: w.payloadSha256 });
    expect(o.alSources).toEqual([
      { path: "A.al", text: "codeunit 1 A { }" },
      { path: "Z.al", text: "codeunit 2 Z { }" },
    ]);
    expect(o.appJsonText).toBe('{"id":"x"}');
    expect(o.manifestText).toBe('{"artifactId":"a","mutants":[]}');
    // The same bytes held in memory give the same digest.
    expect(
      bundleOfParts({
        appBytes: new TextEncoder().encode("APPBYTES"),
        appJsonText: '{"id":"x"}',
        manifestText: '{"artifactId":"a","mutants":[]}',
        files: o.alSources,
      }).payloadSha256,
    ).toBe(w.payloadSha256);
  });

  test("C1: one changed byte of one stored .al is refused as payload-differs, naming the digest", async () => {
    const b = batch();
    const w = await readBatchBundle(b.dir, b.appPath, b.appSha);
    const [f] = w.files;
    if (f === undefined) throw new Error("no file");
    const tampered = { ...w, files: [{ path: f.path, textGz: gzipSync('codeunit 1 "B" { }') }] };
    const err = (() => {
      try {
        openInstalledBundle(tampered, { ...REC, payloadSha256: w.payloadSha256 });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(InstalledArtifactError);
    expect(err).toMatchObject({ reason: "payload-differs" });
    expect((err as Error).message).toContain("instrumented payload digest");
  });

  test("a .app that no longer hashes to the published build is refused by name on write", async () => {
    const b = batch();
    writeFileSync(b.appPath, "CHANGED");
    await expect(readBatchBundle(b.dir, b.appPath, b.appSha)).rejects.toMatchObject({
      reason: "bundle-unreadable",
      message: expect.stringContaining(b.appPath),
    });
  });

  test("a .app that vanished is refused by name on write", async () => {
    const b = batch();
    const err = await readBatchBundle(b.dir, join(b.dir, "gone.app"), b.appSha).catch((e) => e);
    expect(err).toBeInstanceOf(InstalledBundleError);
    expect(err).toMatchObject({ reason: "bundle-unreadable" });
    expect((err as Error).message).toContain("gone.app");
  });

  test("I5: each write limit refuses as bundle-too-large, naming the file", async () => {
    const b = batch({ "Big.al": "x".repeat(100) });
    const tight = (over: Partial<typeof BUNDLE_LIMITS>) => ({ ...BUNDLE_LIMITS, ...over });
    await expect(
      readBatchBundle(b.dir, b.appPath, b.appSha, tight({ alFileBytes: 99 })),
    ).rejects.toMatchObject({
      reason: "bundle-too-large",
      message: expect.stringContaining("Big.al"),
    });
    await expect(
      readBatchBundle(b.dir, b.appPath, b.appSha, tight({ appBytes: 7 })),
    ).rejects.toMatchObject({
      reason: "bundle-too-large",
      message: expect.stringContaining("x.app"),
    });
    await expect(
      readBatchBundle(b.dir, b.appPath, b.appSha, tight({ payloadBytes: 120 })),
    ).rejects.toMatchObject({ reason: "bundle-too-large" });
    // At the limits it is accepted.
    await readBatchBundle(b.dir, b.appPath, b.appSha, tight({ alFileBytes: 100 }));
  });

  test("I5: an over-limit stored bundle is refused on read as payload-too-large, never inflated", async () => {
    const b = batch({ "Big.al": "x".repeat(100) });
    const w = await readBatchBundle(b.dir, b.appPath, b.appSha);
    const rec = { ...REC, payloadSha256: w.payloadSha256 };
    for (const limits of [
      { ...BUNDLE_LIMITS, alFileBytes: 99 },
      { ...BUNDLE_LIMITS, appBytes: 7 },
      { ...BUNDLE_LIMITS, payloadBytes: 120 },
    ]) {
      expect(() => openInstalledBundle(w, rec, limits)).toThrow(
        expect.objectContaining({ reason: "payload-too-large" }),
      );
    }
    expect(openInstalledBundle(w, rec).alSources).toHaveLength(1);
  });

  test("review M-9: an app.json-only tamper is refused as payload-differs", async () => {
    const b = batch();
    const w = await readBatchBundle(b.dir, b.appPath, b.appSha);
    expect(() =>
      openInstalledBundle(
        { ...w, appJsonText: '{"id":"y"}' },
        { ...REC, payloadSha256: w.payloadSha256 },
      ),
    ).toThrow(expect.objectContaining({ reason: "payload-differs" }));
  });

  test("review M-7: bytes cannot move between app.json and the first path without changing the digest", () => {
    const parts = (appJsonText: string, path: string) =>
      bundleOfParts({
        appBytes: new TextEncoder().encode("APP"),
        appJsonText,
        manifestText: "{}",
        files: [{ path, text: "codeunit 1 A { }" }],
      }).payloadSha256;
    expect(parts("{}a", "b.al")).not.toBe(parts("{}", "ab.al"));
  });

  test("review M-2: a payload at exactly the limit opens, with an empty .al, and one byte over is payload-too-large", async () => {
    const b = batch({ "A.al": "x".repeat(10), "Z.al": "" });
    const w = await readBatchBundle(b.dir, b.appPath, b.appSha);
    const rec = { ...REC, payloadSha256: w.payloadSha256 };
    // app.json 10 + manifest 31 + A.al 10 + Z.al 0 bytes.
    const exact = 10 + 31 + 10;
    expect(
      openInstalledBundle(w, rec, { ...BUNDLE_LIMITS, payloadBytes: exact }).alSources,
    ).toHaveLength(2);
    await readBatchBundle(b.dir, b.appPath, b.appSha, { ...BUNDLE_LIMITS, payloadBytes: exact });
    expect(() =>
      openInstalledBundle(w, rec, { ...BUNDLE_LIMITS, payloadBytes: exact - 1 }),
    ).toThrow(expect.objectContaining({ reason: "payload-too-large" }));
    // The budget is spent before the last file, which is one byte: refused as too large, never as
    // a decompression failure.
    const c = batch({ "A.al": "x".repeat(10), "Z.al": "y" });
    const wc = await readBatchBundle(c.dir, c.appPath, c.appSha);
    expect(() =>
      openInstalledBundle(
        wc,
        { ...REC, payloadSha256: wc.payloadSha256 },
        { ...BUNDLE_LIMITS, payloadBytes: exact },
      ),
    ).toThrow(expect.objectContaining({ reason: "payload-too-large" }));
  });
});
