import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareAppVersions, parseVersionConflict } from "./app-version";
import { AlcCompileError, type ArtifactCompiler } from "./artifact";
import type { BoundArtifact } from "./backend";
import { hashPackage } from "./baseline-snapshot";
import {
  type DeploymentVerification,
  type PublishOutcome,
  decidePublishOutcome,
} from "./deployment-verifier";
import { describeThrown } from "./describe-error";
import type { LeaseFence } from "./orchestrator";
import { readAppIdentity } from "./published-test-app";
import type { AppPublisher } from "./publisher";

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

/** Reasons `confirmedTerminal` treats as terminal below. */
const TERMINAL_REASONS: ReadonlySet<TestAppRefusal> = new Set<TestAppRefusal>([
  "publish-failed",
  "unsupported",
  "version-below-resident",
  "manifest-unreadable",
  "compile-failed",
  "symbols-unreadable",
]);

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
  /**
   * Whether the fence may tombstone its marker (and the lease hook release, not latch). True for a
   * publish the server demonstrably did not take, and for every refusal thrown before
   * `fence.publish`: those claim no marker and touch no server, like `ArtifactPrepareError`. An
   * allow-list, so a reason added later is NOT terminal until someone says it is.
   */
  get confirmedTerminal(): boolean {
    return TERMINAL_REASONS.has(this.reason);
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

export interface PublishedTestApp {
  readonly appId: string;
  readonly name: string;
  readonly publisher: string;
  /** The server's own NavxManifest Version, read back after the publish. */
  readonly version: string;
  /** sha256 of the package the server returned after the publish: the compiled bytes' hash. */
  readonly sha256: string;
  readonly compiledAgainst: CompiledTestApp["compiledAgainst"];
}

/**
 * The server's package for this app: bytes, `null` when the read did not answer (never published,
 * timeout, refused), `undefined` when this configuration cannot form the request at all.
 */
export type ReadPublished = (app: {
  readonly publisher: string;
  readonly name: string;
}) => Promise<Uint8Array | null | undefined>;

function versionOf(bytes: Uint8Array): string {
  try {
    return readAppIdentity(Buffer.from(bytes)).version;
  } catch (err) {
    throw new TestAppError("manifest-unreadable", `the resident package: ${describeThrown(err)}`);
  }
}

function compareVersionsOrRefuse(local: string, resident: string): number {
  try {
    return compareAppVersions(local, resident);
  } catch (err) {
    throw new TestAppError(
      "manifest-unreadable",
      `cannot compare app.json version ${local} with the resident ${resident}: ${describeThrown(err)}`,
    );
  }
}

function describeOutcome(
  publishError: string | undefined,
  verification: DeploymentVerification,
  app: CompiledTestApp,
): string {
  const altool = publishError === undefined ? "altool exited 0" : `altool failed: ${publishError}`;
  const server =
    verification.status === "accepted"
      ? `the server holds the compiled package (${app.sha256})`
      : verification.status === "mismatch"
        ? `the server holds package ${verification.reported}, not the compiled ${app.sha256}`
        : `the server's package is unreadable (${verification.detail})`;
  return `${app.name} ${app.version}: ${altool}; ${server}`;
}

/**
 * Decision 2 and 3. Refuses a local version below the resident one BEFORE the fence (no marker,
 * no altool), then publishes only inside `fence.publish` and returns an identity only when the
 * server's package is byte-for-byte the compiled one. The test app keeps its own app.json version;
 * nothing here mints one.
 */
export async function publishTestApp(
  fence: LeaseFence,
  app: CompiledTestApp,
  deps: { readonly publisher: AppPublisher; readonly readPublished: ReadPublished },
): Promise<PublishedTestApp> {
  const key = { publisher: app.publisher, name: app.name };
  // Before the fence: a refusal here claims no operation marker.
  const before = await deps.readPublished(key);
  if (before === undefined) {
    throw new TestAppError(
      "unsupported",
      "this configuration cannot read a published package back (no dev server or no credentials), so a publish could not be verified",
    );
  }
  if (before instanceof Uint8Array) {
    const resident = versionOf(before);
    if (compareVersionsOrRefuse(app.version, resident) < 0) {
      throw new TestAppError(
        "version-below-resident",
        `the container holds ${app.name} ${resident}, above this project's app.json ${app.version}. LethAL publishes a test app at its own version and never mints one. Clear the resident record (Sync-NAVApp -Mode Clean, see .claude/skills/control-app) or raise app.json above ${resident}.`,
        resident,
      );
    }
  }
  // null: never published, or unreadable. BC's own downgrade refusal inside the fence is the backstop.
  return fence.publish(async () => {
    let publishError: string | undefined;
    try {
      await deps.publisher.publish(app);
    } catch (err) {
      publishError = describeThrown(err);
    }
    const after = await deps.readPublished(key);
    const afterBytes = after instanceof Uint8Array ? after : undefined;
    const verification: DeploymentVerification =
      afterBytes === undefined
        ? {
            status: "unavailable",
            detail: "the server's package could not be read back after the publish",
          }
        : hashPackage(afterBytes) === app.sha256
          ? { status: "accepted" }
          : { status: "mismatch", reported: hashPackage(afterBytes) };
    const outcome = decideTestAppOutcome(publishError, verification);
    if (outcome !== "accepted" || afterBytes === undefined) {
      throw new TestAppError(
        // "accepted" here only narrows the type: accepted implies afterBytes is defined.
        `publish-${outcome === "accepted" ? "indeterminate" : outcome}`,
        describeOutcome(publishError, verification, app),
        parseVersionConflict(publishError ?? "") ?? undefined,
      );
    }
    // Inside the fence the bytes landed, so a parse failure leaves the result unstated: it must be
    // non-terminal (marker kept, recycle), never the pre-fence `manifest-unreadable`.
    let version: string;
    try {
      version = readAppIdentity(Buffer.from(afterBytes)).version;
    } catch (err) {
      throw new TestAppError(
        "publish-indeterminate",
        `${app.name}: the server holds the compiled package (${app.sha256}) but its manifest cannot be read: ${describeThrown(err)}`,
      );
    }
    return {
      appId: app.appId,
      name: app.name,
      publisher: app.publisher,
      version,
      sha256: app.sha256,
      compiledAgainst: app.compiledAgainst,
    };
  });
}

/**
 * The target's rule (decidePublishOutcome), with two stricter cases for a FAILED exit (ruling 1,
 * review r1). `publishError` is altool's failure text, `undefined` on exit 0.
 * - An UNAVAILABLE read-back is unknown, never failed: `null` from fetchPublishedAppPackage is a
 *   timeout or a refused connection, which cannot show the publish did not land.
 * - A READABLE read-back that is not our bytes is `failed` only when the failure text itself
 *   proves BC refused the publish (BC's downgrade refusal, read by `parseVersionConflict`).
 *   Otherwise it is unknown: altool may have lost its response after dispatch while BC is still
 *   applying the publish, and one immediate read of the old bytes cannot rule that out.
 */
export function decideTestAppOutcome(
  publishError: string | undefined,
  verification: DeploymentVerification,
): PublishOutcome {
  if (publishError !== undefined && verification.status === "unavailable") return "indeterminate";
  const outcome = decidePublishOutcome(publishError === undefined, verification);
  if (outcome === "failed" && parseVersionConflict(publishError ?? "") === null) {
    return "indeterminate";
  }
  return outcome;
}
