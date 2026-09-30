import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { InstalledArtifactError } from "./artifact";
import { describeThrown } from "./describe-error";
import type { AlSource } from "./line-map";

/**
 * R360: a published batch's installed files could not be stored. Extends `Error` directly. The run
 * fails before it reports success, and its scratch folder is kept and named (`runFromCli`).
 */
export class InstalledBundleError extends Error {
  constructor(
    readonly reason: "bundle-unreadable" | "bundle-too-large" | "bundle-missing",
    readonly detail: string,
  ) {
    super(`installed bundle refused (${reason}): ${detail}`);
    this.name = "InstalledBundleError";
  }
}

/**
 * R360 I5: set from a BaseApp-sized measurement (docs/roadmap/R360.md): 187 MB of `.al`, largest
 * file 0.79 MB. `payloadBytes` counts `app.json`, the manifest and every `.al`, decompressed; the
 * `.app` has its own limit.
 */
export interface BundleLimits {
  readonly appBytes: number;
  readonly alFileBytes: number;
  readonly payloadBytes: number;
}

const MB = 1024 * 1024;
export const BUNDLE_LIMITS: BundleLimits = {
  appBytes: 512 * MB,
  alFileBytes: 16 * MB,
  payloadBytes: 1024 * MB,
};

/** What `ResultsStore.recordArtifact` writes for one published batch, with its digest. */
export interface InstalledBundleWrite {
  readonly payloadSha256: string;
  readonly appBytes: Uint8Array;
  readonly appJsonText: string;
  readonly manifestGz: Uint8Array;
  /** One row per `.al`, forward-slash path relative to the batch dir. */
  readonly files: ReadonlyArray<{ readonly path: string; readonly textGz: Uint8Array }>;
}

/** What `ResultsStore.installedBundle` reads back. */
export interface InstalledBundleRows {
  readonly appBytes: Uint8Array;
  readonly appJsonText: string;
  readonly manifestGz: Uint8Array;
  readonly files: ReadonlyArray<{ readonly path: string; readonly textGz: Uint8Array }>;
}

/**
 * The instrumented payload digest (R360 C1): SHA-256 over `app.json`, then each `.al` as
 * `<forward-slash path> NUL <bytes> NUL` in sorted path order, then the manifest file, then the
 * `.app`'s SHA-256. The same function on the write side and the read side.
 */
class PayloadDigest {
  private readonly h = new Bun.CryptoHasher("sha256");
  constructor(appJson: Uint8Array | string) {
    this.h.update(appJson);
  }
  file(path: string, bytes: Uint8Array): void {
    this.h.update(path);
    this.h.update("\0");
    this.h.update(bytes);
    this.h.update("\0");
  }
  finish(manifest: Uint8Array, appSha256: string): string {
    this.h.update(manifest);
    this.h.update(appSha256);
    return this.h.digest("hex");
  }
}

