// R780 (coord R-772): a cross-session cache of al-runner-v3's TEST-APP alc compile. A hit means
// "alc already accepted exactly this test app against exactly this target interface", so deploy
// skips that compile. Only a PASSING compile writes a marker; a failure is never cached.
//
// The key (see `testAppCacheKey`) is a false-kill guard: a part missing from it could skip a compile
// that would fail. Every part is length-prefixed, so two inputs cannot run together.
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { readPackageEntry } from "./app-package";
import { compareAppVersions } from "./app-version";

const KEY = /^[0-9a-f]{64}$/;
/** Default cap on markers kept; the oldest by mtime go first. */
export const TEST_APP_PROOF_MAX = 2000;

const sha256 = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

/** JSON with object keys sorted at every level, so equal data gives equal text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** `value` without any `Variables` entry named `MutationSelector*` (an emptied list is removed). */
function withoutSelectorGlobals(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSelectorGlobals);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === "Variables" && Array.isArray(v)) {
      const kept = v.filter(
        (x) =>
          !(
            x !== null &&
            typeof x === "object" &&
            typeof (x as { Name?: unknown }).Name === "string" &&
            (x as { Name: string }).Name.toLowerCase().startsWith("mutationselector")
          ),
      );
      if (kept.length > 0) out[k] = kept.map(withoutSelectorGlobals);
    } else {
      out[k] = withoutSelectorGlobals(v);
    }
  }
  return out;
}

/**
 * The target .app's SymbolReference.json as the key sees it: top-level `Version` removed (minted per
 * batch), and the `MutationSelector*` globals removed only when `dropSelectorGlobals` (the test app
 * declares no extension object). `undefined` when the package or the entry cannot be read or parsed:
 * no key, no caching.
 */
export function symbolInterfaceForKey(
  appBytes: Buffer,
  dropSelectorGlobals: boolean,
): string | undefined {
  try {
    const entry = readPackageEntry(appBytes, "SymbolReference.json");
    if (entry === null) return undefined;
    const parsed = JSON.parse(entry.toString("utf8").replace(/^﻿/, "")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const { Version: _version, ...rest } = parsed as Record<string, unknown>;
    return canonicalJson(dropSelectorGlobals ? withoutSelectorGlobals(rest) : rest);
  } catch {
    return undefined;
  }
}

/**
 * The staged `active/app.json`, canonical, with `version` cut to `major.minor`; `undefined` when it
 * does not parse. Why `major.minor` stays: a staged dependency's own minimum version for the target
 * (and the test app's) is compared against this version, so a different major.minor can change
 * whether alc accepts the compile. The build and revision parts are minted per batch and are
 * dropped, or no two batches would ever share a key.
 */
export function appJsonForKey(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text.replace(/^﻿/, "")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const { version, ...rest } = parsed as Record<string, unknown>;
    const majorMinor =
      typeof version === "string" ? version.split(".").slice(0, 2).join(".") : (version ?? null);
    return canonicalJson({ ...rest, version: majorMinor });
  } catch {
    return undefined;
  }
}

export interface TestAppKeyInput {
  /** 1. The test dir, from the one read that fills the proof. */
  readonly testDirHash: string;
  readonly testOtherSha: ReadonlyMap<string, string>;
  readonly testAppJsonSha256: string;
  /** 2. `appJsonForKey` of the staged batch. */
  readonly activeAppJson: string;
  /** 3 and 4. `symbolInterfaceForKey`, selector globals dropped or kept. */
  readonly symbolInterface: string;
  readonly testHasExtensionObject: boolean;
  /** 5. The staged packages used by the test compile, the target excluded. */
  readonly deps: readonly { readonly name: string; readonly sha256: string }[];
  /** 6. */
  readonly alcPath: string;
  readonly alcSha256: string;
  /** 7. As passed to alc, in order. */
  readonly preprocessorSymbols: readonly string[];
  /** 8. */
  readonly transport: "one-shot" | "serve-entries";
}

/** The cache key: sha256 over the parts above in this fixed order, each length-prefixed. */
export function testAppCacheKey(i: TestAppKeyInput): string {
  const h = createHash("sha256");
  const part = (label: string, data: string): void => {
    h.update(`${label}:${Buffer.byteLength(data)}:`);
    h.update(data);
    h.update("\n");
  };
  part("v", "lethal-testapp-proof-1");
  part("test-al", i.testDirHash);
  part(
    "test-other",
    [...i.testOtherSha]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([rel, sha]) => `${rel.length}:${rel}${sha}`)
      .join("\n"),
  );
  part("test-app-json", i.testAppJsonSha256);
  part("active-app-json", i.activeAppJson);
  part("symbols", i.symbolInterface);
  part("test-extension", i.testHasExtensionObject ? "1" : "0");
  part(
    "deps",
    [...i.deps]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((d) => `${d.name.length}:${d.name}${d.sha256}`)
      .join("\n"),
  );
  part("alc", `${i.alcPath.length}:${i.alcPath}${i.alcSha256}`);
  part("define", JSON.stringify(i.preprocessorSymbols));
  part("transport", i.transport);
  return h.digest("hex");
}

