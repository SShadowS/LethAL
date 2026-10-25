/**
 * R762 (lever 4): a cache for the al-runner-v3 contract probe of a SESSION (`AlRunnerV3Backend.status()`).
 * The probe runs invented AL against the binary and never reads the project under test, so on the
 * same inputs it gives the same facts (measured: 0 per-mutant differences, `/coord/handoff/R-762/lever4.md`).
 * It costs about 10 s per session. The cache keeps a FULLY PASSING result and replays it only when
 * every input the facts depend on is the same.
 *
 * What is never cached or read: a candidate build (the update gate), leg C (it calls
 * `runV3ContractProbe` directly, never through here), and any result that is not fully passing
 * (a refusal must be measured again, never replayed). A missing, unreadable or corrupt entry means
 * RUN THE PROBE: it is never turned into a default.
 *
 * Store: one file per key digest beside the binary's `.gated` (`.probe-cache-<digest16>.json`). That
 * folder is the pinned build's own, so a new build starts with no entries; a key differing in any
 * part (e.g. another bcVersion) gets its own file instead of thrashing one shared file.
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { V3ContractResult, V3Fact } from "./al-runner-v3-contract";
import { v3ContractRefusals } from "./al-runner-v3-contract";
import { findV3Pin, pinnedFactMatches } from "./al-runner-v3-pins";

/** The env var that forces a fresh probe (the `--fresh-probe` flag sets the same thing). */
export const FRESH_PROBE_ENV = "LETHAL_V3_FRESH_PROBE";

/**
 * Source files whose text decides what the probe measures and how it reads rows: the probe and its
 * AL, the row decoders, the text constants, the serve and alc and spawn helpers it calls.
 * ponytail: whole files, so any edit to them (even unrelated, e.g. in the backend) re-runs the probe
 * once; split out the decoders if that churn hurts.
 */
const PROBE_CODE_FILES = [
  "al-runner-v3-contract.ts",
  "al-runner-v3-probe.ts",
  "al-runner-v3-texts.ts",
  "al-runner-rows.ts",
  "al-runner-v3-backend.ts",
  "al-runner-server.ts",
  "artifact.ts",
  "publisher.ts",
] as const;

/**
 * A hash of the CONTENT of `PROBE_CODE_FILES`, read at run time. Chosen over a build-time constant
 * because a constant someone forgets to bump gives a stale pass; content cannot be forgotten. If a
 * file cannot be read (a bundled build) the hash is `undefined` and the caller runs the probe.
 */
export async function probeCodeHash(
  dir: string = import.meta.dir,
  files: readonly string[] = PROBE_CODE_FILES,
): Promise<string | undefined> {
  const h = createHash("sha256");
  try {
    for (const f of files) {
      h.update(f)
        .update("\0")
        .update(new Uint8Array(await readFile(join(dir, f))))
        .update("\0");
    }
  } catch {
    return undefined;
  }
  return h.digest("hex");
}

/**
 * File names and BYTES of every `.app` in the package folder (v3 and alc read symbols there).
 * R776: content, not mtime, so a copied, re-downloaded or touched folder with the same bytes still
 * hits; about 0.1 s for 70 MB. Throws when a file cannot be read, or is not a regular file (a FIFO
 * would block, a device read forever); the caller then runs the probe. Each file is hashed on its
 * own and fed in as `name\0<hex>\n`, so one file's bytes can never read as a file boundary.
 */
export async function packagesFingerprint(packagesDir: string): Promise<string> {
  const h = createHash("sha256");
  for (const name of (await readdir(packagesDir)).sort()) {
    if (!name.toLowerCase().endsWith(".app")) continue;
    const path = join(packagesDir, name);
    if (!(await stat(path)).isFile()) throw new Error(`${path} is not a regular file`);
    const f = createHash("sha256");
    for await (const chunk of createReadStream(path)) f.update(chunk as Buffer);
    h.update(`${name}\0${f.digest("hex")}\n`);
  }
  return h.digest("hex");
}

/** The alc binary's path and the sha256 of its bytes. Throws when it cannot be read. */
export async function alcIdentity(alcPath: string): Promise<string> {
  const bytes = await readFile(alcPath);
  return `${alcPath}\0${createHash("sha256").update(new Uint8Array(bytes)).digest("hex")}`;
}

