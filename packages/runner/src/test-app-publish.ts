import { chmod, cp, lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { type AppJsonPathChange, normaliseAppJsonPaths } from "./app-json-paths";
import { compareAppVersions, confirmedDowngradeRefusal } from "./app-version";
import type { PublishIdentity } from "./app-version";
import { AlcCompileError, type ArtifactCompiler } from "./artifact";
import { type BoundArtifact, type PublishedPackageRead, isUnread } from "./backend";
import { hashPackage } from "./baseline-snapshot";
import {
  type DeploymentVerification,
  type PublishOutcome,
  decidePublishOutcome,
} from "./deployment-verifier";
import { describeThrown } from "./describe-error";
import type { LeaseFence } from "./orchestrator";
import { readAppIdentity, symbolPackageId } from "./published-test-app";
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
  | "resident-unreadable" // R248: a pre-fence read answered null, before the fence
  | "version-below-resident" // decision 3, before the fence
  | "publish-failed" // decision 2's table
  | "publish-indeterminate"
  | "publish-anomalous";

/** Reasons `confirmedTerminal` treats as terminal below. */
const TERMINAL_REASONS: ReadonlySet<TestAppRefusal> = new Set<TestAppRefusal>([
  "publish-failed",
  "unsupported",
  "resident-unreadable",
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
  /** R811: what `stageTestProject` rewrote, for the caller's warning. Absent when nothing was. */
  readonly pathChanges?: readonly AppJsonPathChange[];
}

/** R811: R422's rewrite of a test app.json's text; no changes when it does not parse as an object. */
export function testAppPathRewrite(appJsonText: string): ReturnType<typeof normaliseAppJsonPaths> {
  let parsed: unknown;
  try {
    const noBom = appJsonText.charCodeAt(0) === 0xfeff ? appJsonText.slice(1) : appJsonText;
    parsed = JSON.parse(noBom);
  } catch {
    return { manifest: {}, changes: [] };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { manifest: {}, changes: [] };
  }
  return normaliseAppJsonPaths(parsed as Record<string, unknown>);
}

/**
 * R811: where alc should compile a test project. With no `\` in app.json's path fields, the test
 * dir itself (`changes` is empty): today's path, byte for byte. With one, a copy at `copyTo` whose
 * app.json is R422's rewrite of `appJsonText`, so the user's project is never written. An app.json
 * that does not parse stays in place, for alc to name. The copy drops only what lies under
 * `.alpackages` and `.git`, and never an `.al` file: alc compiles those wherever they are, and the
 * key and proof hash them, so a dropped one would be a byte they name and alc never saw. `cp` keeps
 * modes, so the copy is made writable: a read-only project must still compile, and go away after.
 */
export async function stageTestProject(
  testDir: string,
  appJsonText: string,
  copyTo: string,
): Promise<{ readonly projectDir: string; readonly changes: readonly AppJsonPathChange[] }> {
  const { manifest, changes } = testAppPathRewrite(appJsonText);
  if (changes.length === 0) return { projectDir: testDir, changes };
  const dropped = new Set([".alpackages", ".git"]);
  const modes: { readonly path: string; readonly mode: number }[] = [];
  try {
    await cp(testDir, copyTo, {
      recursive: true,
      filter: async (src, dest) => {
        const st = await lstat(src);
        const keep =
          st.isDirectory() ||
          src.toLowerCase().endsWith(".al") ||
          !relative(testDir, src)
            .split(sep)
            .some((s) => dropped.has(s));
        if (keep && !st.isSymbolicLink()) {
          modes.push({ path: dest, mode: st.mode | (st.isDirectory() ? 0o700 : 0o600) });
        }
        return keep;
      },
    });
    for (const { path, mode } of modes) await chmod(path, mode); // parents first, as cp walks
    await writeFile(join(copyTo, "app.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  } catch (err) {
    throw new TestAppError(
      "compile-failed",
      `could not copy ${testDir} to rewrite its app.json paths (R811): ${describeThrown(err)}`,
    );
  }
  return { projectDir: copyTo, changes };
}

/** R811: the warning for the rewrite `stageTestProject` made, once per session. */
export function testAppPathWarning(changes: readonly AppJsonPathChange[]): string {
  const parts = changes.map((c) => `${c.field} "${c.from}" -> "${c.to}"`).join("; ");
  return `the test project's app.json names a path with "\\": ${parts}. LethAL compiled a copy with "/", because the Linux alc reads "\\" as part of the name and fails with AL1001 or AL0863. Your project's own app.json was not changed; write "/" there to remove this warning.`;
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

export { symbolPackageId } from "./published-test-app";

function identityOf(bytes: Buffer, what: string): string {
  try {
    return symbolPackageId(bytes);
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
  const sourceCopy = await mkdtemp(join(tmpdir(), "lethal-testapp-source-"));
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

    const { projectDir, changes } = await stageTestProject(
      a.testDir,
      await readFile(join(a.testDir, "app.json"), "utf8"),
      join(sourceCopy, "project"),
    );
    let out: { readonly appPath: string; readonly sha256: string };
    try {
      out = await a.compiler.compileProject({
        projectDir,
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
      ...(changes.length > 0 ? { pathChanges: changes } : {}),
    };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
    await rm(sourceCopy, { recursive: true, force: true }).catch(() => {});
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
 * The server's package for this app: bytes, `{ unread }` naming why the read did not answer (never
 * published, timeout, refused; R630), `undefined` when this configuration cannot form the request.
 */
export type ReadPublished = (app: {
  readonly publisher: string;
  readonly name: string;
}) => Promise<PublishedPackageRead>;

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
  // R248: a caller of publishTestApp always has a resident test app already (verify's baseline
  // just ran it; itest:testapp publishes over one too). Refuse before the fence (no marker
  // claimed) rather than let the publish go ahead and land on publish-indeterminate, which would
  // strand the container needing a recycle over a config mistake. R630: the cause is named, and
  // the credentials hint follows only a refused login, the never-published one only a 404.
  if (isUnread(before)) {
    const hint = /^HTTP 40[13]\b/.test(before.unread)
      ? ": check the dev-endpoint read credentials (BC_DEV_USER / BC_DEV_PASSWORD)"
      : /^HTTP 404\b/.test(before.unread)
        ? ": check that the app has ever been published, and the dev-endpoint path"
        : "";
    throw new TestAppError(
      "resident-unreadable",
      `the resident ${app.name} package could not be read before publishing (${before.unread})${hint}`,
    );
  }
  const resident = versionOf(before);
  if (compareVersionsOrRefuse(app.version, resident) < 0) {
    throw new TestAppError(
      "version-below-resident",
      `the container holds ${app.name} ${resident}, above this project's app.json ${app.version}. LethAL publishes a test app at its own version and never mints one. Clear the resident record, or raise app.json above ${resident}. To clear it: on a BC server on Linux, call the automation API's (v2.0, under the config's apiBaseUrl) bound actions Microsoft.NAV.uninstall, then Microsoft.NAV.unpublish, on the extension's packageId (no BcContainerHelper needed); on a Windows container, run UnPublish-BcContainerApp, then Sync-NAVApp -Mode Clean (see .claude/skills/control-app).`,
      resident,
    );
  }
  // BC's own downgrade refusal inside the fence is still the backstop for an in-fence read.
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
            detail: `the server's package could not be read back after the publish${isUnread(after) ? ` (${after.unread})` : ""}`,
          }
        : hashPackage(afterBytes) === app.sha256
          ? { status: "accepted" }
          : { status: "mismatch", reported: hashPackage(afterBytes) };
    const outcome = decideTestAppOutcome(publishError, verification, app);
    if (outcome !== "accepted" || afterBytes === undefined) {
      throw new TestAppError(
        // "accepted" here only narrows the type: accepted implies afterBytes is defined.
        `publish-${outcome === "accepted" ? "indeterminate" : outcome}`,
        describeOutcome(publishError, verification, app),
        confirmedDowngradeRefusal(publishError ?? "", app) ?? undefined,
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
 * - An UNAVAILABLE read-back is unknown, never failed: an `{ unread }` from fetchPublishedAppPackage
 *   is a timeout or a refused connection, which cannot show the publish did not land.
 * - A READABLE read-back that is not our bytes is `failed` only when the failure text itself
 *   proves BC refused THIS publish (BC's downgrade sentence naming this app, publisher and
 *   version, read by `confirmedDowngradeRefusal`, R250).
 *   Otherwise it is unknown: altool may have lost its response after dispatch while BC is still
 *   applying the publish, and one immediate read of the old bytes cannot rule that out.
 */
export function decideTestAppOutcome(
  publishError: string | undefined,
  verification: DeploymentVerification,
  app: PublishIdentity,
): PublishOutcome {
  if (publishError !== undefined && verification.status === "unavailable") return "indeterminate";
  const outcome = decidePublishOutcome(publishError === undefined, verification);
  if (outcome === "failed" && confirmedDowngradeRefusal(publishError ?? "", app) === null) {
    return "indeterminate";
  }
  return outcome;
}
