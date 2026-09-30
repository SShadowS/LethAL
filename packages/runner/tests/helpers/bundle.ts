import { gzipSync } from "node:zlib";
import { type InstalledBundleWrite, readBatchBundle } from "../../src/installed-bundle";

/**
 * R360: a small bundle for store tests that only need `recordArtifact` to accept a row. Its
 * digest is a placeholder, so `openInstalledBundle` would refuse it: a test that verifies against
 * the stored files builds a real one with `readBatchBundle`.
 */
export function tinyBundle(tag = "t"): InstalledBundleWrite {
  return {
    payloadSha256: "e".repeat(64),
    appBytes: new TextEncoder().encode(tag),
    appJsonText: "{}",
    manifestGz: gzipSync("{}"),
    files: [{ path: "a.al", textGz: gzipSync(`codeunit 1 ${tag} { }`) }],
  };
}

/** R360: the real bundle of a batch dir and its `.app`, as step 3d writes it. */
export async function bundleFor(batchDir: string, appPath: string): Promise<InstalledBundleWrite> {
  const sha = Bun.SHA256.hash(await Bun.file(appPath).bytes(), "hex");
  return readBatchBundle(batchDir, appPath, sha);
}
