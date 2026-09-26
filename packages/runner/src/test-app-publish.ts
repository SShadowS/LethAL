import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlcCompileError, type ArtifactCompiler } from "./artifact";
import type { BoundArtifact } from "./backend";
import { describeThrown } from "./describe-error";
import { readAppIdentity } from "./published-test-app";

/**
 * C02-05: compile the TEST app against the installed guarded build, and later publish it under
 * the lease. See `.superpowers/sdd/2026-09-26-C02-05-test-app-publish-under-lease/`.
 */

export type TestAppRefusal =
  | "manifest-unreadable" // testDir/app.json, or a package manifest, could not be read
  | "symbols-unreadable" // an .alpackages entry with no readable identity
  | "compile-failed" // alc said no
  | "unsupported" // the backend cannot read the package back
  | "version-below-resident" // decision 3, before the fence
  | "publish-failed" // decision 2's table
  | "publish-indeterminate"
  | "publish-anomalous";

/**
 * Every refusal on the test-app path. Extends `Error` DIRECTLY: in particular it is never an
 * `AlcCompileError`, so a test app alc rejects can never be read as bisection's "this subset does
 * not compile".
 */
export class TestAppError extends Error {
  constructor(
    readonly reason: TestAppRefusal,
    readonly detail: string,
    /** BC's installed version, when a downgrade names one. */
    readonly installedVersion: string | undefined = undefined,
  ) {
    super(`test app refused (${reason}): ${detail}`);
    this.name = "TestAppError";
  }
  /** Only a publish the server demonstrably did not take may tombstone the fence's marker. */
  get confirmedTerminal(): boolean {
    return this.reason === "publish-failed";
  }
}

export interface CompiledTestApp {
  readonly appPath: string;
  readonly sha256: string;
  /** From testDir/app.json. */
  readonly appId: string;
  readonly name: string;
  readonly publisher: string;
  readonly version: string;
  /** The installed guarded build it was compiled against. */
  readonly compiledAgainst: { readonly artifactId: string; readonly sha256: string };
}

async function readTestManifest(testDir: string) {
  const path = join(testDir, "app.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    throw new TestAppError("manifest-unreadable", `${path}: ${describeThrown(err)}`);
  }
  const m = (parsed ?? {}) as Record<string, unknown>;
  const { id, name, publisher, version } = m;
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    typeof publisher !== "string" ||
    typeof version !== "string"
  ) {
    throw new TestAppError(
      "manifest-unreadable",
      `${path} must carry string id, name, publisher and version`,
    );
  }
  return { id, name, publisher, version };
}

function identityOf(bytes: Buffer, what: string): string {
  try {
    return readAppIdentity(bytes).id;
  } catch (err) {
    throw new TestAppError("symbols-unreadable", `${what}: ${describeThrown(err)}`);
  }
}

/**
 * Decision 4. Stages a scratch symbol cache: the test project's `.alpackages` minus every copy of
 * the target and of LethAL Control, plus the bound instrumented build and the control symbol, and
 * compiles the test project against it. Local only: no server and no lease.
 */
export async function compileTestApp(a: {
  readonly testDir: string;
  readonly target: BoundArtifact;
  readonly compiler: ArtifactCompiler;
  readonly controlSymbolPath: string;
}): Promise<CompiledTestApp> {
  const manifest = await readTestManifest(a.testDir);

  let controlBytes: Buffer;
  try {
    controlBytes = await readFile(a.controlSymbolPath);
  } catch (err) {
    throw new TestAppError("symbols-unreadable", `${a.controlSymbolPath}: ${describeThrown(err)}`);
  }
  const controlId = identityOf(controlBytes, a.controlSymbolPath);

  const scratch = await mkdtemp(join(tmpdir(), "lethal-testapp-symbols-"));
  try {
    const alpackages = join(a.testDir, ".alpackages");
    let names: string[] = [];
    try {
      names = await readdir(alpackages);
    } catch (err) {
      // A missing .alpackages is not ours to refuse: alc names what it lacks.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new TestAppError("symbols-unreadable", `${alpackages}: ${describeThrown(err)}`);
      }
    }
    for (const name of names) {
      if (!name.toLowerCase().endsWith(".app")) continue;
      const path = join(alpackages, name);
      let bytes: Buffer;
      try {
        bytes = await readFile(path);
      } catch (err) {
        throw new TestAppError("symbols-unreadable", `${path}: ${describeThrown(err)}`);
      }
      // An entry we cannot identify could be the stale target, so it is refused, never skipped.
      // BC app ids are GUIDs, so case carries no meaning: an upper-case id is still the target.
      const id = identityOf(bytes, path).toLowerCase();
      if (id === a.target.appId.toLowerCase() || id === controlId.toLowerCase()) continue;
      await writeFile(join(scratch, name), bytes);
    }
    // The VERIFIED in-memory bytes (the ones matched to the trusted record), not a re-read of
    // appPath, which could have changed since. Written last, so on a file-name clash these win.
    await writeFile(join(scratch, `lethal-bound-${a.target.appId}.app`), a.target.appBytes);
    await writeFile(join(scratch, `lethal-control-${controlId}.app`), controlBytes);

    let out: { readonly appPath: string; readonly sha256: string };
    try {
      out = await a.compiler.compileProject({
        projectDir: a.testDir,
        packageCachePath: scratch,
        name: `testapp-${manifest.id}`,
      });
    } catch (err) {
      if (err instanceof AlcCompileError) throw new TestAppError("compile-failed", err.message);
      throw err;
    }
    return {
      appPath: out.appPath,
      sha256: out.sha256,
      appId: manifest.id,
      name: manifest.name,
      publisher: manifest.publisher,
      version: manifest.version,
      compiledAgainst: { artifactId: a.target.artifactId, sha256: a.target.sha256 },
    };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
