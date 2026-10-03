import { AppMethodIndex, type CompiledTest, readPackageEntry } from "./app-package";
import type { TestMethodRef } from "./backend";
import type { ArmAwareDiscovery } from "./discovery";

/**
 * R403 phase B: which build of the TEST app a bcdev session runs, read from the compiled package.
 *
 * Arm-aware discovery (phase A) knows which `[Test]` methods the test app's DERIVED symbol set
 * compiles. bcdev runs whatever test app was published, built with whatever symbols its builder
 * used. The package's `SymbolReference.json` lists only compiled-in methods (measured, plan §1;
 * the embedded source holds every arm and is not evidence), so it is the one thing that can say
 * whether the derived set describes the published build.
 *
 * - Compiled evidence, equal membership: the session runs the FILTERED suite.
 * - Compiled evidence, unequal in EITHER direction: `TestAppDiffersError`, before the baseline.
 * - No compiled evidence: the UNFILTERED suite, as before R403, and `test-symbols-unverified`.
 */

/** A package's compiled test membership, or why it has none. */
export type CompiledMembership =
  | { readonly kind: "read"; readonly tests: readonly CompiledTest[] }
  | { readonly kind: "none"; readonly why: string };

/**
 * The compiled tests of one `.app` package. Never throws: a package with no readable
 * `SymbolReference.json` is the no-evidence case (plan §3(c)), which keeps today's behaviour and
 * says so, rather than a reason to stop a run that would otherwise be fine.
 */
export function compiledMembershipOf(pkg: Uint8Array): CompiledMembership {
  const buf = Buffer.from(pkg.buffer, pkg.byteOffset, pkg.byteLength);
  let entry: Buffer | null;
  try {
    entry = readPackageEntry(buf, "SymbolReference.json");
  } catch (err) {
    return { kind: "none", why: `the package is not a readable zip (${describe(err)})` };
  }
  if (entry === null) return { kind: "none", why: "the package carries no SymbolReference.json" };
  let text = entry.toString("utf8");
  // AL writes SymbolReference.json with a UTF-8 BOM.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { kind: "none", why: `its SymbolReference.json is not valid JSON (${describe(err)})` };
  }
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    return { kind: "none", why: "its SymbolReference.json is not a JSON object" };
  }
  return { kind: "read", tests: AppMethodIndex.fromSymbolReference(json).compiledTests() };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The comparison key: codeunit id plus the method name lower-cased (AL names are not
 *  case-sensitive, so `onlyUnderX` in source and `OnlyUnderX` compiled are one test). */
function membershipKey(codeunitId: number, method: string): string {
  return `${codeunitId}:${method.toLowerCase()}`;
}

export interface TestMembershipDifference {
  /** Compiled into the package, not in the source's suite: `Codeunit.method`, sorted. */
  readonly publishedOnly: readonly string[];
  /** In the source's suite, not compiled into the package: `Codeunit.method`, sorted. */
  readonly sourceOnly: readonly string[];
}

/**
 * Compiled membership against the source suite, both counted before any execution refusal.
 * `inScopeCodeunits` (`--tests-only`): a compiled codeunit outside it is skipped; the source side
 * was already narrowed to the same files by discovery.
 */
export function compareTestMembership(
  compiled: readonly CompiledTest[],
  source: readonly TestMethodRef[],
  inScopeCodeunits?: ReadonlySet<number>,
): TestMembershipDifference {
  const inScope = compiled.filter(
    (t) => inScopeCodeunits === undefined || inScopeCodeunits.has(t.codeunitId),
  );
  const compiledKeys = new Set(inScope.map((t) => membershipKey(t.codeunitId, t.method)));
  const sourceKeys = new Set(source.map((t) => membershipKey(t.codeunitId, t.method)));
  const publishedOnly = inScope
    .filter((t) => !sourceKeys.has(membershipKey(t.codeunitId, t.method)))
    .map((t) => `${t.codeunitName}.${t.method}`);
  const sourceOnly = source
    .filter((t) => !compiledKeys.has(membershipKey(t.codeunitId, t.method)))
    .map((t) => `${t.codeunitName}.${t.method}`);
  return {
    publishedOnly: [...new Set(publishedOnly)].sort(),
    sourceOnly: [...new Set(sourceOnly)].sort(),
  };
}

/** R403 phase B: the published test app is not the build LethAL discovered. Refused before the
 *  baseline: measuring it would score a suite nobody can reconstruct (the R31 class, named). */