/** Every input a cached fact may depend on (the per-fact table of lever4.md). */
export interface ProbeCacheKey {
  readonly binarySha256: string;
  readonly version: string;
  readonly probeCodeHash: string;
  readonly bcVersion: string;
  readonly packages: string;
  readonly alc: string;
  /** `ALRUNNER_CACHE` as configured; `null` when absent. */
  readonly cacheDir: string | null;
  /** The `.gated` text the session passes as `gateOnlyTrusted` (carries its lethalCommit). */
  readonly gateRecord: string;
  readonly tasksetPresent: boolean;
  /** A session never passes Library Assert; a probe that did would read another half of a fact. */
  readonly libraryAssertApp: boolean;
}

export const keyDigest = (k: ProbeCacheKey): string =>
  createHash("sha256").update(JSON.stringify(k)).digest("hex");

/**
 * Why a result must not be cached, or `undefined` when it may be. Cacheable: a normal session would
 * accept it, and every fact either passes (contract `matches`, defect `defect-present`/`gone`, warn)
 * or equals THIS build's pinned reading (`findV3Pin` + `pinnedFactMatches`; the pinned build's
 * `refused` duplicate-key fact, #5788). Any other non-passing fact is never stored.
 */
export function uncacheableReason(
  r: V3ContractResult,
  version: string,
  binarySha256: string,
): string | undefined {
  if (v3ContractRefusals(r, { candidate: false }).length > 0) return "a normal session refuses it";
  const pin = findV3Pin(version, binarySha256);
  for (const f of r.facts) {
    const passes =
      f.kind === "contract"
        ? f.verdict === "matches"
        : f.kind === "defect"
          ? f.verdict === "defect-present" || f.verdict === "gone"
          : true;
    if (passes || (pin !== undefined && pinnedFactMatches(pin.legC, f))) continue;
    return `${f.fact} = ${f.verdict}, not the pinned reading`;
  }
  return undefined;
}

export const isCacheable = (r: V3ContractResult, version: string, binarySha256: string): boolean =>
  uncacheableReason(r, version, binarySha256) === undefined;

export class ProbeCacheCorruptError extends Error {
  constructor(file: string, why: string) {
    super(`al-runner-v3 probe cache ${file} is unusable: ${why}`);
    this.name = "ProbeCacheCorruptError";
  }
}

const isFact = (f: unknown): f is V3Fact => {
  const x = f as Record<string, unknown> | null;
  return (
    typeof x === "object" &&
    x !== null &&
    typeof x.fact === "string" &&
    (x.kind === "contract" || x.kind === "defect" || x.kind === "warn") &&
    typeof x.verdict === "string" &&
    typeof x.expected === "string" &&
    typeof x.measured === "string"
  );
};

const entryPath = (binaryPath: string, digest: string): string =>
  join(dirname(binaryPath), `.probe-cache-${digest.slice(0, 16)}.json`);

/**
 * The cached result for `key`, or `undefined` when there is no entry file. An entry that exists but
 * is corrupt, has another key, or is not a passing result THROWS `ProbeCacheCorruptError`; the
 * caller runs the probe (and overwrites it).
 */
export async function readProbeCache(
  binaryPath: string,
  key: ProbeCacheKey,
): Promise<V3ContractResult | undefined> {
  const file = entryPath(binaryPath, keyDigest(key));
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ProbeCacheCorruptError(file, String(e));
  }
  let raw: { key?: unknown; result?: { facts?: unknown } };
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ProbeCacheCorruptError(file, "not JSON");
  }
  if (JSON.stringify(raw.key) !== JSON.stringify(key)) {
    throw new ProbeCacheCorruptError(file, "its key does not match");
  }
  const facts = raw.result?.facts;
  if (!Array.isArray(facts) || facts.length === 0 || !facts.every(isFact)) {
    throw new ProbeCacheCorruptError(file, "its result is malformed");
  }
  const result: V3ContractResult = { facts };
  if (!isCacheable(result, key.version, key.binarySha256))
    throw new ProbeCacheCorruptError(file, "its result is not a pass");
  return result;
}

/** Atomic write (temp file, then rename), so a concurrent session never reads half a file. */
export async function writeProbeCache(
  binaryPath: string,
  key: ProbeCacheKey,
  result: V3ContractResult,
): Promise<void> {
  const file = entryPath(binaryPath, keyDigest(key));
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(
    tmp,
    JSON.stringify({ key, result, writtenAt: new Date().toISOString() }, null, 1),
  );
  await rename(tmp, file);
}