function byPath(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * R360: reads one published batch ONCE (`app.json`, every `.al`, `mutant-manifest.json`, the `.app`)
 * and returns the bundle and its digest. The `.app` must hash to `appSha256`, the hash the run
 * records for it. Throws `InstalledBundleError` naming the file on a read error or a limit.
 */
export async function readBatchBundle(
  batchDir: string,
  appPath: string,
  appSha256: string,
  limits: BundleLimits = BUNDLE_LIMITS,
): Promise<InstalledBundleWrite> {
  const read = async (path: string, max: number): Promise<Buffer> => {
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch (err) {
      throw new InstalledBundleError("bundle-unreadable", `${path}: ${describeThrown(err)}`);
    }
    if (size > max) {
      throw new InstalledBundleError(
        "bundle-too-large",
        `${path} is ${size} bytes, over the ${max}-byte limit`,
      );
    }
    try {
      return await readFile(path);
    } catch (err) {
      throw new InstalledBundleError("bundle-unreadable", `${path}: ${describeThrown(err)}`);
    }
  };
  const appBytes = await read(appPath, limits.appBytes);
  const actual = Bun.SHA256.hash(appBytes, "hex");
  if (actual !== appSha256) {
    throw new InstalledBundleError(
      "bundle-unreadable",
      `${appPath} hashes to ${actual}, but the published build hashed to ${appSha256}`,
    );
  }
  let budget = limits.payloadBytes;
  const take = (path: string, bytes: Uint8Array): void => {
    budget -= bytes.length;
    if (budget < 0) {
      throw new InstalledBundleError(
        "bundle-too-large",
        `the batch's app.json, manifest and .al files pass the ${limits.payloadBytes}-byte limit at ${path}`,
      );
    }
  };
  const appJsonPath = join(batchDir, "app.json");
  const appJson = await read(appJsonPath, limits.payloadBytes);
  take(appJsonPath, appJson);
  const manifestPath = join(batchDir, "mutant-manifest.json");
  const manifest = await read(manifestPath, limits.payloadBytes);
  take(manifestPath, manifest);

  let entries: string[];
  try {
    entries = (await readdir(batchDir, { recursive: true })).map((e) => e.toString());
  } catch (err) {
    throw new InstalledBundleError("bundle-unreadable", `${batchDir}: ${describeThrown(err)}`);
  }
  const alPaths = entries
    .filter((e) => e.toLowerCase().endsWith(".al"))
    .map((e) => ({ path: e.replaceAll("\\", "/"), native: e }))
    .sort(byPath);
  const digest = new PayloadDigest(appJson);
  const files: Array<{ path: string; textGz: Uint8Array }> = [];
  for (const { path, native } of alPaths) {
    const full = join(batchDir, native);
    const bytes = await read(full, limits.alFileBytes);
    take(full, bytes);
    digest.file(path, bytes);
    files.push({ path, textGz: gzipSync(bytes) });
  }
  return {
    payloadSha256: digest.finish(manifest, appSha256),
    appBytes: new Uint8Array(appBytes),
    appJsonText: appJson.toString("utf8"),
    manifestGz: gzipSync(manifest),
    files,
  };
}

/**
 * R360: decompresses a stored bundle and checks it against the recorded payload digest. Throws
 * `InstalledArtifactError` `payload-too-large` past a limit (zlib's `maxOutputLength`, so a bomb
 * never inflates) and `payload-differs` on any digest mismatch. Returns the texts `attach` indexes.
 */
export function openInstalledBundle(
  rows: InstalledBundleRows,
  record: {
    readonly runId: number;
    readonly batchIndex: number;
    readonly payloadSha256: string;
  },
  limits: BundleLimits = BUNDLE_LIMITS,
): { appBytes: Uint8Array; appJsonText: string; manifestText: string; alSources: AlSource[] } {
  const where = `run ${record.runId} batch ${record.batchIndex}`;
  const tooLarge = (what: string, max: number) =>
    new InstalledArtifactError(
      "payload-too-large",
      `${where}: the stored ${what} is over the ${max}-byte limit`,
    );
  if (rows.appBytes.length > limits.appBytes) throw tooLarge(".app", limits.appBytes);
  let budget = limits.payloadBytes;
  const inflate = (what: string, gz: Uint8Array, max: number): Buffer => {
    const cap = Math.min(max, budget);
    let out: Buffer;
    try {
      out = gunzipSync(gz, { maxOutputLength: cap });
    } catch (err) {
      if ((err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw tooLarge(what, cap);
      throw new InstalledArtifactError(
        "payload-differs",
        `${where}: the stored ${what} does not decompress: ${describeThrown(err)}`,
      );
    }
    budget -= out.length;
    return out;
  };
  const appJson = Buffer.from(rows.appJsonText, "utf8");
  budget -= appJson.length;
  if (budget < 0) throw tooLarge("app.json", limits.payloadBytes);
  const manifest = inflate("manifest", rows.manifestGz, limits.payloadBytes);
  const digest = new PayloadDigest(appJson);
  const alSources: AlSource[] = [];
  for (const f of [...rows.files].sort(byPath)) {
    const bytes = inflate(f.path, f.textGz, limits.alFileBytes);
    digest.file(f.path, bytes);
    alSources.push({ path: f.path, text: bytes.toString("utf8") });
  }
  const actual = digest.finish(manifest, Bun.SHA256.hash(rows.appBytes, "hex"));
  if (actual !== record.payloadSha256) {
    throw new InstalledArtifactError(
      "payload-differs",
      `${where}: the stored files hash to ${actual}, but the instrumented payload digest recorded at publish is ${record.payloadSha256}`,
    );
  }
  return {
    appBytes: rows.appBytes,
    appJsonText: rows.appJsonText,
    manifestText: manifest.toString("utf8"),
    alSources,
  };
}

/**
 * R360: a bundle from bytes already in memory, with the same digest `readBatchBundle` computes.
 * For callers that hold a batch's files (tests, fixtures); no size limit is applied.
 */
export function bundleOfParts(parts: {
  readonly appBytes: Uint8Array;
  readonly appJsonText: string;
  readonly manifestText: string;
  readonly files: ReadonlyArray<{ readonly path: string; readonly text: string }>;
}): InstalledBundleWrite {
  const enc = new TextEncoder();
  const digest = new PayloadDigest(enc.encode(parts.appJsonText));
  const files = [...parts.files]
    .map((f) => ({ path: f.path.replaceAll("\\", "/"), bytes: enc.encode(f.text) }))
    .sort(byPath);
  for (const f of files) digest.file(f.path, f.bytes);
  const manifest = enc.encode(parts.manifestText);
  return {
    payloadSha256: digest.finish(manifest, Bun.SHA256.hash(parts.appBytes, "hex")),
    appBytes: parts.appBytes,
    appJsonText: parts.appJsonText,
    manifestGz: gzipSync(manifest),
    files: files.map((f) => ({ path: f.path, textGz: gzipSync(f.bytes) })),
  };
}