export class TestAppDiffersError extends Error {
  readonly code = "test-app-differs" as const;
  readonly publishedOnly: readonly string[];
  readonly sourceOnly: readonly string[];
  readonly buildSymbols: readonly string[];

  constructor(diff: TestMembershipDifference, buildSymbols: readonly string[]) {
    const names = (n: readonly string[]) => (n.length === 0 ? "none" : n.join(", "));
    super(
      `the published test app's compiled tests differ from the tests LethAL discovered in the test source under symbols [${buildSymbols.join(", ")}]: published-only ${names(diff.publishedOnly)}; source-only ${names(diff.sourceOnly)}. Possible causes: the test app was built with other preprocessor symbols (set preprocessorSymbols in the config or the test app.json), or a test was added, renamed or removed in the source without republishing.`,
    );
    this.name = "TestAppDiffersError";
    this.publishedOnly = diff.publishedOnly;
    this.sourceOnly = diff.sourceOnly;
    this.buildSymbols = buildSymbols;
  }
}

/** R403 phase B: an env-tool `publishApps` file that cannot be read as a BC app package before the
 *  lease. Every such file is published under the lease, where it would fail too (an unreadable one
 *  is `publishFile`'s pre-publish `ArtifactPrepareError`; a non-package one is refused by the
 *  server). Skipping it instead could fall back to checking the pre-lease package, possibly the
 *  OUTGOING build, which plan §3(b) says must not decide anything. A caller-contract violation. */
export class PublishAppUnreadableError extends Error {
  readonly code = "publish-app-unreadable" as const;
  readonly path: string;

  constructor(path: string, cause: string) {
    super(
      `the env-tool publishApps file ${path} cannot be read as a BC app package (${cause}). Every publishApps file is published under the lease and this one would fail there, so refusing before the lease rather than checking the test app against the package the server held before it (R403). Fix or remove the entry in publishApps.`,
    );
    this.name = "PublishAppUnreadableError";
    this.path = path;
  }
}

/** Throws `TestAppDiffersError` unless the membership is equal in both directions. */
export function assertTestMembership(
  compiled: readonly CompiledTest[],
  discovery: Pick<ArmAwareDiscovery, "filtered" | "inScopeCodeunits" | "buildSymbols">,
): void {
  const diff = compareTestMembership(compiled, discovery.filtered, discovery.inScopeCodeunits);
  if (diff.publishedOnly.length > 0 || diff.sourceOnly.length > 0) {
    throw new TestAppDiffersError(diff, discovery.buildSymbols);
  }
}

/**
 * Where a session's test-arm decision came from. Internal: it becomes the `test-symbols-unverified`
 * caveat and the `excludedTests` / `testBuildSymbols` report fields in R-403 phase C.
 */
export type TestArmEvidence =
  /** al-runner compiles the tests itself from exactly the derived set: no package to read. */
  | { readonly kind: "derived" }
  /** A compiled package says which build runs. `path` names an env-tool `publishApps` file. */
  | {
      readonly kind: "compiled";
      readonly from: "published-package" | "env-tool-publish";
      readonly path?: string;
    }
  /** No compiled evidence: the UNFILTERED suite runs, and `files` (the test files with an `#if`
   *  around a `[Test]`) are what `test-symbols-unverified` will name. */
  | {
      readonly kind: "none";
      readonly why: string;
      readonly caveat: "test-symbols-unverified";
      readonly files: readonly string[];
    };

/** The suite a session runs, from the evidence. Only "none" keeps the unfiltered suite: an
 *  unchecked drop of a test is never made. */
export function chooseTestSuite(
  discovery: Pick<ArmAwareDiscovery, "filtered" | "unfiltered">,
  evidence: TestArmEvidence,
): { readonly tests: TestMethodRef[]; readonly armPolicyApplied: boolean } {
  return evidence.kind === "none"
    ? { tests: discovery.unfiltered, armPolicyApplied: false }
    : { tests: discovery.filtered, armPolicyApplied: true };
}

/** The no-evidence record. */
export function noTestArmEvidence(
  why: string,
  discovery: Pick<ArmAwareDiscovery, "conditionalTestFiles">,
): TestArmEvidence {
  return {
    kind: "none",
    why,
    caveat: "test-symbols-unverified",
    files: discovery.conditionalTestFiles,
  };
}