const alcMemo = new Map<string, string>();
/** sha256 of the alc binary; `undefined` when it cannot be read (no key, no caching). */
export async function alcSha256(path: string): Promise<string | undefined> {
  try {
    const s = await stat(path);
    const memoKey = `${path}\0${s.size}\0${s.mtimeMs}`;
    const known = alcMemo.get(memoKey);
    if (known !== undefined) return known;
    const sha = sha256(new Uint8Array(await readFile(path)));
    alcMemo.set(memoKey, sha);
    return sha;
  } catch {
    return undefined;
  }
}

/**
 * Outside the key, checked on every hit: the batch's minted version must satisfy the version the
 * test app.json declares for the target dependency (matched by id, or by name and publisher).
 * No declaration: true. Anything unreadable or malformed: false (run alc live).
 */
export function mintedVersionSatisfiesTestApp(
  testAppJson: string,
  target: { readonly id: string; readonly name: string; readonly publisher: string },
  mintedVersion: string,
): boolean {
  try {
    const parsed = JSON.parse(testAppJson.replace(/^﻿/, "")) as {
      dependencies?: unknown;
    } | null;
    const deps = parsed?.dependencies;
    if (deps === undefined) return true;
    if (!Array.isArray(deps)) return false;
    for (const d of deps as Record<string, unknown>[]) {
      const byId = typeof d.id === "string" && d.id.toLowerCase() === target.id;
      const byName =
        typeof d.name === "string" &&
        typeof d.publisher === "string" &&
        d.name.toLowerCase() === target.name.toLowerCase() &&
        d.publisher.toLowerCase() === target.publisher.toLowerCase();
      if (!byId && !byName) continue;
      if (d.version === undefined) continue;
      if (typeof d.version !== "string") return false;
      if (compareAppVersions(mintedVersion, d.version) < 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** One marker file per key under `dir`. Only a file with the exact expected text is a hit. */
export class TestAppProofStore {
  constructor(
    private readonly dir: string,
    private readonly max: number = TEST_APP_PROOF_MAX,
  ) {}

  private static text(key: string): string {
    return `lethal testapp-proof v1 ${key}\n`;
  }

  /** A missing, corrupt, unreadable or non-file marker is a miss, never a hit. */
  async has(key: string): Promise<boolean> {
    if (!KEY.test(key)) return false;
    const path = join(this.dir, key);
    try {
      if (!(await lstat(path)).isFile()) return false;
      if ((await readFile(path, "utf8")) !== TestAppProofStore.text(key)) return false;
    } catch {
      return false;
    }
    // Recency for the eviction; best effort.
    const now = new Date();
    await utimes(path, now, now).catch(() => {});
    return true;
  }

  /** Atomic (temp + rename), then evicts the oldest over the cap. A failure is swallowed: a cache. */
  async put(key: string): Promise<void> {
    if (!KEY.test(key)) return;
    const tmp = join(this.dir, `${key}.${randomUUID()}.tmp`);
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(tmp, TestAppProofStore.text(key), "utf8");
      await rename(tmp, join(this.dir, key));
    } catch {
      await rm(tmp, { force: true }).catch(() => {});
      return;
    }
    await this.evict();
  }

  private async evict(): Promise<void> {
    try {
      const all = await readdir(this.dir);
      // Orphaned temp files (a crash between write and rename) older than an hour.
      for (const n of all.filter((n) => n.endsWith(".tmp"))) {
        const s = await lstat(join(this.dir, n)).catch(() => undefined);
        if (s !== undefined && Date.now() - s.mtimeMs > 3_600_000) {
          await rm(join(this.dir, n), { force: true }).catch(() => {});
        }
      }
      const names = all.filter((n) => KEY.test(n));
      if (names.length <= this.max) return;
      const aged: { name: string; mtimeMs: number }[] = [];
      for (const name of names) {
        const s = await lstat(join(this.dir, name)).catch(() => undefined);
        aged.push({ name, mtimeMs: s?.mtimeMs ?? 0 });
      }
      aged.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : 1));
      for (const { name } of aged.slice(0, names.length - this.max)) {
        await rm(join(this.dir, name), { recursive: true, force: true }).catch(() => {});
      }
    } catch {
      // best effort
    }
  }
}
