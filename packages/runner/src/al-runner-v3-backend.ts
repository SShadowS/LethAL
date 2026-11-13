/**
 * R586: the `al-runner-v3` backend, for the Rust al-runner (`alrunner 3.0.0-alpha.N`), beside the
 * frozen .NET al-runner (`al-runner-backend.ts`), which it shares no state with.
 * Plan: `docs/superpowers/plans/2026-10-21-r586-alrunner-v3-backend.md` (r4); figures:
 * `docs/superpowers/specs/2026-10-21-r586-alrunner-v3-precommitment.md`.
 *
 * What is different from v2, and why (each measured on alpha.2, `/coord/handoff/R-586/`):
 * - v3 runs code that does not compile and passes its tests (#5602). So `deploy()` compiles every
 *   batch AND the test app with alc first, and `run()` refuses to start v3 unless the bytes v3
 *   would read are still the bytes alc proved (§3).
 * - v3 runs a selected test's whole codeunit (#5611) and cannot select a quoted-name test by name
 *   (#5572). So one call per test codeunit, `--codeunit <id>`, rows read by `codeunit` + `method`.
 * - A not-run row is never killed and never survived; a timeout row is a CPU-time stop (§5).
 * - `Sleep` does nothing (#5605): a covering pass that reaches a project Sleep reads `error` (§6,
 *   `al-runner-v3-sleep.ts`). EXCEPT (R-762 B) on a pinned build whose pin and session probe both
 *   read `sleep-is-noop` gone (`sleepRuleRetiredFor`): there §6 is off, a mutant call passes no
 *   `--coverage-json`, and serve-entries opens no coverage window.
 * The static selector is one-shot's (`selectorMode: "resource"` is refused by name).
 * R635 adds the transport `transport: "serve-entries"`, the default since R761 where it is proven
 * (else one-shot, with a named warning; an explicit key is honoured; see `decideTransport`) (plan
 * `docs/superpowers/plans/2026-10-22-r635-v3-serve-entries.md`, r3): the baseline stays one-shot,
 * every other run goes to a warm `serve` daemon as entries with a per-entry resource override,
 * each mutant's group vouched for by an echo test (`al-runner-v3-entries.ts`).
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { freemem } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  CONTROL_REGISTER_FILENAME,
  CONTROL_SELECTOR_FILENAME,
  CONTROL_UPGRADE_FILENAME,
  SELECTOR_RESOURCE_FOLDER,
  SELECTOR_RESOURCE_NAME,
  SELECTOR_RESOURCE_NONE,
  emitResourceSelector,
  emitStaticSelector,
} from "@lethal/schemata";
import {
  type AlRunnerCoverageIndex,
  alRunnerCoverageFromServer,
  buildAlRunnerCoverageIndex,
  normalizeFileKey,
} from "./al-runner-coverage";
import { V3_TIMEOUT_MESSAGE, isV3RefusalText, verdictFromRunnerTest } from "./al-runner-rows";
import {
  AlRunnerServer,
  AlRunnerServerRequestError,
  MAX_TIMER_MS,
  type ServerSpawnFn,
  type ServerTestLine,
  V3_SERVE_SAFE_REFUSALS,
  defaultServerSpawn,
  serveDaemonReusable,
} from "./al-runner-server";
import {
  type MemorySample,
  baselineSampleIds,
  compareBaselineAnswers,
  durationCouldMoveBudget,
  memoryBoundBytes,
  readCgroupMemory,
} from "./al-runner-v3-baseline-check";
import {
  V3_DOWNLOAD_DEMO_DATA_DEFAULT,
  V3_NO_CLIENT_DEFAULT,
  assertBcVersionMatchesPackages,
} from "./al-runner-v3-config";
import {
  type V3ContractResult,
  runV3ContractProbe,
  v3ContractRefusals,
  v3ContractSummary,
  v3DefectWarnings,
} from "./al-runner-v3-contract";
import {
  AlRunnerV3EntriesRefusedError,
  ENTRIES_CHUNK_CAP,
  type EntryGroup,
  type IsolatedSelection,
  SELECTOR_ECHO_FILENAME,
  type SentCut,
  type SentEntry,
  batchRefusalReason,
  callOf,
  chunkGroups,
  decodeEntriesAnswer,
  echoMismatch,
  emitSelectorEcho,
  encodeGroups,
  isolatedSelection,
  serveRow,
} from "./al-runner-v3-entries";
import { type V3EnvironmentChoice, V3EnvironmentUnknownError } from "./al-runner-v3-environment";
import {
  AlRunnerV3UngatedBuildError,
  type GatedBuild,
  V3_NO_SERVE_ENTRIES,
  checkGated,
  pinnedSidecar,
  resolveV3Binary,
  sha256OfFile,
  v3InstallHint,
} from "./al-runner-v3-pin";
import {
  pinnedDefectCoverage,
  serveRowFieldsFor,
  sleepRuleLine,
  sleepRuleRetiredFor,
} from "./al-runner-v3-pins";
import {
  FRESH_PROBE_ENV,
  type ProbeCacheKey,
  alcIdentity,
  keyDigest,
  packagesFingerprint,
  probeCodeHash,
  readProbeCache,
  uncacheableReason,
  writeProbeCache,
} from "./al-runner-v3-probe-cache";
import { AlRunnerV3SeedError, checkRunSeed, v3ChildEnv } from "./al-runner-v3-seed";
import {
  AlRunnerV3CoverageJoinError,
  type SleepIndex,
  type V3CoverageRead,
  buildSleepIndex,
  decodeV3Coverage,
  sleepCallRefusal,
  sleepJoinRefusal,
  sleepPassRefusal,
} from "./al-runner-v3-sleep";
import {
  TestAppProofStore,
  alcSha256,
  appJsonForKey,
  mintedVersionSatisfiesTestApp,
  symbolInterfaceForKey,
  testAppCacheKey,
} from "./al-runner-v3-testapp-cache";
import {
  AlcCompileError,
  ArtifactCompiler,
  type ArtifactIo,
  ArtifactPrepareError,
  defaultArtifactIo,
} from "./artifact";
import type {
  BackendCapabilities,
  BackendStatus,
  CoverageMap,
  ExecutionBackend,
  RunOpts,
  TestMethodRef,
  TestVerdict,
} from "./backend";
import {
  type OtherFile,
  hashAlTree,
  hashTestDir,
  listOtherFiles,
  otherFilesDrift,
  scanTestDir,
} from "./baseline-snapshot";
import { assertManifestObjectsDeclared, readManifestObjectKeys } from "./line-map";
import { type SpawnFn, absToolPath, defaultSpawn } from "./publisher";
import { assertResourceSelectorRuntime, installResourceSelector } from "./resource-selector";
import type { ResumeInputs } from "./store";
import {
  TestAppError,
  stageTestProject,
  symbolPackageId,
  testAppPathRewrite,
  testAppPathWarning,
} from "./test-app-publish";
import { LINK_EXCUSED_DIRS, ProjectSymlinkRefusedError, walkFilesSync } from "./walk";

/**
 * `--version` of a v3 build: `alrunner 3.0.0-alpha.2 (91253f2d6)` (alpha.3 renamed it `al-runner`).
 * R639 F1: an edge build carries SemVer build metadata, `al-runner 3.0.0-alpha.4+edge.20261022
 * (57f1e4f98)`; the metadata is one or more of `[0-9A-Za-z.-]`, never empty and never a space.
 */
export const AL_RUNNER_V3_VERSION =
  /^al-?runner 3\.\d+\.\d+(?:-[\w.]+)?(?:\+[0-9A-Za-z.-]+)? \([0-9a-f]+\)$/;

/** v3's refusal row prefix; R675 moved its one source to `al-runner-rows.ts`. */
export { V3_REFUSAL_PREFIX } from "./al-runner-rows";

/** v3's timeout row (`notRun: true`), anchored: `Test exceeded <N>s timeout.` (R895: source in `al-runner-rows.ts`) */
export { V3_TIMEOUT_MESSAGE };

/**
 * The end of a v3 refusal's verdict text (a notRun `error` row that is not a timeout). R678: a
 * reused snapshot's refusals are read back by it. Changing its text needs an IDENTITY_SCHEME bump:
 * otherwise a same-build snapshot stored under the old text is lent, and its refusals lose their
 * `[v3-refused-test-nearby]` notes on a resume.
 */
const V3_NOT_RUN_SUFFIX =
  "[al-runner v3 did not run this test (notRun), so whether the mutant changes its outcome on BC is unknown: NOT scored (R586 §5)]";

/**
 * R956: al-runner's own refusal text for a test that needs a license it was not given. Only a message
 * that holds it gets the pointer; every other refusal text is unchanged (so no stored text moves).
 */
export function licensePointer(message: string | undefined): string {
  return message?.includes("with no license file loaded") === true
    ? " [set alRunnerV3.license to a .bclicense file (R956)]"
    : "";
}

/**
 * R678: a reused snapshot's stored verdict carries the v3 notRun refusal text but not
 * `runnerRow: "runner-refused"`, so whether v3 refused it cannot be told. Refused loudly rather
 * than recording nothing.
 */
export class AlRunnerV3ReusedBaselineUnclassifiedError extends Error {
  constructor(readonly detail: string) {
    super(
      `al-runner-v3: ${detail}: a reused baseline verdict holds v3's notRun refusal text without runnerRow "runner-refused", so its refusal cannot be classified (R678)`,
    );
    this.name = "AlRunnerV3ReusedBaselineUnclassifiedError";
  }
}

/** The four note tags (plan §4, §6), in `failureNote`; the gate and any count read them by tag. */
/** The `testIsolation` every serve request sends (`requestBase`); leg O1 sends the same. */
export const SERVE_TEST_ISOLATION = "test";
export const V3_STATE_NOTE_TAG = "[v3-codeunit-state-possible]";
export const V3_REFUSED_NEARBY_TAG = "[v3-refused-test-nearby]";
/**
 * R652: a §5 window's 2-3 plain sends follow ONE bound check (the window's), so a tree change
 * after it can reach their rows. Those rows never make a kill, only an error; each such text says
 * so, so a reader does not blame the wrong cause. Worded to stay true on a LATER mutant's verdict
 * that carries a latched `batchBlind` note (build review L2).
 */
export const WINDOW_BOUND_CAVEAT =
  "a bound-tree change since a window's bound check (R652) is a possible cause";
const withWindowCaveat = (s: string): string => `${s}; ${WINDOW_BOUND_CAVEAT}`;

/** §3: the bytes v3 would read are not the bytes alc proved. Stops the session. */
export class AlRunnerV3UnprovenBatchError extends Error {
  constructor(what: string) {
    super(
      `al-runner-v3: refusing to start v3: ${what}. v3 runs code that does not compile (#5602), so it may only run the exact bytes LethAL's alc compile proved for this batch (R586 plan §3).`,
    );
    this.name = "AlRunnerV3UnprovenBatchError";
  }
}

/** R631/R655: a link under a bound root (`ProjectSymlinkRefusedError`) is unproven drift, by path. */
async function linkIsUnproven(hash: Promise<string>, where: string): Promise<string> {
  return hash.catch((err: unknown) => {
    if (err instanceof ProjectSymlinkRefusedError) {
      throw new AlRunnerV3UnprovenBatchError(`a link is in ${where} (${err.linkPath})`);
    }
    throw err;
  });
}

/** §5, #5613: exit 6, "the selection matched no test" (no document before the #5622 fix, 0 rows since). Stops the session. */
export class AlRunnerV3SelectionError extends Error {
  constructor(codeunitId: number, stderr: string) {
    super(
      `al-runner-v3: --codeunit ${codeunitId} selected no test (exit 6, #5613). stderr: ${stderr.slice(-400)}`,
    );
    this.name = "AlRunnerV3SelectionError";
  }
}

/**
 * R815: exit 6 has two meanings, told apart only by v3's words (measured on alpha.12 and alpha.13+edge,
 * `/coord/handoff/R-817/`). `error: the selection matches no test`: v3 stopped at the selection. A
 * `Result: NOTHING SELECTED (exit 6)` line: v3 RAN, and the codeunit gave no test row, which since
 * #5859 is what a raising OnRun does. Any other text is `unknown` and stops as a selection miss.
 */
export function exit6Kind(stderr: string): "selection-miss" | "ran-no-test" | "unknown" {
  if (/^error: the selection matches no test\r?$/m.test(stderr)) return "selection-miss";
  return /^Result: NOTHING SELECTED \(exit 6\)\r?$/m.test(stderr) ? "ran-no-test" : "unknown";
}

/** R815: why a codeunit ran and gave no test row, for the baseline's stop and a mutant's `error`. */
const ranNoTestWhy = (id: number): string =>
  `codeunit ${id} ran and gave no test row; its OnRun probably raised, and al-runner then runs none of its tests and reports nothing (upstream #5859)`;

/**
 * R815: on an unmutated build, a test codeunit ran and gave no test row. It is the user's suite, not a
 * selection miss, so it stops the session under its own name. Under a mutant the same exit reads `error`.
 */
export class AlRunnerV3NoTestRanError extends Error {
  constructor(codeunitId: number) {
    super(
      `al-runner-v3-codeunit-ran-no-test: ${ranNoTestWhy(codeunitId)}. This call scored no verdict. Run the codeunit on its own, and fix its OnRun or move that code out of it.`,
    );
    this.name = "AlRunnerV3NoTestRanError";
  }
}

/**
 * R944: al-runner's own compiler refused the app (`COMPILE ERRORS (exit 3)`) on a BASELINE call: the
 * artifact then holds no runnable app, so the refusal is the app's, not a test's: the session stops
 * once, by name, quoting the compiler's `error AL....` lines (a file, a position, a code and a symbol
 * name, as alc's own messages hold), not one failure per test. On a mutant call (a chunked or bisected
 * batch builds its own artifact) the same refusal stays that batch's transport failure.
 */
export class AlRunnerV3CompileRefusedError extends Error {
  constructor(readonly compilerLines: readonly string[]) {
    const shown = compilerLines.slice(0, 5).join("; ");
    super(
      `al-runner-v3-compile-refused: al-runner's compiler refused the app, so no test can run on v3: ${shown}${compilerLines.length > 5 ? `; and ${compilerLines.length - 5} more` : ""}. LethAL's alc built it; the difference is al-runner's (report it upstream; R944).`,
    );
    this.name = "AlRunnerV3CompileRefusedError";
  }
}

/** R944: the compiler lines of an al-runner exit 3 that says the apps do not compile; undefined otherwise. */
export function v3CompileRefusal(exitCode: number, output: string): string[] | undefined {
  if (exitCode !== 3 || !/COMPILE ERRORS \(exit 3\)/.test(output)) return undefined;
  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /\berror AL\d+:/.test(l))
    .map((l) => l.replace(/^compile:\s*/, ""));
  return lines.length > 0 ? [...new Set(lines)] : ["(no error AL line in its output)"];
}

/**
 * R590 (R-537): v3's stderr lines that say it ran WITHOUT a dependency app: `dependency skipped: ...`
 * (no package with AL source was found, so the whole app is left out), or `... N more dependency
 * notes` (v3 prints 12 problem lines and hides the rest, the skipped ones last). Matched at line start.
 */
export function v3DependencySkipLines(stderr: string): string[] {
  return stderr
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter(
      (l) => l.startsWith("dependency skipped:") || /^\.\.\. \d+ more dependency notes/.test(l),
    );
}

/**
 * R885: v3's note when a test app needs the CRONUS demo data and the data is not there:
 * `note: test data is off: the demo data of build <build> is not cached and --no-download is set. ...`
 * Matched by the stable prefix at line start; the build is read from it, never matched.
 * (The text after the prefix differs when the download itself fails; the prefix is the same.)
 */
export function v3TestDataOffNote(text: string): { readonly build: string } | undefined {
  const m = /^note: test data is off:(.*)$/m.exec(text);
  if (m === null) return undefined;
  return { build: /\bbuild (\d+(?:\.\d+)+)/.exec(m[1] ?? "")?.[1] ?? "" };
}

/** R885: v3 starts a demo-data download: `test data: downloading the w1 demo data of build <b> ...`. */
export function v3DemoDownloadStarts(text: string): boolean {
  return /^test data: downloading the /m.test(text);
}

/**
 * R885: the demo backup al-runner keeps for `build`: `<cacheDir>/artifacts/<build>/demo/w1/*.bak`
 * (ADR-020, seen on disk). `undefined` when there is none. Other places al-runner may read from
 * (`~/.bcartifacts.cache`, a named .bak, another build) are not looked at: the pre-run line is only
 * "may download", not a fault.
 */
export function demoBackupPath(cacheDir: string, build: string): string | undefined {
  const dir = join(resolve(cacheDir), "artifacts", build, "demo", "w1");
  try {
    const bak = readdirSync(dir).find((f) => f.toLowerCase().endsWith(".bak"));
    return bak === undefined ? undefined : join(dir, bak);
  } catch {
    return undefined;
  }
}

/** R885: size and sha256 of a file, read in chunks (about 1-2 s for the 549 MB backup, once). */
export function describeBackup(path: string): string {
  try {
    const size = statSync(path).size;
    const hash = createHash("sha256");
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(8 * 2 ** 20);
      for (
        let n = readSync(fd, buf, 0, buf.length, null);
        n > 0;
        n = readSync(fd, buf, 0, buf.length, null)
      )
        hash.update(buf.subarray(0, n));
    } finally {
      closeSync(fd);
    }
    return `${size} bytes, sha256 ${hash.digest("hex")}`;
  } catch (e) {
    return `not readable (${e instanceof Error ? e.message : String(e)})`;
  }
}

/** R885: the one line shown on the console, in the report and in the baseline note. */
export function testDataOffLine(build: string, noDownload: boolean): string {
  const which = build === "" ? "the demo data" : `the demo data of build ${build}`;
  const fix = noDownload
    ? `"alRunnerV3.downloadDemoData" is false (--no-download): fill the cache once with "al-runner warm", or run once with "downloadDemoData": true.`
    : `Fill the cache once with "al-runner warm", check the network, or name a cache that holds it; set "alRunnerV3.downloadDemoData": false for an offline run.`;
  return `al-runner v3 says test data is off: ${which} is not in "alRunnerV3.cacheDir" (or v3 could not fetch it). Tests of a Microsoft-style test app that read CRONUS rows are refused. ${fix}`;
}

/**
 * R590: v3 left a dependency out. A call into it by id (`Codeunit.Run(<id>)`) then fails with BC's
 * missing-object text and would score a kill BC never gives (upstream #5749). Stops the session.
 */
export class AlRunnerV3DependencySkippedError extends Error {
  constructor(lines: readonly string[]) {
    super(
      `al-runner-v3: v3 ran without a dependency app, so a call into it by id fails with BC's missing-object error and would score a kill BC never gives (R590); refusing the session. v3 needs each dependency's .app with AL source (or its source archive) in <deps>; a "more dependency notes" line means v3 hid lines that --verbose lists. v3 said: ${lines.join(" | ").slice(0, 1200)}`,
    );
    this.name = "AlRunnerV3DependencySkippedError";
  }
}

/** R590: throws `AlRunnerV3DependencySkippedError` when `stderr` has a skip line. */
function refuseDependencySkip(stderr: string): void {
  const lines = v3DependencySkipLines(stderr);
  if (lines.length > 0) throw new AlRunnerV3DependencySkippedError(lines);
}

/**
 * R860 (upstream #7139): from edge a461e6310, with `--no-download`, v3 STOPS when a dependency app is
 * not found: one-shot exit 2 with `error: N dependency app(s) were not found and --no-download is
 * set ...` on stderr; `serve` answers the request with an `{"error": "N dependency app(s) were not
 * found ..."}` line. Older builds print `dependency skipped:` and run on (R590 above).
 */
const MISSING_DEPENDENCY_RE = /(\d+) dependency app\(s\) were not found and --no-download is set/;
const MISSING_APP_RE =
  /dependency `([^`]+)` by (.+?) \(([^)]+)\) version (\S+) or higher was not found/g;

export interface V3MissingDependencies {
  /** The apps named, as written in app.json. */
  readonly apps: readonly string[];
  /** How many apps v3's header says are missing; more than `apps.length` when some are not named. */
  readonly declared: number;
  /** v3 found a package for it with no AL source (its text: "found only packages without AL source"). */
  readonly withoutSource: boolean;
}

/** Parses a new-form refusal; undefined: the text is not that refusal. */
export function v3MissingDependencies(text: string): V3MissingDependencies | undefined {
  const head = MISSING_DEPENDENCY_RE.exec(text);
  if (head === null) return undefined;
  return {
    apps: [...text.matchAll(MISSING_APP_RE)].map(
      (m) => `"${m[1]}" by ${m[2]} (id ${m[3]}, version ${m[4]} or higher)`,
    ),
    declared: Number(head[1]),
    withoutSource: text.includes("found only packages without AL source"),
  };
}

/**
 * R860: the ONE test of the one-shot stop, used by the backend and by leg C's `dependency-skip-line`,
 * so the fact and a real run cannot disagree: exit 2 and the refusal header.
 */
export function v3MissingDependencyStop(
  exitCode: number,
  stderr: string,
): V3MissingDependencies | undefined {
  return exitCode === 2 ? v3MissingDependencies(stderr) : undefined;
}

/**
 * R860: v3 will not run because a dependency app is not in its package cache. Not a kill, not a
 * survivor, not retried: the session stops. Fix: put the app's `.app` file in `packagesDir`.
 */
export class AlRunnerV3DependencyMissingError extends Error {
  constructor(found: V3MissingDependencies, said: string) {
    const { apps, declared, withoutSource } = found;
    const unnamed = declared - apps.length;
    super(
      `al-runner-v3: v3 stopped because ${declared} dependency app(s) were not found (upstream #7139, R860): ${apps.length > 0 ? apps.join("; ") : "(none parsed)"}${unnamed > 0 ? `; ${unnamed} more app(s) are missing and not named here, so read v3's text below and expect to fix more than the ones named` : ""}. LethAL does not pass --allow-missing-dependencies: running without the app would score kills BC never gives. To fix it, put the app's .app file WITH AL SOURCE in packagesDir (the package folder LethAL gives v3), then run again. A symbols-only .app may stop the run again${withoutSource ? " (v3 found only packages without AL source for an app)" : ""}. v3 said: ${said.slice(0, 1200)}`,
    );
    this.name = "AlRunnerV3DependencyMissingError";
  }
}

/** R860: one-shot form (exit 2 and the stderr text). */
function refuseMissingDependency(exitCode: number, stderr: string): void {
  const found = v3MissingDependencyStop(exitCode, stderr);
  if (found !== undefined) throw new AlRunnerV3DependencyMissingError(found, stderr);
}

/** R860: serve form (a refused request); any other error passes through unchanged. */
function missingDependencyOr(err: unknown): unknown {
  if (err instanceof AlRunnerServerRequestError && err.kind === "error") {
    const found = v3MissingDependencies(err.message);
    if (found !== undefined) return new AlRunnerV3DependencyMissingError(found, err.message);
  }
  return err;
}

/** §4: a session-suite test has no row (or two) in its codeunit's call. At baseline it stops. */
export class AlRunnerV3RowMissingError extends Error {
  constructor(readonly detail: string) {
    super(`al-runner-v3: ${detail} (R586 plan §4, rows are cached only after a full decode)`);
    this.name = "AlRunnerV3RowMissingError";
  }
}

/** R764: a call made without `--coverage-json` was handed to a caller that wants coverage. */
export class AlRunnerV3NoCoverageCallReusedError extends Error {
  constructor(readonly ref: TestMethodRef) {
    super(
      `al-runner-v3: a call made without coverage was reused for ${ref.codeunitName}.${ref.method}, which wants coverage; refusing rather than reading it as "covered nothing" (R764)`,
    );
    this.name = "AlRunnerV3NoCoverageCallReusedError";
  }
}

/** S3: `selectorMode: "resource"` on v3 is refused by name (#5604 was a serve defect; v1 is one-shot). */
export class AlRunnerV3ResourceSelectorRefusedError extends Error {
  constructor() {
    super(
      'al-runner-v3-resource-selector-refused: the al-runner-v3 backend runs one-shot with the static selector only; selectorMode "resource" is refused (R586 plan §0, #5604).',
    );
    this.name = "AlRunnerV3ResourceSelectorRefusedError";
  }
}

/**
 * R907: `alRunnerV3.noClient` is on, but the running build's `test --help` does not list
 * `--no-client` (or the help call failed). Serve would send the request field to a build that may
 * ignore it, so the run would measure the wrong thing; refused before any run.
 */
export class AlRunnerV3NoClientUnsupportedError extends Error {
  constructor(
    readonly build: string,
    readonly why: string,
  ) {
    super(
      `al-runner-v3-no-client-unsupported: "alRunnerV3.noClient" is true, but ${build} cannot be shown to support --no-client (${why}). Use a build whose \`test --help\` lists --no-client, or set "alRunnerV3.noClient" to false (R907).`,
    );
    this.name = "AlRunnerV3NoClientUnsupportedError";
  }
}

/**
 * R761: an explicit `"transport": "serve-entries"` with a test METHOD name holding "." (upstream
 * #5798: the entries answer for it has no `codeunit`/`method`, measured on N1E). Refused before any
 * test runs, by name, instead of failing mid-session.
 */
export class AlRunnerV3ServeDottedTestNameError extends Error {
  constructor(readonly tests: readonly string[]) {
    super(
      `al-runner-v3-serve-dotted-test-name: "alRunnerV3.transport" is "serve-entries", but ${tests.length} discovered test(s) have a "." in the method name (${tests.slice(0, 5).join(", ")}${tests.length > 5 ? ", ..." : ""}). al-runner v3 returns no usable row for such a test under serve (upstream #5798), so the session would fail closed part-way (R761, R722). Set "alRunnerV3.transport": "one-shot" (or drop the key: it then falls back to one-shot for this project by itself).`,
    );
    this.name = "AlRunnerV3ServeDottedTestNameError";
  }
}

/** R857: `--isolate-tests` needs serve-entries; a one-shot session would run whole codeunits. */
export class AlRunnerV3IsolateTestsRefusedError extends Error {
  constructor(why: string) {
    super(
      `al-runner-v3-isolate-tests-refused: --isolate-tests needs the serve-entries transport, and this session cannot use it: ${why}. Nothing was run, as a one-shot run would run whole codeunits under a flag that says otherwise (R857).`,
    );
    this.name = "AlRunnerV3IsolateTestsRefusedError";
  }
}

/**
 * R896: THE switch for one-shot under `isolation: "auto"` once any codeunit runs on `"method"`
 * (reached on every `--resume` and on an R786 fallback). `"allow"` runs it, per test, with
 * `--isolation codeunit`; `"refuse"` stops the session by name at the switch. R857 once refused
 * one-shot for per-test runs; the per-mutant proof against serve decides which value stays.
 */
export const V3_AUTO_METHOD_ONE_SHOT: "allow" | "refuse" = "allow";

/** R896: `--isolate-tests` names one mode for every test; `isolation: "auto"` chooses per codeunit. */
export class AlRunnerV3IsolateTestsWithAutoRefusedError extends Error {
  constructor() {
    super(
      'al-runner-v3-isolate-tests-with-auto-refused: --isolate-tests runs every test alone, while "alRunnerV3.isolation" is "auto" (the default), which chooses a mode per test codeunit; the two cannot both hold. Set "alRunnerV3.isolation" to "test" to use --isolate-tests, or drop the flag (R896).',
    );
    this.name = "AlRunnerV3IsolateTestsWithAutoRefusedError";
  }
}

/** R896: `V3_AUTO_METHOD_ONE_SHOT` is "refuse" and a codeunit was to move to "method" on one-shot. */
export class AlRunnerV3AutoMethodOneShotRefusedError extends Error {
  constructor(codeunitId: number) {
    super(
      `al-runner-v3-auto-method-one-shot-refused: under "alRunnerV3.isolation": "auto", codeunit ${codeunitId} would run on "method" (each test alone), and this session runs the one-shot transport, where that mode is not proven per mutant against serve-entries. Nothing more is run. Set "alRunnerV3.isolation" to "test" or "method" (R896).`,
    );
    this.name = "AlRunnerV3AutoMethodOneShotRefusedError";
  }
}

/** R761: the transport was decided (or a v3 process had started) and a later decision was asked for. */
export class AlRunnerV3TransportFrozenError extends Error {
  constructor(why: string) {
    super(
      `al-runner-v3-transport-frozen: the transport cannot be decided now: ${why}. It is decided once, before the first al-runner process of the session (R761).`,
    );
    this.name = "AlRunnerV3TransportFrozenError";
  }
}

/**
 * R786: on the DEFAULT transport only, the serve-entries warm-up met a row that R612 refuses by name
 * (`isNamedRefusalRow`). One-shot scores that test per test, so the session is to be re-run as
 * one-shot. The backend that threw it has closed its daemon and is thrown away by the caller; the
 * one-shot session gets a NEW backend that carries only `reason` (for the warning and the status).
 * `abandonedRunId` is set by `runSession`, which marks that run so `--resume` skips it.
 */
export class AlRunnerV3ServeFallbackWarmupError extends Error {
  abandonedRunId?: number;
  constructor(
    readonly row: string,
    readonly rowReason: string,
  ) {
    super(
      `al-runner-v3-serve-default-fallback-warmup: the serve-entries default met the warm-up row ${row}, which R612 refuses by name (${rowReason}). \`lethal run\` (runFromCli) re-runs the session on one-shot; a caller of runSession directly gets this refusal and must do the same (R786)`,
    );
    this.name = "AlRunnerV3ServeFallbackWarmupError";
  }
}

/** R612's named refusal: a `notRun` error row that is not a timeout (the rule `noteBaselineRows` applies). */
function isNamedRefusalRow(r: V3Row): boolean {
  return (
    r.notRun === true &&
    r.status === "error" &&
    !(r.message !== undefined && V3_TIMEOUT_MESSAGE.test(r.message))
  );
}

/**
 * R761: the test-name shapes proven under serve-entries. Inventoried with `discoverTests` on D1, S1
 * and the gift card: plain method names, and codeunit names of letters, digits, `_`, space and `.`
 * (D1's "CDO Recipient Mgt. Tests", 21 tests).
 * R763: leg N1S ran fixtures/sandbox-names-tests WITHOUT `Dot.Step` under serve-entries, per mutant
 * equal to one-shot (0 differences over 36): it proves method names of letters, digits, `_`, space,
 * `-`, `(`, `)`, `/`, `&`, `å`, `æ`, with a leading digit allowed ("7Digit Step"). Exactly those: the
 * dot stays out (#5798), and any character N1S never ran (`ø`, `'`, `:`, ...) falls back.
 * Positions too: N1S's names start with a letter or digit and hold only single, inner spaces.
 * R922 (coord R-919): an invented test app with one test CODEUNIT per shape (`Names A/B Tests`,
 * `Names A-B Tests`, `Names (A) Tests`, `Names A&B Tests`, `Names Blåbær Tests`, `7Digit Names
 * Tests` and a plain one) ran under serve-entries and one-shot, per mutant equal (48 of 48,
 * `/coord/handoff/R-919/names/`). So a codeunit name may also hold `-`, `(`, `)`, `/`, `&`, `å`,
 * `æ` and start with a digit, when it starts with a letter or digit.
 * R922 item 3 (coord R-929): codeunit names are no longer gated at all. Serve addresses a codeunit by
 * id (`Codeunit<id>.`) and LethAL matches a row by `codeunit`, `method` and `name`
 * (`Codeunit<id>.<method>`), never by the row's `codeunitName`; one-shot passes `--codeunit <id>`.
 * Measured: test codeunits named `Names Ø Tests`, `Names A:B Tests`, `Names A'B Tests`, `-Lead ...`,
 * `(Lead) ...` and `/Lead ...` ran explicit serve-entries and one-shot per mutant equal (48 of 48,
 * `/coord/handoff/R-929/names/`), and the raw serve rows carry the name only in `codeunitName`.
 * A METHOD name outside the shape falls the default back to one-shot (`unproven-test-name-shape`).
 */
export const V3_SERVE_PROVEN_NAME_SHAPES = {
  method: /^[A-Za-z0-9](?:[A-Za-z0-9_()/&åæ-]| (?=[^ ]))*$/,
} as const;

/**
 * R922: the unproven method of a test, and the characters that make it so, for the
 * `unproven-test-name-shape` reason. A method whose every character is proven but whose position
 * is not (a leading space, say) is named with no characters.
 */
export function unprovenNamePart(method: string): string {
  const chars = [...new Set([...method].filter((c) => !/[A-Za-z0-9_ ()/&åæ-]/.test(c)))];
  return `method "${method}"${chars.length > 0 ? ` (${chars.map((c) => JSON.stringify(c)).join(" ")})` : ""}`;
}

/** R635 §3: the serve daemon was asked to start before `useMutantBudgetFloor` gave it a stop. */
export class AlRunnerV3ServeStopUnsetError extends Error {
  constructor() {
    super(
      "al-runner-v3: the serve-entries daemon needs the session's --mutant-timeout-ms floor and baseline timeout (useMutantBudgetFloor) before it starts, so it can send --test-timeout; refusing to start it with v3's own default stop (R635 §3, as R517).",
    );
    this.name = "AlRunnerV3ServeStopUnsetError";
  }
}

export interface AlRunnerV3Config {
  /** The v3 binary (`alrunner` / `al-runner`). */
  readonly alRunnerPath: string;
  /** §12: the update gate's run of an ungated CANDIDATE build; only the `.gated` check is relaxed. */
  readonly candidate?: boolean;
  /** LethAL-owned scratch; `active/`, `alc-out/` and `cov/` go under it. */
  readonly instrumentedDir: string;
  readonly testDir: string;
  /** `<deps>`: v3's `--package-cache`, and alc's package cache for both compiles. */
  readonly packagesDir: string;
  /** v3 `--bc-version` (four numbers). */
  readonly bcVersion: string;
  /**
   * R885: may v3 download the CRONUS demo data (about 0.5 GB, into `cacheDir`)? `false` passes
   * `--no-download`. Absent: `V3_DOWNLOAD_DEMO_DATA_DEFAULT`. Gates set `false`.
   */
  readonly downloadDemoData?: boolean;
  /**
   * R907: `--no-client` (serve: the `noClient` request field): tests run as a session without a
   * client. Absent: `V3_NO_CLIENT_DEFAULT`.
   */
  readonly noClient?: boolean;
  /**
   * R938: the environment choice (`chooseV3Environment`). A stated value is `--environment <value>`
   * on every al-runner call, one-shot and serve. REQUIRED: the constructor refuses a config without it.
   */
  readonly environmentChoice: V3EnvironmentChoice;
  /** R956: `alRunnerV3.license`: `--license <path>` on every al-runner call that runs tests, one-shot and serve. */
  readonly license?: { readonly path: string; readonly sha256: string };
  /**
   * R886: `--dotnet-sidecar <dll>` for every al-runner call, one-shot and serve. A path: that file
   * (refused by name when missing). Absent: the pinned build's own sidecar when its `.gated` names
   * one and the file still has that sha256 (else a warning and none). `false`: none; gates set this.
   */
  readonly dotnetSidecar?: string | false;
  readonly selectorObjectId: number;
  readonly alcPath: string;
  readonly coverage?: "al-runner" | "none";
  /** R907: see `BackendCapabilities.coverageOffFiles`. Only with `coverage: "none"`. */
  readonly coverageOffFiles?: readonly string[];
  readonly preprocessorSymbols?: readonly string[];
  /**
   * R900: alc's `/assemblyprobingpaths:` for both compiles (`ArtifactCompilerConfig`). R941/R943: also
   * al-runner's `--dotnet-assembly-dir`, one flag per folder (measured: a repeated flag searches
   * every folder, in either order; a comma-joined value is not split), on every one-shot call and
   * serve daemon that has a .NET helper, so a .NET type from a BC service folder loads at run time.
   */
  readonly assemblyProbingPaths?: readonly string[];
  /** `ALRUNNER_CACHE` for every v3 call. Absent: v3's own default. */
  readonly cacheDir?: string;
  /** Refused by name when `"resource"` (S3). */
  readonly selectorMode?: "static" | "resource";
  /** The target project, for coverage labels that name it (R219). */
  readonly sourceProjectDir?: string;
  /** R635: absent or `"one-shot"` is today's backend byte for byte. */
  readonly transport?: "one-shot" | "serve-entries";
  /** R635 §5 step 2: the echo before the coverage request. Absent: on. */
  readonly secondEcho?: boolean;
  /**
   * R786: set only on the NEW backend of a session re-run after `AlRunnerV3ServeFallbackWarmupError`:
   * the row and its reason. `decideTransport` then picks one-shot, says so in one warning, and
   * `status()` records it. Nothing else of the failed serve attempt is carried.
   */
  readonly serveFallbackWarmup?: string;
  /**
   * R761: `"default"` = the config named no transport, so `transport` is a starting value and
   * `decideTransport` picks it. Absent or `"explicit"`: `transport` is used as given, byte for byte as
   * before R761 (the itest's `backendCfg` sets none).
   */
  readonly transportSource?: "default" | "explicit";
  /** R762: run the contract probe fresh instead of replaying a cached pass (`--fresh-probe`). */
  readonly freshProbe?: boolean;
  /**
   * R857: `--isolate-tests`: every test runs alone, one entry per test with `runSelectedOnly`, and
   * the baseline one process per test. Off, every request is what it always was.
   */
  readonly isolateTests?: boolean;
  /**
   * R890: `"method"` = every test alone (as `isolateTests`) under `--isolation codeunit`: a fresh
   * codeunit per test, as BC's one-method runner. Absent or `"test"`: what it always was (the
   * config section's default is R896's `"auto"`; this internal default stays `"test"`).
   * R896 `"auto"`: `"test"` until the orchestrator moves a codeunit to `"method"` (`chooseIsolation`).
   */
  readonly isolation?: "auto" | "test" | "method";
  /**
   * R896: under `"auto"`, whether a codeunit may be moved to `"method"` on the one-shot transport.
   * Internal, not a config key. Absent: `V3_AUTO_METHOD_ONE_SHOT`.
   */
  readonly autoMethodOneShot?: "allow" | "refuse";
  /** R866: how many of those processes run at a time (`--workers`). Absent: `ISOLATED_BASELINE_PROCESSES`. */
  readonly isolatedBaselineProcesses?: number;
  /**
   * R790/R798: run the baseline's one-shot calls while alc proves the batch. Internal, not a config
   * key. Unset: read at construction from `LETHAL_V3_SPECULATE_BASELINE` ("1" = on; unset or empty = off).
   */
  readonly speculateBaseline?: boolean;
  /**
   * R948: under serve-entries, run the baseline through ONE serve daemon (a `plain()` request per
   * codeunit, with coverage) instead of one al-runner process per codeunit, cross-checked against
   * fresh processes (`baselineSampleIds`). Internal, not a config key; the CLI sets it. Absent: off.
   */
  readonly daemonBaseline?: boolean;
  /**
   * R948: the memory guard's headroom in GiB below the cgroup's `memory.max` (`alRunnerV3.memoryHeadroomGb`).
   * Absent: no guard, silently (unit tests). `0`: off by the config, said once. The CLI always sets it.
   */
  readonly memoryHeadroomGb?: number;
}

/** R866: how many one-test processes an `--isolate-tests` baseline runs at a time, unless `--workers` says. */
export const ISOLATED_BASELINE_PROCESSES = 4;

/** R948: the memory guard reads again every `MEMORY_POLL_MS` while over the bound, at most `MEMORY_WAIT_POLLS` times (5 minutes). */
export const MEMORY_POLL_MS = 2000;
export const MEMORY_WAIT_POLLS = 150;
/** R948: what the guard counts one started al-runner process or request at (measured 2-3.3 GB, R961). */
export const MEMORY_CALL_ESTIMATE_BYTES = 3 * 2 ** 30;

/**
 * R948: the container stayed over the memory bound and nothing could stop the session through the
 * budget (no stop handle: a backend used outside `runSession`). Inside a session the report says it.
 */
export class AlRunnerV3MemoryBoundError extends Error {
  constructor(
    readonly usedBytes: number,
    readonly boundBytes: number,
    readonly source: string,
  ) {
    super(
      `al-runner-v3-memory-bound: the container uses ${(usedBytes / 2 ** 30).toFixed(1)} GiB, over the ${(boundBytes / 2 ** 30).toFixed(1)} GiB bound (the limit in ${source} less "alRunnerV3.memoryHeadroomGb"), and stayed there; no new test call was started (R948).`,
    );
    this.name = "AlRunnerV3MemoryBoundError";
  }
}

/** R948: see `ExecutionBackend.useStopHandle`. */
type StopHandle = Parameters<NonNullable<ExecutionBackend["useStopHandle"]>>[0];

/** R948: one codeunit's (or one test's) baseline answer, as `callCodeunit` reads it. */
interface BaselineAnswer {
  readonly rows: readonly V3Row[];
  readonly coverage: V3CoverageRead;
  readonly wallMs: number;
  readonly stopSeconds: number;
  /** Whether it was asked for coverage. */
  readonly withCoverage: boolean;
  /** Set on an answer a serve daemon gave (not one a fresh process gave in its place). */
  readonly fromDaemon?: true;
}

/** R798: the env var that turns R790's speculative baseline on (it is off by default). */
export const SPECULATE_BASELINE_ENV = "LETHAL_V3_SPECULATE_BASELINE";

export class AlRunnerV3SpeculateBaselineRefusedError extends Error {
  constructor(value: string) {
    super(
      `al-runner-v3-speculate-baseline-refused: ${SPECULATE_BASELINE_ENV} is "${value}"; use 1 to turn it on, or leave it unset`,
    );
    this.name = "AlRunnerV3SpeculateBaselineRefusedError";
  }
}

function readSpeculateBaseline(): boolean {
  const v = process.env[SPECULATE_BASELINE_ENV];
  if (v === undefined || v === "") return false;
  if (v === "1") return true;
  throw new AlRunnerV3SpeculateBaselineRefusedError(v);
}

/** One row of v3's `--output-json` `tests[]`, decoded. */
export interface V3Row {
  readonly codeunit: number;
  readonly method: string;
  readonly name: string;
  readonly status: "pass" | "fail" | "error";
  readonly durationMs?: number;
  readonly message?: string;
  /** R925: al-runner's AL call stack for a failure, when it gives one. Absent otherwise. */
  readonly stackTrace?: string;
  readonly notRun: boolean;
  /** R907: al-runner's `flagged: true` (a pass resting on an unprobed assumption). Absent otherwise. */
  readonly flagged?: true;
  /** R949: set on a row a serve daemon answered: serve rows never carry `flagged`, so it is unknown, not false. */
  readonly flaggedUnknown?: true;
}

/**
 * Strict decode of one call's document. Any row of the wrong shape, of another codeunit, or a name
 * that is not `Codeunit<codeunit>.<method>` makes the whole document invalid: a call's rows are
 * cached only after a FULL valid decode (F5).
 */
export function decodeV3Rows(
  stdout: string,
  codeunitId: number,
): { readonly rows: readonly V3Row[]; readonly seed?: number } | { readonly why: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return { why: "the --output-json document is not JSON" };
  }
  const tests = (raw as { tests?: unknown } | null)?.tests;
  if (!Array.isArray(tests)) return { why: "the --output-json document has no tests[]" };
  // R807: the read-back guard; throws AlRunnerV3SeedError on a seed other than the pinned one.
  const seed = checkRunSeed(raw as { seed?: unknown; seedSource?: unknown }, "one-shot envelope");
  const rows: V3Row[] = [];
  for (const [i, t] of tests.entries()) {
    const r = (t ?? {}) as Record<string, unknown>;
    const { codeunit, method, name, status, durationMs, message, stackTrace, notRun, flagged } = r;
    if (
      typeof codeunit !== "number" ||
      typeof method !== "string" ||
      typeof name !== "string" ||
      (status !== "pass" && status !== "fail" && status !== "error") ||
      (durationMs !== undefined && typeof durationMs !== "number") ||
      (message !== undefined && typeof message !== "string") ||
      (stackTrace !== undefined && typeof stackTrace !== "string") ||
      (notRun !== undefined && typeof notRun !== "boolean") ||
      (flagged !== undefined && typeof flagged !== "boolean")
    ) {
      return {
        why: `row ${i + 1} does not have v3's row shape: ${JSON.stringify(t).slice(0, 200)}`,
      };
    }
    if (codeunit !== codeunitId) {
      return {
        why: `row ${i + 1} (${name}) is codeunit ${codeunit}, not the ${codeunitId} asked for`,
      };
    }
    if (name.toLowerCase() !== `codeunit${codeunit}.${method}`.toLowerCase()) {
      return {
        why: `row ${i + 1}'s name "${name}" does not match codeunit ${codeunit} method "${method}"`,
      };
    }
    rows.push({
      codeunit,
      method,
      name,
      status,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(message !== undefined ? { message } : {}),
      ...(stackTrace !== undefined ? { stackTrace } : {}),
      notRun: notRun === true,
      ...(flagged === true ? { flagged: true as const } : {}),
    });
  }
  return { rows, ...(seed !== undefined ? { seed } : {}) };
}

/**
 * §5: one decoded row -> its verdict. `notRun: true` wins over the message prefix: a not-run row is
 * a timeout (its stop parsed, and it must be the stop the call was sent) or a refusal, never a
 * pass or a fail; `notRun` with `pass`/`fail` is a contract error.
 */
export function v3RowVerdict(
  ref: TestMethodRef,
  row: V3Row,
  callStopSeconds: number,
  wallMs: number,
  coverage: CoverageMap | undefined,
  callId?: string,
): TestVerdict {
  // R963: the row's own time, or nothing: `wallMs` is the call's and is never the test's. A row
  // with none carries its call's identity instead, so the call's wall is charged once (`callId`).
  const measured =
    typeof row.durationMs === "number" && Number.isFinite(row.durationMs) && row.durationMs >= 0
      ? { measuredDurationMs: row.durationMs }
      : callId !== undefined
        ? { callId }
        : {};
  if (row.notRun) {
    if (row.status !== "error") {
      return {
        ref,
        outcome: "error",
        durationMs: wallMs,
        ...measured,
        failureMessage: `al-runner-v3 contract: ${row.name} is notRun with status "${row.status}"; never scored (R586 §5)`,
        operation: "completed-accepted",
        runnerRow: "runner-test-error",
      };
    }
    const stop = row.message === undefined ? null : V3_TIMEOUT_MESSAGE.exec(row.message);
    if (stop !== null) {
      const n = Number(stop[1]);
      if (n !== callStopSeconds) {
        return {
          ref,
          outcome: "error",
          durationMs: wallMs,
          ...measured,
          failureMessage: `al-runner-v3 contract: ${row.name} reports a ${n}s stop, but the call was sent --test-timeout-secs ${callStopSeconds}; never scored (R586 §5)`,
          operation: "completed-accepted",
          runnerRow: "runner-test-error",
        };
      }
      return {
        ref,
        outcome: "timeout",
        durationMs: wallMs,
        ...measured,
        reportedStopMs: n * 1000,
        timeoutIn: "body",
        failureMessage: row.message ?? "",
      };
    }
    return {
      ref,
      outcome: "error",
      durationMs: wallMs,
      ...measured,
      failureMessage: `${row.message ?? "<no message>"} ${V3_NOT_RUN_SUFFIX}${licensePointer(row.message)}`,
      operation: "completed-accepted",
      runnerRow: "runner-refused",
      // R609: what the test reached before v3 refused it (a note only; see the orchestrator).
      ...(coverage !== undefined ? { coverage } : {}),
    };
  }
  // R639 K1(a), r9 §1: a refusal written WITHOUT notRun (a plain `fail` or `pass` whose message
  // holds v3's refusal marker) never scores: no refusal path becomes a kill, survive or pass.
  // R675: the marker ANYWHERE in the message (`isV3RefusalText`), so no prefix shape can hide it.
  // A user Assert that quotes the marker is not a refusal, so the text says "holds the marker".
  if (isV3RefusalText(row.message)) {
    return {
      ref,
      outcome: "error",
      durationMs: wallMs,
      ...measured,
      failureMessage: `${row.message ?? ""} [al-runner v3: a ${row.status} that holds v3's refusal marker; never scored (R639, R675)]${licensePointer(row.message)}`,
      operation: "completed-accepted",
      runnerRow: "runner-test-error",
    };
  }
  const classified = verdictFromRunnerTest(
    ref,
    row.name,
    {
      status: row.status,
      ...(row.message !== undefined ? { message: row.message } : {}),
      ...(row.durationMs !== undefined ? { durationMs: row.durationMs } : {}),
      ...(row.flagged === true ? { flagged: true } : {}),
      ...(row.flaggedUnknown === true ? { flaggedUnknown: true } : {}),
    },
    wallMs,
    coverage,
  );
  const verdict =
    classified.measuredDurationMs === undefined && callId !== undefined
      ? { ...classified, callId }
      : classified;
  // R925: a real failure (a kill) carries message + "\n" + stackTrace, as the BC path does
  // (`failureTextOf`). Added AFTER the verdict is classified, so every classifier above reads the
  // message alone; no refusal, timeout or error text gets a stack.
  if (verdict.outcome === "fail" && row.stackTrace !== undefined && row.stackTrace.length > 0) {
    const text = [verdict.failureMessage ?? "", row.stackTrace].filter((s) => s.length > 0);
    return { ...verdict, failureMessage: text.join("\n") };
  }
  return verdict;
}

/** R886: the file `alRunnerV3.dotnetSidecar` names, absolute and with its symlinks resolved (R950: once, as the
 *  binary is, so a move of `current` never swaps the sidecar under a running session); refused by name when missing. */
export function namedSidecar(configured: string): string {
  const path = resolve(configured);
  if (!existsSync(path))
    throw new Error(
      `al-runner-v3-dotnet-sidecar-missing: "alRunnerV3.dotnetSidecar" is ${path}, which does not exist (R886). Fix the path, or set it to false.`,
    );
  return realpathSync(path);
}

/**
 * R886: the sidecar for this session. `configured`: `alRunnerV3.dotnetSidecar`. A named file that
 * is missing throws (the caller named it). With none named, the pinned build's own sidecar is used
 * when the file exists with the sha256 `.gated` recorded; otherwise `warning` says why and none is
 * passed (a missing or changed file must not run silently).
 */
export async function resolveDotnetSidecar(
  configured: string | false | undefined,
  alRunnerPath: string,
  gated: GatedBuild,
): Promise<{ readonly path?: string; readonly warning?: string }> {
  if (configured === false) return {};
  if (configured !== undefined) return { path: namedSidecar(configured) };
  const pinned = pinnedSidecar(alRunnerPath, gated);
  if (pinned === undefined) return {};
  if (!existsSync(pinned.path))
    return { warning: `the pinned sidecar ${pinned.path} is missing; .NET types are refused` };
  const sha = await sha256OfFile(pinned.path);
  return sha === pinned.sha256
    ? { path: pinned.path }
    : {
        warning: `the pinned sidecar ${pinned.path} has sha256 ${sha}, not the ${pinned.sha256} .gated recorded; not used`,
      };
}

/** The argv of one call (T5): one `--codeunit`, `--coverage-json` unless `coverageJson` is absent
 *  (R762 A: an unmutated call that asked for no coverage), no name selection. */
export function v3CallArgv(a: {
  readonly alRunnerPath: string;
  readonly codeunitId: number;
  readonly stopSeconds: number;
  readonly packagesDir: string;
  readonly bcVersion: string;
  /** R907: pass `--no-client` (a session without a client). Absent: not passed. */
  readonly noClient?: boolean;
  /** R938: `--environment <value>`. Absent: not passed. */
  readonly environment?: "saas" | "onprem";
  /** R956: `--license <path>`. Absent: not passed. */
  readonly license?: string;
  /** R885: pass `--no-download`. Absent: v3 may download the demo data (its default). */
  readonly noDownload?: boolean;
  /** R886: `--dotnet-sidecar <dll>`. Absent: not passed. */
  readonly dotnetSidecar?: string;
  /** R941/R943: one `--dotnet-assembly-dir <dir>` each, after the sidecar; only with `dotnetSidecar`. */
  readonly dotnetAssemblyDirs?: readonly string[];
  readonly symbols: readonly string[];
  readonly coverageJson?: string;
  readonly activeDir: string;
  readonly testDir: string;
  /** R857: the one test to run alone (`Codeunit<ID>.<Method>`), in place of the whole codeunit. */
  readonly onlyTest?: string;
  /** R890: `--isolation` value. Absent: `"test"`. */
  readonly isolation?: "test" | "codeunit";
  /** R907: `--skip-after-timeout`, right after the stop pair. Absent: not passed. */
  readonly skipAfterTimeout?: boolean;
}): string[] {
  return [
    a.alRunnerPath,
    "test",
    "--output-json",
    "--isolation",
    a.isolation ?? "test",
    "--test-timeout-secs",
    String(a.stopSeconds),
    ...(a.skipAfterTimeout === true ? ["--skip-after-timeout"] : []),
    ...(a.onlyTest !== undefined
      ? ["--test-exact", a.onlyTest, "--run-selected-only"]
      : ["--codeunit", String(a.codeunitId)]),
    "--package-cache",
    a.packagesDir,
    "--bc-version",
    a.bcVersion,
    ...(a.noClient === true ? ["--no-client"] : []),
    ...(a.environment !== undefined ? ["--environment", a.environment] : []),
    ...(a.license !== undefined ? ["--license", a.license] : []),
    ...(a.noDownload === true ? ["--no-download"] : []),
    ...(a.dotnetSidecar !== undefined
      ? [
          "--dotnet-sidecar",
          a.dotnetSidecar,
          ...(a.dotnetAssemblyDirs ?? []).flatMap((d) => ["--dotnet-assembly-dir", d]),
        ]
      : []),
    ...a.symbols.flatMap((s) => ["--define", s]),
    ...(a.coverageJson !== undefined ? ["--coverage-json", a.coverageJson] : []),
    a.activeDir,
    a.testDir,
  ];
}

/** `max(1, ceil(ms / 1000))`: v3's stop is whole seconds. */
export function stopSecondsOf(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

/** §5: the outer wall bound of one call, `10 x N x tests + 90 s` (v3 stops a waiting test at 10 x N).
 *  R635: clamped to `MAX_TIMER_MS` (about 24.8 days); a timer above it overflows and fires at once. */
export function v3CallDeadlineMs(stopSeconds: number, testsInCodeunit: number): number {
  return Math.min(MAX_TIMER_MS, 10 * stopSeconds * 1000 * Math.max(1, testsInCodeunit) + 90_000);
}

/** A file of `<deps>`: what `run()` re-lists cheaply, and its sha256 from `deploy()`. */
interface DepsEntry {
  readonly name: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly sha256: string;
}

/** §3 (I7, F3, F4): what alc proved, bound to what v3 reads. */
interface BatchProof {
  readonly activeHashExceptSelector: string;
  readonly activeAppJsonSha256: string;
  readonly testDirHash: string;
  /** R608: the non-.al files of `active/` and of the test dir (`.alpackages` included). */
  readonly activeOther: ReadonlyMap<string, OtherFile>;
  readonly testOther: ReadonlyMap<string, OtherFile>;
  readonly testAppJsonSha256: string;
  readonly deps: readonly DepsEntry[];
  readonly artifactId: string;
  readonly manifestIds: ReadonlySet<string>;
  readonly targetAppSha256: string;
  /** INFORMATIONAL: nothing reads it. R780: `cached:<key>` when the test-app compile was skipped on a
   *  cache hit (no .app was built), else the built .app's sha256. */
  readonly testAppSha256: string;
}

/** One codeunit call's answer for the active mutant, cached until the next `activate()`/`deploy()`. */
interface CallRows {
  readonly rows: readonly V3Row[];
  readonly stopSeconds: number;
  readonly wallMs: number;
  /** R963: this call's identity (fresh per al-runner process or serve request): its rows with no own time share its wall. */
  readonly callId: string;
  readonly coverage: V3CoverageRead;
  /** R635: every row of this call is `error` (`entries-echo-mismatch`, `-coverage-disagreement`). */
  readonly refusal?: string;
  /** R635: a suite test of this codeunit had no row (or two) in its entry: `rowMissing`. */
  readonly missing?: string;
  /**
   * R895: this call's request was cut at the timeout row of `test` (the daemon was killed): its rows
   * are the tests up to and including that one, so a ref with no row here is run alone (`runOn`).
   */
  readonly cutAtTimeout?: { readonly test: string };
  /** R635 §5: the coverage window already ran for this (mutant, codeunit). */
  readonly windowed?: boolean;
  /** R762 A: sent without `--coverage-json`; a caller that wants coverage must not reuse it. */
  readonly noCoverage?: boolean;
  /**
   * R778 (A2): the backend-wide sequence number of the PREFETCH request these rows came from. Only
   * prefetched rows carry it; a stored kill pair is used only for a kill served from such rows.
   */
  readonly prefetchSeq?: number;
}

/**
 * R939: why a serve daemon was closed. Each cause is counted once by reason; every reason but the
 * routine ones (`V3_ROUTINE_CLOSES`) is also reported to the session's close sink, which emits a
 * `serve-daemon-closed` event (never a warning: gates pin their warning sets).
 * - `refusal`: a row v3 refused (`NotRun`) with a reason outside `V3_SERVE_SAFE_REFUSALS`; the
 *   event and the close line name its family. `timeout`: a timeout row. `unkept-row`: any other
 *   row the keep rule (`serveDaemonReusable`) does not keep (a pass or fail holding v3's refusal marker).
 *   A prefetch, a live request and a §6 coverage window name their unkept row the same way.
 * - `warmup-refused`, `batch-refused`: the warm-up's or a whole batch's refusal (the session stops,
 *   or the default transport falls back to one-shot).
 * - `request-failed`: the request threw (a crash, EOF, the deadline). `answer-unreadable`: an answer
 *   that does not decode, or rows for another codeunit. `dependency-skip`: v3 skipped a dependency.
 * - Routine: `probe` (the pre-baseline probe's own daemon), `deploy`, `session-end`.
 */
export type V3DaemonCloseReason =
  | "refusal"
  | "timeout"
  | "unkept-row"
  | "warmup-refused"
  | "batch-refused"
  | "request-failed"
  | "answer-unreadable"
  | "dependency-skip"
  | "probe"
  | "deploy"
  | "mutant-stop"
  | "session-end"
  | "baseline-end";

/** R939: closes that cost no extra warm-up: counted on the close line, never sent to the sink.
 *  R948: `baseline-end` is the baseline's own daemon, closed before the mutant phase starts its own. */
export const V3_ROUTINE_CLOSES: ReadonlySet<V3DaemonCloseReason> = new Set([
  "probe",
  "deploy",
  "mutant-stop",
  "session-end",
  "baseline-end",
]);

/**
 * R939: why `rows` stop a daemon being reused: the first row the keep rule refuses, as a reason and,
 * for a refusal, its family: the text after `out-of-scope: `, with quoted and backticked spans
 * (names, code) masked as `…` FIRST, then cut at the first `(`, `[`, `;` or `:`, standalone numbers
 * as N, at most 80 characters. Undefined when every row is kept.
 */
export function unkeptRowReason(
  rows: readonly ServerTestLine[],
): { readonly reason: "refusal" | "timeout" | "unkept-row"; readonly family?: string } | undefined {
  const bad = rows.find((r) => !serveDaemonReusable([r], "v3"));
  if (bad === undefined) return undefined;
  const m = bad.message ?? "";
  if (bad.status === "error" && V3_TIMEOUT_MESSAGE.test(m)) return { reason: "timeout" };
  if (bad.notRun === true) {
    // Mask before cutting: a backticked call (`X.Y(Z)`) holds the cut characters.
    const family = (m.split("out-of-scope: ")[1] ?? m)
      .replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "…")
      .split(/[([;:]/)[0]
      ?.replace(/\b\d+\b/g, "N")
      .trim()
      .slice(0, 80);
    return {
      reason: "refusal",
      family: family !== undefined && family !== "" ? family : "unnamed",
    };
  }
  return { reason: "unkept-row" };
}

/** R939: the close line's part: `daemons closed: refusal 11 (WithEvents 5, ...), timeout 2, ...`. */
export function v3DaemonClosesText(c: {
  readonly byReason: ReadonlyMap<V3DaemonCloseReason, number>;
  readonly refusalFamilies: ReadonlyMap<string, number>;
}): string {
  if (c.byReason.size === 0) return "daemons closed: none";
  const families = [...c.refusalFamilies].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const parts = [...c.byReason]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([r, n]) =>
      r === "refusal" && families.length > 0
        ? `${r} ${n} (${families.map(([f, k]) => `${f} ${k}`).join(", ")})`
        : `${r} ${n}`,
    );
  return `daemons closed: ${parts.join(", ")}`;
}

/** R635: what the serve-entries transport did, for `status()`, the close line and the gate. */
export interface V3EntriesStats {
  daemons: number;
  /** R895: requests stopped at a streamed timeout row (the daemon killed; the rest re-sent or run alone). */
  timeoutCuts: number;
  cachedFalse: number;
  warmups: number;
  prefetchRequests: number;
  liveRequests: number;
  coverageRequests: number;
  echoRequests: number;
  /** Prefetch requests dropped on a request error (each warned by name). */
  prefetchDropped: number;
  echoMismatches: number;
  /** §5 step 2 only (the echo BEFORE the coverage request); also counted in `echoMismatches`. */
  secondEchoMismatches: number;
  entriesSent: number;
  /**
   * R651: wall ms per phase, summed over the session. TIMING ONLY: no verdict reads them.
   * `warmupMs` is each daemon's start plus its NONE warm-up request; `prefetchMs` and `liveMs` are
   * those requests alone (a daemon start inside them is `warmupMs`); `windowMs` is the §5 windows
   * after their daemon is up, and holds `coverageMs` (the coverage requests) and `echoMs` (the
   * window echoes).
   */
  warmupMs: number;
  prefetchMs: number;
  liveMs: number;
  windowMs: number;
  coverageMs: number;
  echoMs: number;
  /** R651, R652: the bound checks outside the baseline bracket, one per send (a §5 window: one for
   *  its plain sends): count and ms. `boundChecks = warmups + prefetchRequests + liveRequests +
   *  coverageRequests` in serve-entries. */
  boundChecks: number;
  boundMs: number;
  /** R653: kill pairs whose confirm PASSED (counted when the reproduction consumes the pair):
   *  each saves one live request and one bound check. */
  pairRequests: number;
  /** R653: pairs whose NONE entry stood but whose M entry did not (R612 cut): +1 live request. */
  pairFallbacks1: number;
  /** R653: pairs whose NONE entry did not stand (R612 cut at or before it): +2 live requests. */
  pairFallbacks2: number;
  /** R653: the `pairFallbacks1` whose reproduction was asked for (their confirm passed). */
  pairFallbacks1Passed: number;
  /** R653: the `pairFallbacks2` whose reproduction was asked for (their confirm passed). Per fail
   *  kill, `liveRequests = old − pairRequests + pairFallbacks1Passed + pairFallbacks2 +
   *  pairFallbacks2Passed`, where old is 1 + (1 if the confirm passed). */
  pairFallbacks2Passed: number;
  /**
   * R778: kill-pair BATCHES, sent right after the prefetch (kind `live`, so each also counts in
   * `liveRequests` and `boundChecks`): requests sent (a chunk that threw counts, if its bound check
   * passed), pairs stored (both entries stood), pairs a `sendKillPair` used, and stored pairs it
   * found but refused (another codeunit, or a kill that did not come from the prefetch, or a pair that
   * did not run after it). `liveRequests = pairBatchRequests +` the old per-kill formula over the
   * kills that took today's path; a served pair adds no live request and no bound check of its own.
   * That old formula (and `pairRequests` above) holds only over kills that took today's path:
   * `pairRequests` also counts reproductions served from the batch.
   */
  pairBatchRequests: number;
  pairBatchStored: number;
  pairBatchServed: number;
  pairBatchRefused: number;
}

/** R651: the phase timers of `V3EntriesStats`. */
type V3PhaseTimer =
  | "warmupMs"
  | "prefetchMs"
  | "liveMs"
  | "windowMs"
  | "coverageMs"
  | "echoMs"
  | "boundMs";

/** R766 (b): one lane's view of the backend; see `AlRunnerV3Backend.lanes`. */
export interface V3LaneView extends ExecutionBackend {
  readonly laneIndex: number;
  /** The first latch of the batch (shared by all lanes) and the mutant behind it. */
  latched(): { readonly mutantId: string; readonly why: string } | undefined;
  useBuildSymbols(symbols: readonly string[]): void;
  close(): Promise<void>;
  /** The per-mutant calls a lane view always has (optional on `ExecutionBackend`). */
  sendKillPair(mutantId: string, ref: TestMethodRef): Promise<void>;
  useCoveringBudgets(
    mutantId: string,
    budgets: readonly { readonly ref: TestMethodRef; readonly budgetMs: number }[],
  ): void;
  survivorNote(covering: readonly TestMethodRef[]): string | undefined;
}

/** R766 (b): a lane beyond lane 0 starts only while this much memory is available (10 GB). */
export const LANE_MIN_AVAILABLE_BYTES = 10 * 2 ** 30;
/** R766 (b): one serve daemon peaks about 2.2 GB RSS on D1 (measured); 2.3 GB is budgeted per lane. */
export const LANE_RSS_BYTES = 2.3 * 2 ** 30;

/** A started serve daemon; `dirty` closes it after the §5 window in flight (R612 on a plain request). */
interface Daemon {
  readonly server: AlRunnerServer;
  /** R954: the `--test-timeout` seconds it started with; `ensureDaemon` restarts one that differs. */
  readonly stopSeconds: number;
  dirty: boolean;
  /** R939: why `dirty` was set (the first unkept row's reason), for the close count. */
  dirtyWhy?: ReturnType<typeof unkeptRowReason>;
  /** R948: set on the baseline's own daemon: the stop (seconds) it was started with. Absent: a mutant-phase daemon. */
  baselineStop?: number;
}

/** R857, R890, R896: what one serve request (and its daemon) is sent under. */
interface RequestMode {
  readonly testIsolation: "test" | "codeunit";
  readonly runSelectedOnly: boolean;
}

/** R635 §3, §7: what `request()` returns. */
interface RequestOut {
  /** Per GROUP KEY (the mutant id unless the group set a key, R778 A1). */
  readonly results: ReadonlyMap<string, Map<number, CallRows>>;
  readonly resend: readonly EntryGroup[];
  /** The first row R612 did not keep, at the cut. */
  readonly cutWhy?: string;
  /** R778 (A2): this request's number in the backend-wide count. */
  readonly seq: number;
  /** R778: the keys with at least one standing entry, an echo too (the others lie after a cut). */
  readonly reached: ReadonlySet<string>;
}

function modeKey(m: RequestMode): string {
  return `${m.testIsolation}${m.runSelectedOnly ? "+selected" : ""}`;
}

/** v3 serve's readiness wait: a cold start may load dependencies (measure.md §8). */
const SERVE_READY_MS = 300_000;

const sha256Of = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

async function fileSha256(path: string): Promise<string> {
  return sha256Of(new Uint8Array(await readFile(path)));
}

/**
 * R790: one one-shot v3 process's answer, before any decode. A speculative baseline call (A1) is
 * stored in this form and later handed to `callCodeunit`'s own decode, so a served row is read
 * exactly as a live one.
 */
interface SpawnedCall {
  readonly res: { readonly exitCode: number; readonly stdout: string; readonly stderr: string };
  readonly wallMs: number;
  readonly timedOut: boolean;
  readonly deadlineMs: number;
  /** The `--coverage-json` text, read when a speculative call ended. */
  readonly covText?: string;
}

/** R790: a speculative baseline call, with the two inputs that must match the call it stands in for. */
interface SpeculativeCall extends SpawnedCall {
  readonly stopSeconds: number;
  readonly coverage: boolean;
}

/**
 * R790 (c): alc compiled a COPY of the staged batch; its error names the copy's path. Mapped back to
 * the batch's own path, keeping the class, so the session's error and report read as before.
 */
function errorAsIfIn(err: unknown, copy: string, active: string): unknown {
  if (!(err instanceof AlcCompileError || err instanceof ArtifactPrepareError)) return err;
  // Both separator forms: alc (and Windows) may print the path with either.
  const fwd = (p: string) => p.replaceAll("\\", "/");
  const mapped = err.message.split(copy).join(active).split(fwd(copy)).join(fwd(active));
  if (mapped === err.message) return err;
  return err instanceof AlcCompileError
    ? new AlcCompileError(mapped)
    : new ArtifactPrepareError(mapped);
}

/** R790 (review 1): a `listOtherFiles` map as a key. `JSON.stringify` of a Map is always "{}". */
function otherFilesKey(
  m: ReadonlyMap<
    string,
    { readonly size: number; readonly mtimeMs: number; readonly sha256: string }
  >,
): unknown {
  return [...m]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([p, f]) => [p, f.size, f.mtimeMs, f.sha256]);
}

/**
 * R790 (review 4): every file under LethAL's copy `dir` (relative path) with its size and mtime.
 * The copy is made from active/, which holds no link (R655); one refuses, by the walk's rule.
 */
async function fileStates(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = walkFilesSync(dir, { links: "refuse" });
  if (walk.skippedLinks.length > 0) {
    throw new AlRunnerV3UnprovenBatchError(`a link in alc's copy ${dir}: ${walk.skippedLinks[0]}`);
  }
  for (const rel of walk.files) {
    const s = await stat(join(dir, rel));
    out.set(rel, `${s.size}:${s.mtimeMs}`);
  }
  return out;
}

/** R790 (option 4): how many batches' alc writes the cache keeps (oldest evicted). */
const ALC_WRITES_MAX = 16;
const ALC_WRITES_KEY = /^[0-9a-f]{64}$/;

/**
 * R790 (option 4): the files alc wrote into a batch it compiled (Translations/*.g.xlf), cached by
 * the batch's `.al` hash and app.json. A HINT only: placed into the next identical batch before the
 * speculative calls, then checked against what alc really writes. A missing or unreadable entry is
 * a miss; a write failure is swallowed.
 */
async function readAlcWrites(dir: string, key: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  if (!ALC_WRITES_KEY.test(key)) return out;
  try {
    const j = JSON.parse(await readFile(join(dir, `${key}.json`), "utf8")) as {
      v?: unknown;
      files?: { rel?: unknown; b64?: unknown }[];
    };
    if (j.v !== 1 || !Array.isArray(j.files)) return out;
    for (const f of j.files) {
      if (typeof f.rel !== "string" || typeof f.b64 !== "string") return new Map();
      // Only a plain relative path inside the batch, never source (review r2 #3): no root, drive,
      // stream (":") or "..", and no .al file.
      if (
        /^[\\/]/.test(f.rel) ||
        f.rel.includes(":") ||
        f.rel.split(/[\\/]/).includes("..") ||
        f.rel.toLowerCase().endsWith(".al")
      )
        return new Map();
      out.set(f.rel, Buffer.from(f.b64, "base64"));
    }
  } catch {
    return new Map();
  }
  return out;
}

async function writeAlcWrites(
  dir: string,
  key: string,
  files: ReadonlyMap<string, Buffer>,
): Promise<void> {
  if (!ALC_WRITES_KEY.test(key)) return;
  const tmp = join(dir, `${key}.${randomUUID()}.tmp`);
  try {
    await mkdir(dir, { recursive: true });
    const body = {
      v: 1,
      files: [...files].map(([rel, b]) => ({ rel, b64: b.toString("base64") })),
    };
    await writeFile(tmp, JSON.stringify(body), "utf8");
    await rename(tmp, join(dir, `${key}.json`));
    const entries = (await readdir(dir)).filter((n) => n.endsWith(".json"));
    if (entries.length > ALC_WRITES_MAX) {
      const aged = await Promise.all(
        entries.map(async (n) => ({ n, t: (await stat(join(dir, n))).mtimeMs })),
      );
      aged.sort((a, b) => a.t - b.t);
      for (const { n } of aged.slice(0, entries.length - ALC_WRITES_MAX))
        await rm(join(dir, n), { force: true });
    }
  } catch {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

/** R780: one read of the test dir: the .al hash, the non-.al files, and the app.json (bytes + text). */
interface TestDirRead {
  readonly testScan: { readonly hash: string; readonly hasExtensionObject: boolean };
  readonly testOther: ReadonlyMap<string, OtherFile>;
  /** sha256 of the app.json BYTES (what `assertBound` checks per run), not of decoded text. */
  readonly testAppJsonSha256: string;
  readonly testAppJsonText: string;
}

/** R780: the two reads agree on the .al hash, every non-.al file's sha256 (not mtime) and app.json. */
function sameTestDirRead(a: TestDirRead, b: TestDirRead): boolean {
  if (a.testScan.hash !== b.testScan.hash || a.testAppJsonSha256 !== b.testAppJsonSha256) {
    return false;
  }
  if (a.testOther.size !== b.testOther.size) return false;
  for (const [rel, f] of a.testOther) {
    if (b.testOther.get(rel)?.sha256 !== f.sha256) return false;
  }
  return true;
}

/**
 * R608: the non-.al files the "other files" proof does NOT bind, because LethAL writes or checks
 * them itself during a session: both `app.json` files (checked by sha), the resource selector
 * (checked by its own rule, and rewritten inside a coverage window), and the editor folders v3
 * never reads. Nothing else of LethAL's lands under `active/` or the test dir: v3's coverage goes
 * to `<instrumentedDir>/cov`, outside both.
 */
const OTHER_FILES_UNBOUND = (rel: string): boolean => {
  const lower = rel.toLowerCase();
  return (
    lower === "app.json" ||
    lower === `${SELECTOR_RESOURCE_FOLDER}/${SELECTOR_RESOURCE_NAME}`.toLowerCase() ||
    rel.split("/").some((p) => LINK_EXCUSED_DIRS.includes(p.toLowerCase()))
  );
};

async function listDeps(dir: string, withSha: boolean): Promise<DepsEntry[]> {
  const out: DepsEntry[] = [];
  for (const name of (await readdir(dir)).sort()) {
    const p = join(dir, name);
    const s = await stat(p);
    // R608: a folder (or anything else that is not a plain file) is not bound by the proof.
    if (!s.isFile()) {
      throw new AlRunnerV3UnprovenBatchError(
        `${p} is not a plain file (a folder?); v3 may read it, and the alc proof does not bind it. Move its packages up into ${dir} or remove it`,
      );
    }
    out.push({
      name,
      size: s.size,
      mtimeMs: s.mtimeMs,
      sha256: withSha ? await fileSha256(p) : "",
    });
  }
  return out;
}

/** R635 §2: the echo's object id, the manifest's `selectorIds.controlId`. Missing = loud. */
async function readEchoId(dir: string): Promise<number> {
  const m = JSON.parse(await readFile(join(dir, "mutant-manifest.json"), "utf8")) as {
    selectorIds?: { controlId?: unknown };
  };
  const id = m.selectorIds?.controlId;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
    throw new Error(
      `al-runner-v3: ${join(dir, "mutant-manifest.json")} has no selectorIds.controlId, the echo codeunit's id (R635 §2)`,
    );
  }
  return id;
}

/** The batch's artifact id and every mutant id, from `mutant-manifest.json`. Missing = loud. */
async function readManifestIds(
  dir: string,
): Promise<{ readonly artifactId: string; readonly ids: ReadonlySet<string> }> {
  const path = join(dir, "mutant-manifest.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    throw new Error(
      `al-runner-v3: ${path} is missing or not JSON (${err instanceof Error ? err.message : String(err)}); a batch without its manifest cannot be bound`,
    );
  }
  const m = parsed as { artifactId?: unknown; mutants?: unknown };
  if (typeof m.artifactId !== "string" || !Array.isArray(m.mutants)) {
    throw new Error(`al-runner-v3: ${path} has no string artifactId and mutants[]`);
  }
  const ids = new Set<string>();
  for (const e of m.mutants) {
    const id = (e as { mutantId?: unknown } | null)?.mutantId;
    if (typeof id !== "string")
      throw new Error(`al-runner-v3: ${path} has a mutant with no mutantId`);
    ids.add(id);
  }
  return { artifactId: m.artifactId, ids };
}

/** R653: a fail kill's answers from `sendKillPair`; see `AlRunnerV3Backend.sendKillPair`. */
interface KillPair {
  readonly mutantId: string;
  readonly ref: TestMethodRef;
  readonly none?: CallRows;
  readonly noneVerdict?: TestVerdict;
  readonly m?: CallRows;
  /** Which R612 fallback this pair was: 1 (M cut), 2 (NONE cut). */
  readonly fallback?: 1 | 2;
  readonly next: "null" | "mutant";
}

/**
 * R766 step (a): the state that belongs to ONE serve daemon and the tree it reads. The backend holds
 * exactly one Lane today; a later step holds N, each with its own daemon and its own `active` dir.
 * What is session-wide (the proof, the latches, the prefetch map, the baseline rows, ...) stays on the
 * backend. The coverage window flag and the second-echo state stay there too, for now.
 */
class Lane {
  /** R896: by `modeKey`; one daemon per request mode (only one mode exists unless `"auto"` switched). */
  private readonly daemons = new Map<string, Daemon>();
  /** F3: the id the last `activate()` wrote; `null` is the baseline selector. */
  lastActivated: string | null = null;
  rowsByCodeunit = new Map<number, CallRows>();
  /** R907: by `refKey`; a ref run alone after a stop cut its codeunit's call. Per mutant. */
  aloneAfterStop = new Map<string, CallRows>();
  /**
   * R653: a fail kill's answers from `sendKillPair`, for the next `activate(null)` (the confirm:
   * its rows `none`, or the verdict a server error maps to) and then `activate(mutantId)` (the
   * reproduction's rows `m`). No rows at all when the NONE entry did not stand. Every public method
   * that works drops it, except the consuming `activate` and the confirm's own `run`.
   */
  pair: KillPair | undefined;
  /** R653: the confirm's verdict from the pair, for ONE `run`. */
  pairVerdict: TestVerdict | undefined;
  /** F5: per mutant, the budgets the covering loop will send each ref (`useCoveringBudgets`). */
  plan: { readonly mutantId: string; readonly budgets: ReadonlyMap<string, number> } | undefined;
  /** The `active/` dir this lane's daemon reads, once deployed and proved. */
  deployedDir: string | undefined;
  /** I-1: `deployedDir` under `realpath`, the form the Sleep index and the argv both use. */
  realActive: string | undefined;
  /** R785: the LATEST single daemon start plus warm-up of this lane, in ms; 0 before the first. */
  lastWarmupMs = 0;
  /** R785: how many daemons this lane has started (a restart changes it). */
  daemonStarts = 0;
  /** R651: wall ms per phase of this lane. TIMING ONLY: no verdict reads them. */
  readonly timers: Record<V3PhaseTimer, number> = {
    warmupMs: 0,
    prefetchMs: 0,
    liveMs: 0,
    windowMs: 0,
    coverageMs: 0,
    echoMs: 0,
    boundMs: 0,
  };

  /** R766 (b): the last mutant (not NONE) this lane activated; names the mutant behind a latch. */
  lastMutant: string | undefined;
  private cwd: string;

  constructor(
    private readonly where: {
      /** 0 for the backend's own lane (`active/`), k for the copy `active.<k>/`. */
      readonly index: number;
      readonly activeDir: string;
      readonly scratchCwd: string;
      /** The test dir as v3 reads it (`realpath`, else absolute). */
      readonly testSource: () => string;
      /** R907: the backend's `noClient`, sent as the request field when on. */
      readonly noClient: () => boolean;
      readonly now: () => number;
    },
  ) {
    this.cwd = where.scratchCwd;
  }

  get index(): number {
    return this.where.index;
  }

  activeDir(): string {
    return this.where.activeDir;
  }

  /** R645: the working directory of every v3 process of the session (absolute, never the caller's). */
  scratchCwd(): string {
    return this.cwd;
  }

  /** R766 (b): once lanes exist, each lane has its own cwd (`daemon-<k>/`). */
  setScratchCwd(dir: string): void {
    this.cwd = dir;
  }

  resourcePath(): string {
    return join(this.activeDir(), SELECTOR_RESOURCE_FOLDER, SELECTOR_RESOURCE_NAME);
  }

  /**
   * R635 §3: `{ command, sourcePaths, testIsolation }`, the same two roots one-shot passes. R857,
   * R890, R896: `mode` is the request's (`modeOfCall`); a request holds the entries of one mode.
   */
  requestBase(mode: RequestMode): Record<string, unknown> {
    return {
      command: "runTests",
      sourcePaths: [this.realActive ?? resolve(this.activeDir()), this.where.testSource()],
      testIsolation: mode.testIsolation,
      ...(mode.runSelectedOnly ? { runSelectedOnly: true } : {}),
      ...(this.where.noClient() ? { noClient: true } : {}),
    };
  }

  /** R896 (review 6a): this lane's daemon for `mode`, one per mode, each with its own warm-up. */
  daemonFor(mode: RequestMode): Daemon | undefined {
    return this.daemons.get(modeKey(mode));
  }

  setDaemon(mode: RequestMode, d: Daemon): void {
    this.daemons.set(modeKey(mode), d);
  }

  /** R948: true while this lane holds a daemon the baseline started (it carries its own stop). */
  hasBaselineDaemon(): boolean {
    return [...this.daemons.values()].some((d) => d.baselineStop !== undefined);
  }

  dropPair(): void {
    this.pair = undefined;
    this.pairVerdict = undefined;
  }

  /** Every daemon of the lane (each mode's): a failure on one costs the other its warm daemon only.
   *  R939: returns how many it closed (0 when the lane had none), so a close is counted per daemon. */
  async closeDaemon(): Promise<number> {
    // R653 C5: at most a lost saving; a pair is stored only after its request() returned.
    this.dropPair();
    const ds = [...this.daemons.values()];
    this.daemons.clear();
    for (const d of ds) await d.server.close();
    return ds.length;
  }

  /** C2 and R349: every field derived from the deployed layout or the active mutant. */
  resetLayout(): void {
    this.rowsByCodeunit = new Map();
    this.deployedDir = undefined;
    this.lastActivated = null;
    this.lastMutant = undefined;
  }

  /** R651: `f`'s wall time into `timers[k]`, thrown or not. TIMING ONLY: no verdict reads it. */
  async timed<T>(k: V3PhaseTimer, f: () => Promise<T>): Promise<T> {
    const t0 = this.where.now();
    const bound0 = this.timers.boundMs;
    try {
      return await f();
    } finally {
      // R652: a bound check nested inside this phase (the warm-up's, a request's) is `boundMs`.
      const nested = k === "boundMs" ? 0 : this.timers.boundMs - bound0;
      this.timers[k] += this.where.now() - t0 - nested;
    }
  }
}

export class AlRunnerV3Backend implements ExecutionBackend {
  /** R577 with C2: every activate/deploy clears the rows, so a reproduction really re-runs. */
  readonly killsMustReproduce = true;
  /** R857: `--isolate-tests`; see `ExecutionBackend.isolatesTests`. */
  get isolatesTests(): boolean {
    return this.cfg.isolateTests === true || this.methodIsolation;
  }
  /** R907: see `ExecutionBackend.noClient`. */
  get noClient(): boolean {
    return this.cfg.noClient ?? V3_NO_CLIENT_DEFAULT;
  }
  /** R938: see `ExecutionBackend.environmentChoice`. */
  get environmentChoice(): V3EnvironmentChoice {
    return this.cfg.environmentChoice;
  }
  /** R956: see `ExecutionBackend.license`. */
  get license(): { readonly path: string; readonly sha256: string } | undefined {
    return this.cfg.license;
  }
  /** R907: see `ExecutionBackend.skipAfterTimeout`. Serve (entries) never passes it. */
  get skipAfterTimeout(): boolean {
    return this.skipAfterTimeoutLearned && !this.entries;
  }
  /** R919: see `ExecutionBackend.skipAfterTimeoutSupported`. */
  get skipAfterTimeoutSupported(): boolean {
    return this.skipAfterTimeoutLearned;
  }
  /** R890: see `ExecutionBackend.methodIsolation`. */
  get methodIsolation(): boolean {
    return this.cfg.isolation === "method";
  }
  /** R896: see `ExecutionBackend.isolationAuto`. */
  get isolationAuto(): boolean {
    return this.cfg.isolation === "auto";
  }
  /** R896: the codeunits `chooseIsolation` fixed; every other codeunit is on `"test"` under auto. */
  private readonly chosen = new Map<number, "test" | "method">();

  /** R896: codeunit `cu`'s mode: forced (`"method"`, else `"test"`), or under auto as chosen. */
  isolationOf(cu: number): "test" | "method" {
    if (this.methodIsolation) return "method";
    return this.chosen.get(cu) ?? "test";
  }

  /** R912: see `ExecutionBackend.wholeCodeunit`: entries are used and `cu` is not per-test. */
  wholeCodeunit(cu: number): boolean {
    return this.entries && !this.perTest(cu);
  }

  /** R912: the batch a windowed prefetch belongs to: its group count, and the chunk its requests fill. */
  private prefetchBatch: { groups: number; size: number; ran: boolean } | undefined;

  /** R912: the time left of `--time-budget`, set only while `prefetchMutants` runs. */
  private prefetchRemainingMs: (() => number) | undefined;

  /** R857, R890, R896: whether `cu`'s tests each run alone (own call id, `onlyTest`). */
  private perTest(cu: number): boolean {
    return this.cfg.isolateTests === true || this.isolationOf(cu) === "method";
  }

  /** R896: the request mode of a call id (one test's id, or a codeunit's). */
  private modeOfCall(id: number): RequestMode {
    const one = this.isolatedRefs.get(id);
    const cu = one?.codeunitId ?? id;
    return {
      testIsolation: this.isolationOf(cu) === "method" ? "codeunit" : SERVE_TEST_ISOLATION,
      runSelectedOnly: one !== undefined,
    };
  }

  /** R896: see `ExecutionBackend.chooseIsolation`. */
  chooseIsolation(cu: number, mode: "test" | "method"): void {
    if (!this.isolationAuto) {
      throw new Error(
        `al-runner-v3: chooseIsolation(${cu}, ${mode}) on a backend whose isolation is not "auto" (R896)`,
      );
    }
    if (
      mode === "method" &&
      !this.entries &&
      (this.cfg.autoMethodOneShot ?? V3_AUTO_METHOD_ONE_SHOT) === "refuse"
    ) {
      throw new AlRunnerV3AutoMethodOneShotRefusedError(cu);
    }
    this.dropPair();
    const was = this.isolationOf(cu);
    this.chosen.set(cu, mode);
    // Review 4: the refusals are noted again from the chosen rows (`noteReusedBaseline`). Build
    // review 1: a whole-codeunit `test` call noted refusals from EVERY row it returned (tests
    // outside the session's suite, TestPage-skipped ones too), which no verdict row can re-note.
    // So the move to `method` keeps that set aside, and the move back to `test` restores it.
    if (mode === "method") {
      const held = this.baselineRefused.get(cu);
      if (was === "test" && held !== undefined) this.refusedUnderTest.set(cu, held);
      this.baselineRefused.delete(cu);
      return;
    }
    const kept = this.refusedUnderTest.get(cu);
    this.refusedUnderTest.delete(cu);
    if (kept !== undefined) this.baselineRefused.set(cu, kept);
    else this.baselineRefused.delete(cu);
  }
  /** R896: a codeunit's `test` refusal set while it is tried on `method` (`chooseIsolation`). */
  private readonly refusedUnderTest = new Map<number, Set<string>>();
  /** R857: `callId`'s table, both ways. Never reset: an id means one test for the whole session. */
  private readonly isolatedIds = new Map<string, number>();
  private readonly isolatedRefs = new Map<number, TestMethodRef>();
  /** R866: `fillIsolatedBaseline`'s answers by call id, each served once; reset by a deploy. */
  private isolatedBaseline = new Map<number, SpeculativeCall>();
  private isolatedFilled = false;
  /** R948: the daemon baseline's answers by call id (a codeunit's, or one test's), each served once; reset by a deploy. */
  private daemonBaseline = new Map<number, BaselineAnswer>();
  private daemonBaselineFilled = false;
  /** R949: the once-per-session notice that daemon answers carry no `flagged`. */
  private flaggedUnknownNoted = false;
  /** R948: why the daemon baseline was dropped. Session-wide (a deploy keeps it): the baseline is then one-shot for every batch. */
  private daemonBaselineOff: string | undefined;
  /** R948: per differing test, which field differs (`compareBaselineAnswers`' lines); names, fields and `file:line` keys only. */
  private daemonBaselineDetail: string[] = [];
  /** R948: the session's stop state (`useStopHandle`). */
  private stopHandle: StopHandle | undefined;
  /** R948: the memory guard: decided once, on the first need. `"off"`: said why, or silent when no headroom was given. */
  private memoryGuard:
    | {
        readonly read: () => MemorySample | undefined;
        readonly boundBytes: number;
        readonly source: string;
      }
    | "off"
    | undefined;
  /** R948: set when the guard stopped the session; every later gate answers no. */
  private memoryStopped = false;
  /** R948: gate callers take turns; each pass that holds counts `memoryEstimate()` until released. */
  private memoryChain: Promise<void> = Promise.resolve();
  private memoryHeld = 0;
  /** R948: what the daemon baseline did (`daemonBaselineReport`). */
  private readonly baselineStats = {
    codeunits: 0,
    requests: 0,
    sampled: [] as number[],
    perTestRequests: 0,
    perTestSampled: [] as number[],
    compared: 0,
    served: 0,
    skippedTooSlow: [] as string[],
    skippedError: [] as string[],
    skippedOther: [] as string[],
    sampledSkipped: [] as string[],
  };

  /**
   * R948: a daemon answer the fill did not keep, named. A sampled one is counted apart (the sample's
   * own `compared` shows it); the others are the three reasons a gate may accept as "reported, not a
   * regression": too slow for a warm duration to be trusted, a request error, or a refused/odd row.
   */
  private noteSkip(kind: "tooSlow" | "error" | "other", name: string, sampled: boolean): void {
    const s = this.baselineStats;
    if (sampled) s.sampledSkipped.push(name);
    else if (kind === "tooSlow") s.skippedTooSlow.push(name);
    else if (kind === "error") s.skippedError.push(name);
    else s.skippedOther.push(name);
  }
  /** One-shot: the stop a call is sent is the largest budget of its refs (F5). R635: the
   *  serve-entries daemon has ONE stop for its life, S (R517), never the budget. */
  get inRunStopIsBudget(): boolean {
    return !this.entries;
  }
  /** R635 §3: `S * 1000` in serve-entries once the floor is known; absent one-shot. */
  get inRunStopMs(): number | undefined {
    const s = this.serveStopSeconds();
    return this.entries && s !== undefined ? s * 1000 : undefined;
  }

  // R635: the serve-entries state. Unused (and untouched) one-shot.
  private entries: boolean;
  /** R761: true once `decideTransport` ran or a v3 process started; `entries` never changes after. */
  private transportFrozen = false;
  /** R857: why the default transport fell back, for `--isolate-tests`' refusal. */
  private fallbackReasons: readonly string[] = [];
  private discovered: readonly TestMethodRef[] = [];
  /** §4: set ONLY by the orchestrator's `baselinePhase` bracket. */
  private inBaseline = false;
  /** R780: the test-app compile cache's counters (this instance). */
  private readonly testAppCache = { hits: 0, misses: 0 };
  /** §3 (N1): the one-shot baseline's rows per codeunit, recorded inside the bracket. */
  private baselineRows = new Map<number, readonly V3Row[]>();
  /** §4: per mutant, the rows a fully valid prefetch answer gave; consumed by `activate`. */
  private prefetched = new Map<string, Map<number, CallRows>>();
  /**
   * R778: the kill pairs `batchKillPairs` sent after the prefetch, per `<artifactId>|<mutantId>`.
   * Single-use (deleted at the first lookup, match or not) and cleared by a deploy, a prefetch, the
   * baseline bracket and `status()`. `seq` is the pair request's backend-wide sequence number.
   */
  private pairStore = new Map<
    string,
    { readonly cu: number; readonly seq: number; readonly none: CallRows; readonly m: CallRows }
  >();
  /** R778: false only in tests that measure today's per-kill pair on its own. */
  private pairBatch = true;
  /** R778 (A2): the backend-wide count of `request()` calls (every lane); see `CallRows.prefetchSeq`. */
  private requestSeq = 0;
  /** §3: the covering codeunits of the batch: the warm-up's union. */
  private union = new Set<number>();
  /** R766: the per-daemon state. `lane` is lane 0 (`active/`); `lanes(N)` adds `active.<k>/` lanes. */
  private readonly lane: Lane;
  private readonly laneList: Lane[];
  /** R766 (b): true once `lanes(N)` ran; the root backend's per-mutant methods then throw by name. */
  private lanesBuilt = false;
  /**
   * R766 (b): the first latch of the batch (`batchBlind` or `entriesRefused`) and the mutant behind
   * it, first wins. The orchestrator's stop rule under `--workers > 1` reads it (`latched()`).
   */
  private latchBy: { readonly mutantId: string; readonly why: string } | undefined;
  /** R766 (b): test seams only; production leaves it empty. */
  readonly seams: {
    /** Forces `sleepRuleRetiredForParallel()`. */
    sleepRuleRetired?: boolean;
    /** Replaces `os.freemem()` for the lane memory hold. */
    availableBytes?: () => number;
    /** Runs on each lane copy right after it was made, before it is checked against the proof. */
    afterLaneCopy?: (dir: string) => Promise<void>;
    /** R790: turns the speculative baseline off, for a test that counts the first spawn. */
    noSpeculativeBaseline?: true;
    /** R790: runs once the speculative calls ended, before their second binding read. */
    afterSpeculation?: () => Promise<void>;
    /** R948: replaces the cgroup reader of the memory guard (tests never read `/sys`). */
    memoryReader?: () => MemorySample | undefined;
    /** R948: replaces the guard's wait between two reads; tests count calls, never wait. */
    memorySleep?: (ms: number) => Promise<void>;
    /** R948: how many reads the guard waits through before it stops the session. Absent: `MEMORY_WAIT_POLLS`. */
    memoryWaitPolls?: number;
    /** R948: bytes one started process or request is counted at by the guard. Absent: `MEMORY_CALL_ESTIMATE_BYTES`. */
    memoryEstimateBytes?: number;
    /** R948: runs the daemon baseline's codeunits last to first (the order proof's second order). */
    reverseBaselineOrder?: true;
  } = {};
  /** R798: R790's speculative baseline is opt-in (option or env, read at construction). */
  private readonly speculateOn: boolean;
  private memoryHoldNoticed = false;
  private fitNoticed = false;
  /** R766 (b): the `resume` fact `decideTransport` was given. */
  private resumeSession = false;
  /** §3 (N2): a live warm-up refusal; every later run is a transport failure. */
  private entriesRefused: string | undefined;
  /** §2: the echo codeunit, `selectorIds.controlId` of the deployed manifest. */
  private echoId: number | undefined;
  /** §5: true while `active-mutant.txt` legitimately holds a mutant id. */
  private inWindow = false;
  private budgetFloor: { readonly floorMs: number; readonly baselineTimeoutMs: number } | undefined;
  /** R939: daemons closed, by reason, and the refusal families among them (`closeLane`). */
  private readonly closes = new Map<V3DaemonCloseReason, number>();
  private readonly closeFamilies = new Map<string, number>();
  /** R939: the closes so far, by reason and refusal family (the close line; tests). */
  daemonCloses(): {
    readonly byReason: ReadonlyMap<V3DaemonCloseReason, number>;
    readonly refusalFamilies: ReadonlyMap<string, number>;
  } {
    return { byReason: new Map(this.closes), refusalFamilies: new Map(this.closeFamilies) };
  }
  /** R939: the session's close sink (`setDaemonCloseSink`); each call becomes a `serve-daemon-closed` event. */
  private closeSink:
    | ((c: { readonly reason: string; readonly family?: string }) => void)
    | undefined;
  /** R939: see `ExecutionBackend.setDaemonCloseSink`. */
  setDaemonCloseSink(
    sink?: (c: { readonly reason: string; readonly family?: string }) => void,
  ): void {
    this.closeSink = sink;
  }
  /**
   * R939: close every daemon of `lane` and count the CAUSE once by `reason` (a lane's other mode
   * daemons close as collateral, and counting them would inflate the refusal a probe should admit);
   * for an unexpected reason (every one but `deploy`, `session-end` and `probe`, which cost no extra
   * warm-up) report it to the session's sink, naming a refusal's family.
   */
  private async closeLane(lane: Lane, reason: V3DaemonCloseReason, family?: string): Promise<void> {
    if ((await lane.closeDaemon()) === 0) return;
    this.closes.set(reason, (this.closes.get(reason) ?? 0) + 1);
    if (family !== undefined)
      this.closeFamilies.set(family, (this.closeFamilies.get(family) ?? 0) + 1);
    if (V3_ROUTINE_CLOSES.has(reason)) return;
    this.closeSink?.({ reason, ...(family !== undefined ? { family } : {}) });
  }
  /** The counters; the phase timers are per lane and summed in `entriesStats()`. */
  private readonly stats: Omit<V3EntriesStats, V3PhaseTimer> = {
    daemons: 0,
    timeoutCuts: 0,
    cachedFalse: 0,
    warmups: 0,
    prefetchRequests: 0,
    liveRequests: 0,
    coverageRequests: 0,
    echoRequests: 0,
    echoMismatches: 0,
    secondEchoMismatches: 0,
    prefetchDropped: 0,
    entriesSent: 0,
    boundChecks: 0,
    pairRequests: 0,
    pairFallbacks1: 0,
    pairFallbacks2: 0,
    pairFallbacks1Passed: 0,
    pairFallbacks2Passed: 0,
    pairBatchRequests: 0,
    pairBatchStored: 0,
    pairBatchServed: 0,
    pairBatchRefused: 0,
  };

  private proof: BatchProof | undefined;
  /** R790 (A1): the baseline calls deploy() ran while alc proved the batch, bound to `dir`'s proof. */
  private speculative:
    | { readonly dir: string; readonly calls: Map<number, SpeculativeCall> }
    | undefined;
  private coverageIndex: AlRunnerCoverageIndex | undefined;
  private sleepIndex: SleepIndex | undefined;
  /** I-1: the test dir under `realpath`, the form the index and the argv both use (the lane holds `active`'s). */
  private realTestDir: string | undefined;
  /** §6 case 2: a mutant call showed v3 cannot see an indexed Sleep line: every later pass errors. */
  private batchBlind: string | undefined;
  private buildSymbols: readonly string[] | undefined;
  private callSeq = 0;
  /** Every discovered test, per codeunit (the outer bound counts a codeunit's tests). */
  private testsPerCodeunit = new Map<number, number>();
  /** The session suite, per codeunit: the tests a call must have exactly one row for. */
  private suitePerCodeunit = new Map<number, readonly TestMethodRef[]>();
  /**
   * I3: tests v3 refused at baseline (notRun `error`, not a timeout), per codeunit, from a
   * baseline call or (R678) a reused snapshot's verdicts (`noteReusedBaseline`). Session-scoped on
   * purpose, so `resetLayoutState` does not clear it (R677): a refusal depends on the test and the
   * v3 build, both fixed for the session, and every batch's baseline runs the whole suite. A
   * resumed batch that reuses its snapshot runs no baseline call, and a per-batch clear would
   * silently drop a true note there.
   */
  private baselineRefused = new Map<number, Set<string>>();
  private dotnetHelperWarned = false;
  private testPathsWarned = false; // R811
  /** R885: the build named by v3's "test data is off" note, once seen; `""` when it names none. */
  private testDataOffBuild: string | undefined;
  private testDataOffWarned = false;
  private demoDownloadWarned = false;
  private demoMayDownloadWarned = false;

  /**
   * R885: before the first al-runner call, one informational line when v3 may download the demo
   * data: download is on, `cacheDir` is named, and it holds no backup for `bcVersion`.
   */
  private preRunDemoLine(): void {
    if (this.demoMayDownloadWarned || this.noDownload() || this.cfg.cacheDir === undefined) return;
    this.demoMayDownloadWarned = true;
    if (demoBackupPath(this.cfg.cacheDir, this.cfg.bcVersion) !== undefined) return;
    this.notify(
      "al-runner-v3-demo-data-may-download",
      `[lethal] al-runner may download BC ${this.cfg.bcVersion} demo data (~549 MB, once) into ${this.cfg.cacheDir}; set alRunnerV3.downloadDemoData=false to stay offline`,
    );
  }

  /** R885: read v3's output (one-shot stdout and stderr, or the daemon's stderr) for the note. */
  private watchTestDataOff(...outputs: string[]): void {
    for (const text of outputs) {
      // v3 prints this line itself when it really starts the download (not when the cache holds the
      // data, not with --no-download), so the notice is never a guess. It reaches us when the call
      // ends: a one-shot call is read after it exits, serve after each request (ponytail: not live).
      if (!this.demoDownloadWarned && v3DemoDownloadStarts(text)) {
        this.demoDownloadWarned = true;
        const build = /\bbuild (\d+(?:\.\d+)+)/.exec(text)?.[1] ?? this.cfg.bcVersion;
        // The downloaded file's size and sha256, so a build the feed re-publishes shows as a changed
        // hash between runs. Read at the end of the call, when the file is complete.
        const bak =
          this.cfg.cacheDir === undefined ? undefined : demoBackupPath(this.cfg.cacheDir, build);
        const id =
          bak === undefined ? "backup file not found in cacheDir, so no hash" : describeBackup(bak);
        this.notify(
          "al-runner-v3-demo-data-download",
          `[lethal] downloading BC ${build} demo data (~549 MB, once) into ${this.cfg.cacheDir ?? "al-runner's default cache"}; set alRunnerV3.downloadDemoData=false to stay offline. Downloaded file: ${id}`,
        );
      }
      const found = v3TestDataOffNote(text);
      if (found === undefined) continue;
      this.testDataOffBuild = found.build;
      if (this.testDataOffWarned) return;
      this.testDataOffWarned = true;
      this.notify(
        "al-runner-v3-test-data-off",
        `[lethal] al-runner-v3-test-data-off: ${testDataOffLine(found.build, this.noDownload())}`,
      );
      return;
    }
  }

  /** R885: for the "no green baseline tests" note. `undefined` unless v3 said the data is off. */
  baselineNote(): string | undefined {
    return this.testDataOffBuild === undefined
      ? undefined
      : testDataOffLine(this.testDataOffBuild, this.noDownload());
  }

  /** R885: v3 gets `--no-download` unless the demo data may be downloaded (one default, one place). */
  private noDownload(): boolean {
    return !(this.cfg.downloadDemoData ?? V3_DOWNLOAD_DEMO_DATA_DEFAULT);
  }
  /** R739: where this backend's notices go. Default: the console, until a session installs one. */
  private notify: (code: string, message: string) => void = (_code, message) =>
    console.warn(message);

  /**
   * R739: a session installs its emitter here, with a fresh once-per-backend notice flag so each
   * session on a reused backend sees its own notice; `undefined` restores the console.
   */
  setNotify(notify?: (code: string, message: string) => void): void {
    this.notify = notify ?? ((_code, message) => console.warn(message));
    if (notify !== undefined) {
      this.dotnetHelperWarned = false;
      this.testPathsWarned = false;
      this.testDataOffWarned = false;
      // R904: and the note itself, so a session after the cache was filled is not stopped on the
      // last session's data-off line.
      this.testDataOffBuild = undefined;
      this.demoDownloadWarned = false;
      this.demoMayDownloadWarned = false;
    }
  }
  private readonly compiler: ArtifactCompiler;
  /** Test hook (legs X (e), (f)): rewrites a mutant call's coverage file before it is read. */
  coverageTamper?: (path: string) => Promise<void>;
  /** How many v3 processes this backend started (legs X (a), (c)). */
  spawnCount = 0;
  /** Owner methods drop every lane's pair; a lane's own methods drop only its own (`lane.dropPair()`). */
  private dropPair(): void {
    for (const l of this.laneList) l.dropPair();
  }

  private readonly cfg: AlRunnerV3Config;

  constructor(
    cfg: AlRunnerV3Config,
    private readonly spawn: SpawnFn = defaultSpawn,
    alcIo: ArtifactIo = defaultArtifactIo,
    /** R635: the serve daemon's spawn (serve-entries only). */
    private readonly serverSpawn: ServerSpawnFn = defaultServerSpawn,
    /** R651: the clock of the phase timers only (a test's fake clock). */
    private readonly now: () => number = Date.now,
  ) {
    // R938: a backend built directly cannot run with an unknown environment either.
    if ((cfg.environmentChoice as V3EnvironmentChoice | undefined)?.value === undefined) {
      throw new V3EnvironmentUnknownError();
    }
    if (cfg.selectorMode === "resource") throw new AlRunnerV3ResourceSelectorRefusedError();
    if (cfg.isolateTests === true && cfg.isolation === "auto") {
      throw new AlRunnerV3IsolateTestsWithAutoRefusedError();
    }
    this.cfg = { ...cfg, alRunnerPath: resolveV3Binary(cfg.alRunnerPath) };
    if (typeof cfg.dotnetSidecar === "string") this.sidecarPath = resolve(cfg.dotnetSidecar); // R886
    this.speculateOn = cfg.speculateBaseline ?? readSpeculateBaseline();
    // R761: a default transport starts one-shot-safe; `decideTransport` turns serve on, before the
    // first deploy (the staged batch differs by transport) and the first v3 process.
    this.entries = cfg.transport === "serve-entries" && cfg.transportSource !== "default";
    this.lane = this.makeLane(0);
    this.laneList = [this.lane];
    this.compiler = new ArtifactCompiler(
      {
        alcPath: cfg.alcPath,
        packageCachePath: cfg.packagesDir,
        outputDir: join(cfg.instrumentedDir, "alc-out"),
        ...(cfg.preprocessorSymbols !== undefined
          ? { preprocessorSymbols: cfg.preprocessorSymbols }
          : {}),
        ...(cfg.assemblyProbingPaths !== undefined
          ? { assemblyProbingPaths: cfg.assemblyProbingPaths }
          : {}),
      },
      alcIo,
    );
  }

  private makeLane(k: number): Lane {
    return new Lane({
      index: k,
      activeDir: join(this.cfg.instrumentedDir, k === 0 ? "active" : `active.${k}`),
      scratchCwd: resolve(this.cfg.instrumentedDir),
      testSource: () => this.realTestDir ?? resolve(this.cfg.testDir),
      noClient: () => this.noClient,
      now: this.now,
    });
  }

  /**
   * R857: the key a test's rows are kept under: its codeunit, or under `--isolate-tests` an id of
   * its own. Those ids are negative, so they never meet a codeunit id in `testsPerCodeunit` or
   * `suitePerCodeunit`, and every per-codeunit rule below (warm-up, R612's cut, re-sends, kill
   * pairs) then works per test.
   */
  private callId(ref: TestMethodRef): number {
    if (!this.perTest(ref.codeunitId)) return ref.codeunitId; // R896: per codeunit
    const k = refKey(ref);
    let id = this.isolatedIds.get(k);
    if (id === undefined) {
      id = -(this.isolatedIds.size + 1);
      this.isolatedIds.set(k, id);
      this.isolatedRefs.set(id, ref);
    }
    return id;
  }

  /** R857: what call id `id` runs, when it is one test; `undefined` for a codeunit. */
  private isolated(id: number): IsolatedSelection | undefined {
    const ref = this.isolatedRefs.get(id);
    if (ref === undefined) return undefined;
    const others = this.discovered
      .filter((t) => t.codeunitId === ref.codeunitId)
      .map((t) => t.method);
    return isolatedSelection(ref.codeunitId, ref.method, others);
  }

  capabilities(): BackendCapabilities {
    return {
      kind: "al-runner-v3",
      coverage: this.cfg.coverage ?? "none",
      ...(this.cfg.coverageOffFiles !== undefined
        ? { coverageOffFiles: this.cfg.coverageOffFiles }
        : {}),
      deploy: "none",
      // Read by nothing today; `--isolation test` rolls the database back per test, while the
      // codeunit's variables are kept (plan §2).
      isolation: "session",
      // Until the verdict-changing defects are measured gone (plan §7): #5611 is still present.
      authoritative: false,
    };
  }

  /** `--version` must be a v3 build and, when pinned, the binary must be the pinned bytes. */
  async status(): Promise<BackendStatus> {
    this.preRunDemoLine(); // R885
    if (typeof this.cfg.dotnetSidecar === "string") {
      try {
        namedSidecar(this.cfg.dotnetSidecar); // R886: the caller named it, so a missing file refuses
      } catch (e) {
        return { ok: false, details: (e as Error).message };
      }
    }
    this.dropPair();
    this.pairStore.clear();
    const res = await this.spawn([this.cfg.alRunnerPath, "--version"], this.cacheEnv()).catch(
      (e) => ({
        exitCode: -1,
        stdout: "",
        stderr: String(e),
      }),
    );
    const reported = (res.stdout || res.stderr).trim();
    if (res.exitCode !== 0) {
      return {
        ok: false,
        details: `al-runner v3 not runnable: ${reported.slice(0, 300)}. ${v3InstallHint()}`,
      };
    }
    if (!AL_RUNNER_V3_VERSION.test(reported)) {
      return {
        ok: false,
        details: `${this.cfg.alRunnerPath} reports "${reported.slice(0, 200)}", which is not an al-runner v3 build (R586)`,
      };
    }
    await this.learnSkipAfterTimeout(); // R907
    if (this.noClient && !this.noClientListed) {
      throw new AlRunnerV3NoClientUnsupportedError(
        `${this.cfg.alRunnerPath} (${reported})`,
        this.helpFailed
          ? "the `test --help` call failed"
          : "its `test --help` does not list --no-client",
      );
    }
    // T17 and M8: `<deps>`'s System Application must exist and equal bcVersion, here as in the CLI.
    try {
      await assertBcVersionMatchesPackages(this.cfg.packagesDir, this.cfg.bcVersion);
    } catch (err) {
      return { ok: false, details: err instanceof Error ? err.message : String(err) };
    }
    // §12: only a gated build runs (the update gate's candidate excepted).
    let gateRecord: string;
    let gatedWarnFacts: Readonly<Record<string, string>> | undefined;
    let binarySha256: string;
    try {
      const gated = await checkGated(this.cfg.alRunnerPath, reported, {
        ...(this.cfg.candidate === true ? { candidate: true } : {}),
      });
      this.build = { version: reported, binarySha256: gated.binarySha256 };
      // R834: say once which binary this session runs (not a report field).
      if (!this.announced) {
        this.announced = true;
        console.warn(`[lethal] al-runner: ${this.cfg.alRunnerPath} (${reported})`);
      }
      binarySha256 = gated.binarySha256;
      gatedWarnFacts = gated.warnFacts;
      // R886: not a gate input; the contract probe below runs without it.
      const sidecar = await resolveDotnetSidecar(
        this.cfg.dotnetSidecar,
        this.cfg.alRunnerPath,
        gated,
      ).catch((e: unknown) => e as Error);
      if (sidecar instanceof Error) return { ok: false, details: sidecar.message };
      this.sidecarPath = sidecar.path;
      if (sidecar.warning !== undefined)
        this.notify("al-runner-v3-dotnet-sidecar-unusable", `[lethal] ${sidecar.warning} (R886)`);
      // M1: a session trusts leg C's gate-only facts from this record instead of re-measuring them.
      gateRecord =
        this.cfg.candidate === true
          ? "this update gate's own leg C (a candidate build)"
          : gated.source === "manifest"
            ? `the gated release's leg C (gate manifest, lethalCommit ${gated.lethalCommit})`
            : `the gated build's leg C (.gated lethalCommit ${gated.lethalCommit})`;
    } catch (err) {
      if (err instanceof AlRunnerV3UngatedBuildError) return { ok: false, details: err.message };
      throw err;
    }
    // §8: the contract probe, once per backend (one session), after the version and pin checks.
    // R762: a fully passing probe of the same inputs is replayed from the cache (see its module).
    let probeNote = "";
    if (this.contract === undefined) {
      const run = (): Promise<V3ContractResult> =>
        runV3ContractProbe({
          alRunnerPath: this.cfg.alRunnerPath,
          expectedVersion: reported,
          packagesDir: resolve(this.cfg.packagesDir),
          bcVersion: this.cfg.bcVersion,
          environment: this.environmentChoice.value, // R938
          alcPath: this.cfg.alcPath,
          ...(this.cfg.cacheDir !== undefined ? { cacheDir: this.cfg.cacheDir } : {}),
          ...(Bun.which("taskset") !== null ? { tasksetPath: Bun.which("taskset") ?? "" } : {}),
          gateOnlyTrusted: gateRecord,
          ...(gatedWarnFacts !== undefined ? { gatedWarnFacts } : {}),
          spawn: this.spawn,
        });
      if (this.cfg.candidate === true) {
        // The update gate's candidate is never read from or written to the cache.
        this.contract = await run();
        probeNote = "probe ran fresh (candidate build)";
      } else {
        const forced = this.cfg.freshProbe === true || process.env[FRESH_PROBE_ENV] === "1";
        const key = await this.probeKey(reported, binarySha256, gateRecord);
        const digest = key === undefined ? "none" : keyDigest(key).slice(0, 12);
        let why = forced ? "forced" : key === undefined ? "key unavailable" : "no entry";
        let cached: V3ContractResult | undefined;
        if (key !== undefined && !forced) {
          try {
            cached = await readProbeCache(this.cfg.alRunnerPath, key);
          } catch (err) {
            why = "entry unusable";
            console.warn(
              `[lethal] ${err instanceof Error ? err.message : String(err)}; running the probe`,
            );
          }
        }
        if (cached !== undefined) {
          this.contract = cached;
          probeNote = `probe from cache (key ${digest})`;
        } else {
          this.contract = await run();
          probeNote = `probe ran fresh (key ${digest}; ${why})`;
          if (forced) {
            // R770: a forced run does not trust the cache, and the gates' throwaway dirs never match again.
            probeNote += "; forced; not cached";
          } else if (key !== undefined) {
            const no = uncacheableReason(this.contract, key.version, key.binarySha256);
            if (no !== undefined) {
              probeNote += `; not cached: ${no}`;
            } else {
              try {
                await writeProbeCache(this.cfg.alRunnerPath, key, this.contract);
              } catch (err) {
                console.warn(`[lethal] al-runner-v3 probe cache not written: ${String(err)}`);
              }
            }
          }
        }
      }
      console.warn(`[lethal] al-runner-v3 contract ${probeNote} (R762)`);
    }
    // R639 r9 §2: `unlike-bc` refuses a normal session; a candidate (update-gate) session warns.
    const kind = { candidate: this.cfg.candidate === true };
    // R719: a fact the running build's pin already covers (exact fact and outcome) is not warned
    // about; the session prints one pin line instead, so a pinned build is never fully silent.
    this.sleepRuleRetired = sleepRuleRetiredFor(this.contract, reported, binarySha256);
    this.serveRowFields = serveRowFieldsFor(reported, binarySha256); // R782
    // R779: say which §6 behaviour this session runs, once, beside the probe line.
    console.warn(sleepRuleLine(this.sleepRuleRetired, this.contract, reported, binarySha256));
    const covered = pinnedDefectCoverage(this.contract, reported, binarySha256);
    if (covered !== undefined) console.warn(covered.line);
    console.warn(
      `[lethal] al-runner-v3 one-shot calls ${this.skipAfterTimeoutLearned ? "carry" : "do not carry"} --skip-after-timeout${this.skipAfterTimeoutLearned ? "" : ` (${this.skipAfterTimeoutWhy})`} (R907)`,
    );
    for (const line of v3DefectWarnings(this.contract, { ...kind, muted: covered?.muted }))
      console.warn(line);
    const refusals = v3ContractRefusals(this.contract, kind);
    if (refusals.length > 0) return { ok: false, details: refusals.join("\n") };
    return {
      ok: true,
      details: `${reported}; ${v3ContractSummary(this.contract)}${probeNote !== "" ? `; ${probeNote}` : ""}; §6 Sleep rule ${this.sleepRuleRetired ? "retired" : "applies"} (R779)${this.entries ? `; transport serve-entries (R635), secondEcho ${this.cfg.secondEcho !== false}` : ""}${this.cfg.serveFallbackWarmup !== undefined ? `; transport one-shot (the serve-entries default fell back at the warm-up: ${this.cfg.serveFallbackWarmup}; R786)` : ""}`,
    };
  }

  /** R762: every input the probe's facts depend on; `undefined` (run the probe, cache nothing) when one cannot be read. */
  private async probeKey(
    version: string,
    binarySha256: string,
    gateRecord: string,
  ): Promise<ProbeCacheKey | undefined> {
    try {
      const code = await probeCodeHash();
      if (code === undefined) return undefined;
      return {
        binarySha256,
        version,
        probeCodeHash: code,
        bcVersion: this.cfg.bcVersion,
        environment: this.environmentChoice.value, // R938
        packages: await packagesFingerprint(this.cfg.packagesDir),
        alc: await alcIdentity(this.cfg.alcPath),
        cacheDir: this.cfg.cacheDir ?? null,
        gateRecord,
        tasksetPresent: Bun.which("taskset") !== null,
        libraryAssertApp: false,
      };
    } catch {
      return undefined;
    }
  }

  /** §8: the measured contract, for the gate's leg C and the report line. */
  private contract: V3ContractResult | undefined;

  contractResult(): V3ContractResult | undefined {
    return this.contract;
  }

  /**
   * R-762 B: decided once per `status()`. True only for a pinned build whose pin AND this session's
   * probe both read `sleep-is-noop` gone: then no covering pass under a mutant meets §6, no mutant
   * call asks for `--coverage-json`, and serve-entries opens no coverage window. The baseline keeps
   * its coverage. Default false (the rule applies).
   */
  private sleepRuleRetired = false;

  /**
   * R782: set by `status()`. True when the build's pin records #5798 fixed: serve rows are read from
   * their own `codeunit` and `method` fields, and a dotted test method may run under serve-entries.
   */
  private serveRowFields = false;

  /** R782: the switch, as the last `status()` decided it (read by tests and the gate). */
  isServeRowFields(): boolean {
    return this.serveRowFields;
  }

  /** R-762 B: the switch, as the last `status()` decided it (the gate's X legs read it). */
  isSleepRuleRetired(): boolean {
    return this.sleepRuleRetired;
  }

  private build: { readonly version: string; readonly binarySha256: string } | undefined;
  private announced = false;
  /**
   * R897, R-907: whether the running build's `test --help` lists `--skip-after-timeout`, so every
   * ONE-SHOT call passes it (after a stop, the rest of that codeunit is reported not run). Older
   * builds reject unknown flags, hence the check. Serve is unaffected: it has its own cut (R897).
   */
  private skipAfterTimeoutLearned = false;
  private skipAfterTimeoutWhy = "not checked";

  /** R907: reads `test --help` once per session (status() calls it). A failure is false, not a throw. */
  async learnSkipAfterTimeout(): Promise<void> {
    if (this.skipAfterTimeoutWhy !== "not checked") return;
    const res = await this.spawn([this.cfg.alRunnerPath, "test", "--help"], this.cacheEnv()).catch(
      (e: unknown) => ({ exitCode: -1, stdout: "", stderr: String(e) }),
    );
    if (res.exitCode !== 0) {
      this.skipAfterTimeoutLearned = false;
      this.helpFailed = true;
      this.skipAfterTimeoutWhy = "the `test --help` call failed";
      this.notify(
        "al-runner-v3-skip-after-timeout-unknown",
        `[lethal] al-runner v3 \`test --help\` failed (${(res.stderr || res.stdout).trim().slice(0, 200)}); one-shot calls go without --skip-after-timeout (R907)`,
      );
      return;
    }
    const help = `${res.stdout}\n${res.stderr}`;
    this.skipAfterTimeoutLearned = help.includes("--skip-after-timeout");
    this.skipAfterTimeoutWhy = this.skipAfterTimeoutLearned ? "" : "this build does not list it";
    this.noClientListed = help.includes("--no-client");
  }
  /** R907: whether the same `test --help` lists `--no-client`; false until learned or if the call failed. */
  private noClientListed = false;
  private helpFailed = false;
  /**
   * R886: the `--dotnet-sidecar` file of this session. A named file is set at construction (a
   * missing one refuses in `status()`); the pinned build's own is set by `status()`, which reads
   * its `.gated`.
   */
  private sidecarPath: string | undefined;
  /** R941/R943: the probing paths, absolute, as the .NET helper's assembly folders (empty when none). */
  private dotnetAssemblyDirs(): string[] {
    return (this.cfg.assemblyProbingPaths ?? []).map((d) => resolve(d));
  }

  /**
   * R886: the settings a `--resume` must find unchanged: the sidecar this session passes (its
   * dll's sha256, or "none") and R885's demo-data switch. Call after `status()`, which resolves
   * the pinned default sidecar.
   */
  async resumeInputs(): Promise<ResumeInputs> {
    return {
      dotnetSidecar: this.sidecarPath === undefined ? "none" : await sha256OfFile(this.sidecarPath),
      downloadDemoData: !this.noDownload(),
    };
  }

  /** Provenance for the run row and the report: the `--version` line and the binary's sha256. */
  async runnerBuild(): Promise<{ readonly version: string; readonly binarySha256: string }> {
    if (this.build === undefined) {
      const s = await this.status();
      if (!s.ok) throw new Error(s.details);
    }
    if (this.build === undefined) throw new Error("al-runner-v3: status() named no build");
    return this.build;
  }

  useBuildSymbols(symbols: readonly string[]): void {
    this.dropPair();
    this.buildSymbols = [...symbols];
  }

  useDiscoveredTests(tests: readonly TestMethodRef[]): void {
    this.dropPair();
    const m = new Map<number, number>();
    for (const t of tests) m.set(t.codeunitId, (m.get(t.codeunitId) ?? 0) + 1);
    this.testsPerCodeunit = m;
    this.discovered = [...tests];
  }

  /**
   * R761: decides the transport ONCE, after `useDiscoveredTests` and before the first deploy and
   * the first v3 process. Why here: the staged batch differs by transport (resource selector and
   * echo vs static selector), so the choice must precede `deploy`; and a `--resume` is known at
   * session start (a baseline snapshot is reused only on a resume, `allowReuse`), so every fact is
   * in hand then. After this, or after any v3 process started, `entries` is frozen.
   *
   * Explicit transport: unchanged, except that an explicit serve-entries (config key present) with a
   * "." in a test method name refuses by name (#5798), UNLESS the build's pin records #5798 fixed
   * (R782). Default: serve-entries unless a fallback
   * reason holds; then one-shot and ONE warning naming every reason.
   */
  async decideTransport(facts: { readonly resume: boolean }): Promise<void> {
    await this.pickTransport(facts);
    if (!this.isolatesTests) return;
    if (!this.entries) {
      throw new AlRunnerV3IsolateTestsRefusedError(
        this.fallbackReasons.length > 0
          ? this.fallbackReasons.join("; ")
          : 'the config sets "alRunnerV3.transport" to "one-shot"',
      );
    }
    this.notify(
      "al-runner-v3-isolate-tests",
      "[lethal] al-runner-v3-isolate-tests: every test of this run ran alone (--isolate-tests), one process per test at the baseline and one entry per test after it. Its verdicts are not comparable with a default run: a resume between the two is refused (R857).",
    );
  }

  private async pickTransport(facts: { readonly resume: boolean }): Promise<void> {
    this.resumeSession = facts.resume; // R766 (b): `parallelRefusal` reads it, whatever the transport
    if (this.cfg.transportSource === undefined) return; // an internal caller's own transport
    if (this.cfg.transportSource === "explicit") {
      if (this.cfg.transport === "serve-entries") {
        const dotted = this.discovered
          .filter((t) => t.method.includes("."))
          .map((t) => `${t.codeunitName}.${t.method}`);
        // R782: a build whose pin records #5798 fixed reads a dotted method from the row's fields.
        if (dotted.length > 0) {
          const b = await this.runnerBuild();
          this.serveRowFields = serveRowFieldsFor(b.version, b.binarySha256);
          if (!this.serveRowFields) throw new AlRunnerV3ServeDottedTestNameError(dotted);
        }
      }
      return;
    }
    if (this.transportFrozen)
      throw new AlRunnerV3TransportFrozenError("it was already decided or a v3 process started");
    const reasons: string[] = [];
    // R857: a resume under --isolate-tests runs its baseline again (`reusesBaselineSnapshot`).
    // R896 (build review 2): so does `isolation: "auto"`, which never reuses a snapshot.
    if (facts.resume && !this.isolatesTests && !this.isolationAuto) {
      reasons.push(
        "resume: a --resume / --resume-run session (a reused baseline has no rows for the serve warm-up, and the transport is not in the run's fingerprint)",
      );
    }
    // R918: the multi-object and #if-wrapped shapes are no fallback reason any more: legs MOE and
    // WRE measured them equal to one-shot per mutant (pre-commitment e1ca5d11). Coverage placement,
    // the shape-specific part, is built from the deployed text the same way under both transports.
    const { version, binarySha256 } = await this.runnerBuild();
    this.serveRowFields = serveRowFieldsFor(version, binarySha256);
    // R782: where #5798 is fixed, an inner "." is read like any proven inner character (the row's
    // own fields carry the method). Only the measured shape: exactly ONE "." with an ASCII letter or
    // digit on both sides (`Dot.Step`); any other dot shape stays unproven.
    const methodShape = (m: string): boolean =>
      V3_SERVE_PROVEN_NAME_SHAPES.method.test(
        this.serveRowFields ? m.replace(/^([^.]*[A-Za-z0-9])\.([A-Za-z0-9][^.]*)$/, "$1_$2") : m,
      );
    // R922 item 3 (R-929): the method only; a codeunit's name never reaches serve's addressing.
    const odd = this.discovered.filter((t) => !methodShape(t.method));
    if (odd.length > 0) {
      // R922: name the unproven method and its characters, not the whole test name.
      const named = [...new Set(odd.map((t) => unprovenNamePart(t.method)))];
      reasons.push(
        `unproven-test-name-shape: ${named.slice(0, 5).join("; ")}${named.length > 5 ? `; and ${named.length - 5} more` : ""} (name shapes not yet measured under serve-entries; "." in a method name is upstream #5798)`,
      );
    }
    if (V3_NO_SERVE_ENTRIES.includes(version)) {
      reasons.push(`no-serve-build: ${version} has no serve-entries path`);
    }
    const warmupFallback = this.cfg.serveFallbackWarmup;
    this.entries =
      this.cfg.transport === "serve-entries" &&
      reasons.length === 0 &&
      warmupFallback === undefined;
    this.transportFrozen = true;
    this.fallbackReasons = [
      ...reasons,
      ...(warmupFallback !== undefined ? [`the warm-up: ${warmupFallback}`] : []),
    ];
    if (warmupFallback !== undefined) {
      this.notify(
        "al-runner-v3-serve-default-fallback-warmup",
        `[lethal] al-runner-v3-serve-default-fallback-warmup: the serve-entries default stopped at the warm-up (${warmupFallback}), so this session was re-run one-shot, as an explicit "one-shot" run is. Nothing of the serve attempt is kept in this report; its run row stays in the store, marked so --resume skips it (the run id, if known, is in the parenthesis above). Set "alRunnerV3.transport" to choose a transport yourself (R786).`,
      );
    }
    if (reasons.length > 0) {
      this.notify(
        "al-runner-v3-serve-default-fallback",
        `[lethal] al-runner-v3-serve-default-fallback: this session runs one-shot, not the serve-entries default, because ${reasons.join("; ")}. Set "alRunnerV3.transport" in the config to choose a transport yourself (R761).`,
      );
    }
  }

  useSessionTests(suite: readonly TestMethodRef[]): void {
    this.dropPair();
    const m = new Map<number, TestMethodRef[]>();
    for (const t of suite) m.set(t.codeunitId, [...(m.get(t.codeunitId) ?? []), t]);
    this.suitePerCodeunit = m;
  }

  /** F5: the covering refs of `mutantId` and the budget each will be sent. */
  useCoveringBudgets(
    mutantId: string,
    budgets: readonly { readonly ref: TestMethodRef; readonly budgetMs: number }[],
  ): void {
    this.useCoveringBudgetsOn(this.soleLane("useCoveringBudgets"), mutantId, budgets);
  }

  private useCoveringBudgetsOn(
    lane: Lane,
    mutantId: string,
    budgets: readonly { readonly ref: TestMethodRef; readonly budgetMs: number }[],
  ): void {
    lane.dropPair();
    lane.plan = {
      mutantId,
      budgets: new Map(budgets.map((b) => [refKey(b.ref), b.budgetMs])),
    };
  }

  /** R766 (b): the one lane of a backend that never built lanes; once it did, a per-mutant call on the root is a bug. */
  private soleLane(method: string): Lane {
    if (this.lanesBuilt) {
      throw new Error(
        `al-runner-v3-lane-misuse: ${method}() was called on the root backend after lanes(N) built ${this.laneList.length} lanes; per-mutant calls go through a lane view (R766)`,
      );
    }
    return this.lane;
  }

  /** R766 (b): an owner-only method asked of a lane view. */
  private ownerOnly(method: string): never {
    throw new Error(
      `al-runner-v3-lane-misuse: ${method}() is owner-only; it was called on a lane view (R766)`,
    );
  }

  dependencyPackageDirs(): readonly string[] {
    return [this.cfg.packagesDir];
  }

  /** R435: v3's artifact cache app folder, where it keeps `*.Source.zip` Microsoft test libraries.
   *  Absent without a `cacheDir`: v3's own default cache is not named here. */
  dependencyArtifactAppsDir(): string | undefined {
    return this.cfg.cacheDir === undefined
      ? undefined
      : join(resolve(this.cfg.cacheDir), "artifacts", this.cfg.bcVersion, "apps");
  }

  /** R635 §3 (R517): the daemon's stop, `S = max(1, ceil(max(floor, baseline) / 1000))`. */
  useMutantBudgetFloor(floorMs: number, baselineTimeoutMs: number): void {
    this.dropPair();
    this.budgetFloor = { floorMs, baselineTimeoutMs };
  }

  /** R954: the session's mutant stop, once the orchestrator gave one (no `--mutant-timeout-ms`). */
  useMutantStop(ms: number): void {
    // No dropPair: ensureDaemon replaces a daemon whose stop differs, and the baseline bracket dropped any pair.
    this.mutantStopMs = ms;
  }
  private mutantStopMs: number | undefined;

  private serveStopSeconds(): number | undefined {
    const f = this.budgetFloor;
    if (f === undefined) return undefined;
    if (this.mutantStopMs !== undefined) return stopSecondsOf(this.mutantStopMs); // R954
    return stopSecondsOf(Math.max(f.floorMs, f.baselineTimeoutMs));
  }

  /** R635 §4: the orchestrator's bracket around its baseline step. The ONLY source of `inBaseline`. */
  baselinePhase(on: boolean): void | Promise<void> {
    this.dropPair();
    this.pairStore.clear();
    this.inBaseline = on;
    // R948: the baseline's own daemon is closed before the mutant phase starts its own (its stop
    // differs, and it holds 2-3 GB).
    if (!on && this.laneList.some((l) => l.hasBaselineDaemon())) return this.closeBaselineDaemons();
  }

  private async closeBaselineDaemons(): Promise<void> {
    for (const l of this.laneList)
      if (l.hasBaselineDaemon()) await this.closeLane(l, "baseline-end");
  }

  /** R948: see `ExecutionBackend.useStopHandle`. */
  useStopHandle(handle: StopHandle): void {
    this.stopHandle = handle;
  }

  /** R635: the transport's counters (serve-entries). */
  entriesStats(): Readonly<V3EntriesStats> {
    // R766: the counters are the backend's; the phase timers are the lanes', summed.
    const timers = { ...this.lane.timers };
    for (const l of this.laneList.slice(1)) {
      for (const k of Object.keys(timers) as V3PhaseTimer[]) timers[k] += l.timers[k];
    }
    return { ...this.stats, ...timers };
  }

  /** R635 §4: one-shot keeps `lastActivated === null`; serve-entries reads the bracket only. */
  private isBaselineCall(lane: Lane): boolean {
    return this.entries ? this.inBaseline : lane.lastActivated === null;
  }

  /** Index-only refusals, merged into selection by `runSession` after each deploy (as v2). */
  async coverageRefusals(): Promise<ReadonlyMap<string, string>> {
    return this.coverageIndex?.refusals ?? new Map();
  }

  /** The Sleep index size of the deployed batch (the pre-committed figure). */
  sleepIndexSize(): { readonly target: number; readonly test: number } | undefined {
    return this.sleepIndex?.sizes;
  }

  /**
   * The environment of EVERY al-runner process this backend starts. R645: `ALRUNNER_CACHE`,
   * absolute, because v3 now runs in another cwd. R807: plus the pinned run seed, always.
   */
  private cacheEnv(): { env: Record<string, string> } {
    return {
      env: v3ChildEnv(
        this.cfg.cacheDir !== undefined
          ? { ALRUNNER_CACHE: resolve(this.cfg.cacheDir) }
          : undefined,
      ),
    };
  }

  /** R807: the seed the build reported (already checked to be the pinned one); absent when none. */
  private observedSeed: number | undefined;
  observedRunSeed(): number | undefined {
    return this.observedSeed;
  }

  /** C2 and R349: every field derived from the deployed layout or the active mutant. */
  private resetLayoutState(): void {
    for (const l of this.laneList) l.resetLayout();
    this.coverageIndex = undefined;
    this.sleepIndex = undefined;
    this.proof = undefined;
    this.batchBlind = undefined;
    this.latchBy = undefined;
    this.prefetched = new Map();
    this.pairStore.clear();
    this.baselineRows = new Map();
    this.union = new Set();
    this.echoId = undefined;
    this.speculative = undefined; // R790: never served across deploys
    this.isolatedBaseline = new Map(); // R866: nor these
    this.isolatedFilled = false;
    this.daemonBaseline = new Map(); // R948: nor these
    this.daemonBaselineFilled = false;
  }

  /** A batch as v3 reads it: control files dropped, the static selector at the baseline. R635: in
   *  serve-entries, R222's resource selector (file = NONE) and the echo at `controlId` instead. */
  private async stage(fromDir: string, toDir: string): Promise<string> {
    await rm(toDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    await cp(fromDir, toDir, { recursive: true });
    for (const f of [CONTROL_REGISTER_FILENAME, CONTROL_UPGRADE_FILENAME]) {
      await rm(join(toDir, f), { force: true });
    }
    const { artifactId } = await readManifestIds(toDir);
    if (this.entries) {
      assertResourceSelectorRuntime(
        JSON.parse(await readFile(join(toDir, "app.json"), "utf8")) as Record<string, unknown>,
        "resource",
      );
      await installResourceSelector(toDir, this.cfg.selectorObjectId, artifactId);
      const echoId = await readEchoId(toDir);
      await writeFile(join(toDir, SELECTOR_ECHO_FILENAME), emitSelectorEcho(echoId), "utf8");
      return artifactId;
    }
    await writeFile(
      join(toDir, CONTROL_SELECTOR_FILENAME),
      this.selectorText(artifactId, null),
      "utf8",
    );
    return artifactId;
  }

  private selectorText(artifactId: string, activeId: string | null): string {
    return emitStaticSelector({
      objectId: this.cfg.selectorObjectId,
      activeId: activeId ?? "",
      artifactId,
      targetAppId: "",
    });
  }

  /** §3 step 1: alc on a staged batch against `<deps>`. */
  private async compileTarget(dir: string): Promise<{ appPath: string; sha256: string }> {
    await mkdir(join(this.cfg.instrumentedDir, "alc-out"), { recursive: true });
    return this.compiler.compileProject({
      projectDir: dir,
      packageCachePath: this.cfg.packagesDir,
      name: "v3-batch",
    });
  }

  async deploy(instrumentedDir: string): Promise<null> {
    this.preRunDemoLine(); // R885
    this.announceMemoryGuard(); // R948: the guard's first line, before any process starts
    await this.closeAllDaemons("deploy");
    this.resetLayoutState();
    const active = this.lane.activeDir();
    const artifactId = await this.stage(instrumentedDir, active);
    if (this.entries) this.echoId = await readEchoId(active);
    const { ids } = await readManifestIds(active);
    // R790 (A1): while alc proves the batch, its one-shot baseline calls run on the same bytes. Their
    // answers stay private: deploy() still waits for alc and throws exactly its error, and they are
    // served (once each) only if every byte they read is a byte the proof below records.
    const speculate =
      this.speculateOn &&
      this.entries &&
      this.budgetFloor !== undefined &&
      this.suitePerCodeunit.size > 0 &&
      !this.isolatesTests && // R857: its calls run whole codeunits
      this.cfg.daemonBaseline !== true && // R948: the daemon baseline replaces those processes
      this.seams.noSpeculativeBaseline !== true;
    const abort = new AbortController();
    // Option 4: alc's writes from an identical batch, placed first, so the calls read what alc leaves.
    const cached = speculate
      ? await this.placeCachedAlcWrites(active)
      : { placed: new Set<string>(), key: undefined };
    const spec = speculate ? this.speculateBaseline(active, abort.signal) : undefined;
    // Step 1: the target. AlcCompileError goes to the orchestrator's R461 / bisection path.
    let target: { appPath: string; sha256: string };
    try {
      target = speculate
        ? await this.compileTargetCopy(active, cached.placed, cached.key)
        : await this.compileTarget(active);
    } catch (err) {
      abort.abort();
      await spec; // settled, then dropped: nothing from it is kept
      throw err;
    }
    // R790 (c): joined BEFORE the test-app compile, which may write into the test dir (R780).
    const specDone = await spec;
    try {
      // R780: `pre` (read BEFORE the compile) feeds ONLY the cache key and the hit decision. The
      // proof below comes from a read AFTER a live compile, because real alc can write into the
      // test dir (`features: ["TranslationFile"]` writes Translations/<App>.g.xlf). On a hit no
      // alc ran, so `pre` is the proof's read too.
      const pre = await this.readTestDir().catch((err: unknown) => ({ err }));
      if ("err" in pre) {
        // R780: the read that today ran AFTER the test-app compile failed. Keep today's order: alc
        // runs live first (so a TestAppError wins, as before), then the read's own error surfaces.
        await this.compileTestAppAgainst(target.appPath, active, undefined);
        throw pre.err;
      }
      // Step 2: the test app, against the batch's .app plus `<deps>` without any copy of the target.
      const compiled = await this.compileTestAppAgainst(target.appPath, active, pre);
      const testAppSha256 = compiled.sha256;
      const post = compiled.live ? await this.readTestDir() : pre;
      // R811: alc read a copy, so nothing it did can move the test dir: any change is a change it
      // did not see, and the proof below would name bytes it never compiled.
      if (compiled.copied && !sameTestDirRead(pre, post)) {
        throw new TestAppError(
          "compile-failed",
          `al-runner-v3: the test dir changed while its copy was compiled, so no test of it can be trusted (R811): ${this.cfg.testDir}`,
        );
      }
      const { testScan, testOther, testAppJsonSha256 } = post;
      // Step 3: the proof, every <deps> file hashed now (m-2), and the per-run checks' baseline.
      this.proof = {
        // R655: active/ is LethAL's copy and holds no link; one refuses here, by path.
        activeHashExceptSelector: await linkIsUnproven(hashAlTree(active), "the staged batch"),
        activeAppJsonSha256: await fileSha256(join(active, "app.json")),
        testDirHash: testScan.hash,
        activeOther: await listOtherFiles(active, OTHER_FILES_UNBOUND, true),
        testOther,
        testAppJsonSha256,
        deps: await listDeps(this.cfg.packagesDir, true),
        artifactId,
        manifestIds: ids,
        targetAppSha256: target.sha256,
        testAppSha256,
      };
      // R780: a passing LIVE compile writes its marker only if the test dir did not change across
      // it (the key came from `pre`; a different `post` would cache state B under key(A)).
      if (compiled.live && compiled.key !== undefined && sameTestDirRead(pre, post)) {
        await this.proofStore()?.put(compiled.key);
      }
    } finally {
      await rm(target.appPath, { force: true }).catch(() => {});
    }
    this.lane.deployedDir = active;
    if ((this.cfg.coverage ?? "none") !== "none") {
      const symbols = this.buildSymbols;
      if (symbols === undefined) {
        throw new Error(
          "al-runner-v3: coverage is on but the session's build symbols were never handed over (useBuildSymbols); refusing rather than guessing the #if arms (R-300b).",
        );
      }
      const index = await buildAlRunnerCoverageIndex(active, {
        symbols,
        notify: this.notify,
        ...(this.cfg.sourceProjectDir !== undefined
          ? { sourceProjectDir: this.cfg.sourceProjectDir }
          : {}),
      });
      assertManifestObjectsDeclared(
        await readManifestObjectKeys(active),
        index.declared,
        index.lineMap.mappedKeys(),
        index.exempt,
        index.lineMap.unreadFiles,
      );
      this.coverageIndex = index;
    }
    // §6 (I-1 (1)): from the text v3 reads, rebuilt with every deploy.
    this.sleepIndex = await buildSleepIndex(active, this.cfg.testDir);
    const realActive = await realpath(active);
    const realTest = await realpath(this.cfg.testDir);
    this.lane.realActive = realActive;
    this.realTestDir = realTest;
    await this.copyLanes(active);
    // R790 (b): kept only when the bytes were the proved bytes both before and after the calls ran,
    // and they read the same real paths a live call reads; any mismatch leaves the baseline live.
    const proof = this.proof;
    if (
      specDone !== undefined &&
      proof !== undefined &&
      specDone.before === this.proofKey(proof) &&
      specDone.after === specDone.before &&
      specDone.realActive === realActive &&
      specDone.realTest === realTest
    ) {
      this.speculative = { dir: active, calls: specDone.calls };
    }
    await this.probeBatchRefusal(this.lane); // R927: explicit serve-entries only
    return null;
  }

  /** R790 (c): alc on a COPY of the batch, so it never writes (Translations/*.g.xlf) where a v3 call reads. */
  private async compileTargetCopy(
    active: string,
    placed: ReadonlySet<string>,
    cacheKey: string | undefined,
  ): Promise<{ appPath: string; sha256: string }> {
    const copy = join(this.cfg.instrumentedDir, "alc-src");
    await rm(copy, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    await cp(active, copy, { recursive: true, preserveTimestamps: true });
    const states = await fileStates(copy);
    let out: { appPath: string; sha256: string };
    try {
      out = await this.compileTarget(copy);
    } catch (err) {
      throw errorAsIfIn(err, copy, active);
    }
    // Review 4: whatever alc wrote into its project (Translations/*.g.xlf) goes into the batch too,
    // so v3 reads the bytes it read before R790. A file already there with the SAME bytes (option 4's
    // placed copy) is left as it is, so the calls' key still matches; different bytes are copied over,
    // and then the key differs and nothing is served.
    const written = new Map<string, Buffer>();
    for (const [rel, state] of await fileStates(copy)) {
      if (states.get(rel) === state) continue;
      const bytes = await readFile(join(copy, rel));
      written.set(rel, bytes);
      const there = await readFile(join(active, rel)).catch(() => undefined);
      if (there?.equals(bytes) === true) continue;
      await mkdir(dirname(join(active, rel)), { recursive: true });
      await cp(join(copy, rel), join(active, rel), { preserveTimestamps: true });
    }
    // Option 4: a placed file alc did not write is not one v3 would read without R790: removed.
    for (const rel of placed) if (!written.has(rel)) await rm(join(active, rel), { force: true });
    if (cacheKey !== undefined && written.size > 0 && this.cfg.cacheDir !== undefined) {
      await writeAlcWrites(join(resolve(this.cfg.cacheDir), "alc-writes"), cacheKey, written);
    }
    return out;
  }

  /**
   * R790 (option 4): before the speculative calls, the files alc wrote into an identical batch last
   * time (keyed by its `.al` hash and app.json) are placed into it, so the calls read the batch as
   * alc will leave it. Only files the batch does not hold yet. Returns what was placed and the key.
   */
  private async placeCachedAlcWrites(
    active: string,
  ): Promise<{ readonly placed: Set<string>; readonly key: string | undefined }> {
    const placed = new Set<string>();
    if (this.cfg.cacheDir === undefined) return { placed, key: undefined };
    // The project's app.json without the version LethAL stamps per build (the .al hash and the
    // version differ every run; alc's .xlf, measured on D1, does not). A weak key only costs a hit:
    // alc's real output decides.
    let key: string;
    try {
      const app = JSON.parse(await readFile(join(active, "app.json"), "utf8")) as Record<
        string,
        unknown
      >;
      const { version: _stamped, ...rest } = app;
      key = sha256Of(
        JSON.stringify(
          Object.keys(rest)
            .sort()
            .map((k) => [k, rest[k]]),
        ),
      );
    } catch {
      return { placed, key: undefined };
    }
    const files = await readAlcWrites(join(resolve(this.cfg.cacheDir), "alc-writes"), key);
    try {
      for (const [rel, bytes] of files) {
        const to = join(active, rel);
        if ((await stat(to).catch(() => undefined)) !== undefined) continue;
        await mkdir(dirname(to), { recursive: true });
        await writeFile(to, new Uint8Array(bytes));
        placed.add(rel);
      }
    } catch {
      // A hint only (review r2 #3): a placement that fails is undone and is a miss.
      for (const rel of placed) await rm(join(active, rel), { force: true }).catch(() => {});
      placed.clear();
    }
    return { placed, key };
  }

  /** R790: the bytes v3 reads, as the proof records them (§3): the batch, the test dir, `<deps>`. */
  private async boundKey(active: string): Promise<string> {
    const t = await this.readTestDir();
    return JSON.stringify([
      await linkIsUnproven(hashAlTree(active), "the staged batch"),
      await fileSha256(join(active, "app.json")),
      otherFilesKey(await listOtherFiles(active, OTHER_FILES_UNBOUND, true)),
      t.testScan.hash,
      otherFilesKey(t.testOther),
      t.testAppJsonSha256,
      await listDeps(this.cfg.packagesDir, true),
    ]);
  }

  private proofKey(p: BatchProof): string {
    return JSON.stringify([
      p.activeHashExceptSelector,
      p.activeAppJsonSha256,
      otherFilesKey(p.activeOther),
      p.testDirHash,
      otherFilesKey(p.testOther),
      p.testAppJsonSha256,
      p.deps,
    ]);
  }

  /**
   * R790 (A1): the baseline's one-shot calls (one per suite codeunit, at the baseline's stop, with
   * coverage, exactly as `callCodeunit` makes them inside the baseline bracket), run while alc proves
   * the batch. `undefined` when anything fails or alc failed (`signal`): the baseline then runs live.
   */
  private async speculateBaseline(
    active: string,
    signal: AbortSignal,
  ): Promise<
    | {
        readonly before: string;
        readonly after: string;
        readonly realActive: string;
        readonly realTest: string;
        readonly calls: Map<number, SpeculativeCall>;
      }
    | undefined
  > {
    try {
      const f = this.budgetFloor;
      if (f === undefined) return undefined;
      const stopSeconds = stopSecondsOf(f.baselineTimeoutMs);
      const before = await this.boundKey(active);
      const realActive = await realpath(active);
      const realTest = await realpath(this.cfg.testDir);
      const covDir = join(this.cfg.instrumentedDir, "cov");
      await mkdir(covDir, { recursive: true });
      await mkdir(this.lane.scratchCwd(), { recursive: true });
      const calls = new Map<number, SpeculativeCall>();
      for (const id of [...this.suitePerCodeunit.keys()].sort((a, b) => a - b)) {
        if (signal.aborted) return undefined;
        // R896: a codeunit on "method" runs per test (`fillIsolatedBaseline`), never whole.
        if (this.perTest(id)) continue;
        this.callSeq += 1;
        // Named as a live call's file is, so the call's argv is the live call's argv.
        const covPath = join(covDir, `call-${this.callSeq}.json`);
        await rm(covPath, { force: true });
        const made = await this.spawnCodeunit({
          id,
          stopSeconds,
          coverageJson: covPath,
          cwd: this.lane.scratchCwd(),
          activeDir: realActive,
          testDir: realTest,
          signal,
        });
        if (signal.aborted) return undefined;
        let covText: string | undefined;
        try {
          covText = await readFile(covPath, "utf8");
        } catch {
          covText = undefined;
        }
        await rm(covPath, { force: true }).catch(() => {});
        // A spawn that failed is not kept: that codeunit's baseline call runs live.
        if ("spawnError" in made) continue;
        if (!this.cleanBaselineAnswer(made, id, f.floorMs)) continue;
        calls.set(id, {
          ...made,
          ...(covText !== undefined ? { covText } : {}),
          stopSeconds,
          coverage: true,
        });
      }
      await this.seams.afterSpeculation?.();
      const after = await this.boundKey(active);
      return { before, after, realActive, realTest, calls };
    } catch {
      return undefined;
    }
  }

  /** R790: whether a baseline answer made beside other work may stand in for a live call. */
  private cleanBaselineAnswer(made: SpawnedCall, id: number, floorMs: number): boolean {
    // Review 2: a call that ran out of time ran beside alc's CPU, so it may not be what a live
    // baseline call would answer: not kept, that codeunit's call runs live.
    if (made.timedOut) return false;
    // Review r2 #2: only a clean answer (an exit code `callCodeunit` reads as rows, rows that
    // decode) is kept; a crash or garbage beside alc runs live.
    if (![0, 1, 7, 8].includes(made.res.exitCode)) return false;
    const decoded = decodeV3Rows(made.res.stdout, id);
    if ("why" in decoded) return false;
    this.observedSeed = decoded.seed ?? this.observedSeed;
    if (decoded.rows.some((r) => r.message !== undefined && V3_TIMEOUT_MESSAGE.test(r.message)))
      return false;
    // Review r2 #1: the durations were measured beside alc's CPU. A budget is
    // max(2 x duration, floor), so a call is kept only when the floor decides every budget it
    // feeds: then a served duration cannot move a budget (the default floor is 180 s).
    const tooSlow = (ms: number) => 2 * ms >= floorMs;
    return !tooSlow(made.wallMs) && !decoded.rows.some((r) => tooSlow(r.durationMs ?? 0));
  }

  /**
   * R866: under `--isolate-tests`, at the first baseline call of a batch, every suite test's process
   * at once, `ISOLATED_BASELINE_PROCESSES` at a time. Each process holds one test, so running them
   * side by side changes nothing they isolate. An answer stands only under R790's rule, so a
   * duration measured beside the others cannot move a budget; any other test runs alone as before.
   * ponytail: a daemon request per test would be cheaper still, but needs a daemon before the
   * baseline has rows to warm it up with; see R866.
   */
  private async fillIsolatedBaseline(
    lane: Lane,
    stopSeconds: number,
    coverage: boolean,
  ): Promise<void> {
    const f = this.budgetFloor;
    if (this.isolatedFilled || f === undefined) return;
    this.isolatedFilled = true;
    const queue = [...this.suitePerCodeunit.values()].flat();
    // R948: one codeunit-isolation daemon answers every test, one request each; a test it cannot
    // answer cleanly is left for its own call, which runs it alone one-shot as before.
    if (this.daemonBaselineOn())
      return this.fillIsolatedViaDaemon(lane, queue, stopSeconds, coverage);
    const covDir = join(this.cfg.instrumentedDir, "cov");
    await this.checkBound(lane); // R652: the bytes these read; each answer is checked again when served
    const worker = async () => {
      for (let ref = queue.shift(); ref !== undefined; ref = queue.shift()) {
        const key = this.callId(ref);
        const onlyTest = this.isolated(key)?.test;
        if (onlyTest === undefined) continue;
        // R948: over the memory bound no new process starts; the test is left unanswered, and its
        // own call (gated too) is then dropped like a signalled one.
        if (this.stopHandle?.spent() === true || !(await this.memoryGate(true))) {
          queue.length = 0;
          return;
        }
        this.callSeq += 1;
        const covPath = join(covDir, `call-${this.callSeq}.json`);
        let made: Awaited<ReturnType<AlRunnerV3Backend["spawnCodeunit"]>>;
        try {
          await rm(covPath, { force: true });
          made = await this.spawnCodeunit({
            id: ref.codeunitId,
            stopSeconds,
            coverageJson: coverage ? covPath : undefined,
            cwd: lane.scratchCwd(),
            activeDir: lane.realActive ?? resolve(lane.activeDir()),
            testDir: this.realTestDir ?? resolve(this.cfg.testDir),
            onlyTest,
          });
        } finally {
          this.memoryRelease();
        }
        const covText = coverage
          ? await readFile(covPath, "utf8").catch(() => undefined)
          : undefined;
        await rm(covPath, { force: true }).catch(() => {});
        if ("spawnError" in made) continue;
        if (!this.aloneAnswer(made, ref, f.floorMs)) continue;
        this.isolatedBaseline.set(key, {
          ...made,
          ...(covText !== undefined ? { covText } : {}),
          stopSeconds,
          coverage,
        });
      }
    };
    // Every worker ends before a failure goes on, so no process outlives this call.
    const stopped = await Promise.allSettled(
      Array.from(
        { length: this.cfg.isolatedBaselineProcesses ?? ISOLATED_BASELINE_PROCESSES },
        () =>
          worker().catch((err: unknown) => {
            queue.length = 0;
            throw err;
          }),
      ),
    );
    for (const s of stopped) if (s.status === "rejected") throw s.reason;
  }

  /**
   * R866: R790's rule, plus what running beside other al-runners can break: exactly one row, that
   * test's, and one that ran. Exit 8 or a `notRun` row may be a .NET helper that lost a race, and
   * served as a refusal it would drop the test from the batch, so such a test runs alone.
   */
  private aloneAnswer(made: SpawnedCall, ref: TestMethodRef, floorMs: number): boolean {
    if (!this.cleanBaselineAnswer(made, ref.codeunitId, floorMs)) return false;
    if (made.res.exitCode === 8) return false;
    const decoded = decodeV3Rows(made.res.stdout, ref.codeunitId);
    if ("why" in decoded) return false;
    const [row] = decoded.rows;
    return (
      decoded.rows.length === 1 &&
      row !== undefined &&
      !row.notRun &&
      row.method.toLowerCase() === ref.method.toLowerCase()
    );
  }

  /** R948: whether the baseline runs through a serve daemon (serve-entries, asked for, not dropped). */
  private daemonBaselineOn(): boolean {
    return this.cfg.daemonBaseline === true && this.entries && this.daemonBaselineOff === undefined;
  }

  /**
   * R948: the cross-check failed or the daemon proved unusable: the whole session's baseline goes
   * back to one process per codeunit, never a mix, and one notice names why.
   */
  private dropDaemonBaseline(why: string, detail: readonly string[] = []): void {
    this.daemonBaselineOff = why;
    this.daemonBaselineDetail = [...detail];
    this.daemonBaseline.clear();
    this.notify(
      "al-runner-v3-baseline-daemon-dropped",
      `[lethal] al-runner-v3-baseline-daemon-dropped: ${why}. The baseline of this session runs one al-runner process per codeunit instead, so it is slower; no daemon answer is used (R948).`,
    );
  }

  /** R948: the baseline's own daemon for `mode`, started with the baseline's stop; replaced when its stop differs. */
  private async baselineDaemonFor(
    lane: Lane,
    mode: RequestMode,
    stopSeconds: number,
  ): Promise<Daemon> {
    const had = lane.daemonFor(mode);
    if (had !== undefined && had.baselineStop === stopSeconds) return had;
    if (had !== undefined) await this.closeLane(lane, "baseline-end");
    this.transportFrozen = true; // R761
    const d = await this.spawnDaemon(lane, mode, stopSeconds);
    d.baselineStop = stopSeconds;
    return d;
  }

  /**
   * R948: one `plain()` request on the baseline daemon: `call` (a codeunit, or one test's id under
   * `mode`) with coverage. A daemon that kept a row R612 does not keep is closed and the NEXT request
   * starts a fresh one: the row stands, nothing is re-run. `undefined`: the answer is not usable
   * (a suite test without exactly one row, or no coverage), so that call runs one-shot.
   * A request error propagates as `AlRunnerServerRequestError` (the daemon is already closed).
   */
  private async baselineRequest(
    lane: Lane,
    mode: RequestMode,
    call: number,
    stopSeconds: number,
    coverage: boolean,
  ): Promise<BaselineAnswer | undefined> {
    const daemon = await this.baselineDaemonFor(lane, mode, stopSeconds);
    const started = Date.now();
    const out = await this.plain(lane, daemon, mode, call, coverage, stopSeconds);
    const wallMs = Date.now() - started;
    if (daemon.dirty) {
      await this.closeLane(lane, daemon.dirtyWhy?.reason ?? "unkept-row", daemon.dirtyWhy?.family);
    }
    if (coverage && out.coverage.kind === "unavailable") return undefined;
    return {
      rows: out.rows.map((r) => ({ ...r, flaggedUnknown: true as const })), // R949
      coverage: out.coverage,
      wallMs,
      stopSeconds,
      withCoverage: coverage,
      fromDaemon: true,
    };
  }

  /** R948: whether `rows` hold exactly one row for each of `tests` (a call's answer is cached only then). */
  private hasEveryRow(rows: readonly V3Row[], tests: readonly TestMethodRef[]): boolean {
    return tests.every(
      (t) => rows.filter((r) => r.method.toLowerCase() === t.method.toLowerCase()).length === 1,
    );
  }

  /**
   * R948: codeunit `id` as a fresh one-shot process, for the cross-check and for a codeunit too slow
   * for the daemon's duration to be trusted. Refusals a baseline call would raise are raised here
   * (a skipped dependency, a missing one, a compile refusal: R944). `undefined`: no clean answer.
   */
  private async oneShotBaselineAnswer(
    lane: Lane,
    id: number,
    stopSeconds: number,
    coverage: boolean,
    /** One test alone (a per-test sample): its ref and `--test-exact` selection. Absent: the whole codeunit. */
    only?: { readonly ref: TestMethodRef; readonly test: string },
  ): Promise<BaselineAnswer | undefined> {
    if (!(await this.memoryGate(true))) return undefined;
    const covDir = join(this.cfg.instrumentedDir, "cov");
    let covPath = "";
    let made: Awaited<ReturnType<AlRunnerV3Backend["spawnCodeunit"]>>;
    try {
      await mkdir(covDir, { recursive: true });
      this.callSeq += 1;
      covPath = join(covDir, `call-${this.callSeq}.json`);
      await rm(covPath, { force: true });
      made = await this.spawnCodeunit({
        id,
        stopSeconds,
        coverageJson: coverage ? covPath : undefined,
        cwd: lane.scratchCwd(),
        activeDir: lane.realActive ?? resolve(lane.activeDir()),
        testDir: this.realTestDir ?? resolve(this.cfg.testDir),
        beforeSpawn: () => this.checkBound(lane),
        ...(only !== undefined ? { onlyTest: only.test } : {}),
      });
    } finally {
      this.memoryRelease(); // a throw anywhere from the mkdir on still gives the hold back
    }
    const covText = coverage ? await readFile(covPath, "utf8").catch(() => undefined) : undefined;
    await rm(covPath, { force: true }).catch(() => {});
    if ("spawnError" in made || made.timedOut) return undefined;
    const { res } = made;
    refuseDependencySkip(res.stderr);
    refuseMissingDependency(res.exitCode, res.stderr);
    const compileRefusal = v3CompileRefusal(res.exitCode, `${res.stdout}\n${res.stderr}`);
    if (compileRefusal !== undefined) throw new AlRunnerV3CompileRefusedError(compileRefusal);
    if (![0, 1].includes(res.exitCode)) return undefined;
    const decoded = decodeV3Rows(res.stdout, id);
    if ("why" in decoded) return undefined;
    this.observedSeed = decoded.seed ?? this.observedSeed;
    if (
      !this.hasEveryRow(
        decoded.rows,
        only !== undefined ? [only.ref] : (this.suitePerCodeunit.get(id) ?? []),
      )
    ) {
      return undefined;
    }
    return {
      rows: decoded.rows,
      coverage: decodeV3Coverage(covText),
      wallMs: made.wallMs,
      stopSeconds,
      withCoverage: coverage,
    };
  }

  /**
   * R948: at the first baseline call of a batch, every suite codeunit through ONE serve daemon (a
   * `plain()` request each, with coverage, started with the baseline's own stop), ahead of the
   * orchestrator's loop; each call then takes its answer (`takeDaemonBaseline`).
   *
   * Safeguards, each before an answer is kept:
   * - R652: the bound is checked before every request. R955: `spent()` before each, `signalled()`
   *   after (the call a stop signal ended is dropped). The memory guard gates each request.
   * - The cross-check (adversary item 1): the first and last codeunit, and every
   *   `BASELINE_SAMPLE_EVERY`th, are also run one-shot and compared test by test (status, notRun,
   *   fail text, exact coverage set). Any difference, or a sample with no clean one-shot answer,
   *   drops the daemon baseline for the whole session. Nothing is served before the fill ends, so
   *   no verdict ever rests on an answer that is dropped later.
   * - Durations: a daemon is warm, so its durations are shorter than a fresh process's. A budget is
   *   `max(2 x duration, floor)`; a codeunit with any test where `2 x duration >= floor` is re-run
   *   one-shot and its one-shot answer stands, so a warm duration never moves a budget (R790's rule).
   * - Two requests in a row without a usable answer drop the daemon baseline too.
   */
  private async fillDaemonBaseline(
    lane: Lane,
    stopSeconds: number,
    coverage: boolean,
  ): Promise<void> {
    const f = this.budgetFloor;
    if (this.daemonBaselineFilled || f === undefined) return;
    this.daemonBaselineFilled = true;
    const ids = [...this.suitePerCodeunit.keys()]
      .filter((id) => !this.perTest(id))
      .sort((a, b) => a - b);
    if (this.seams.reverseBaselineOrder === true) ids.reverse();
    const sample = new Set(baselineSampleIds(ids));
    this.baselineStats.codeunits = ids.length;
    this.baselineStats.sampled = [...sample];
    const mode: RequestMode = { testIsolation: SERVE_TEST_ISOLATION, runSelectedOnly: false };
    const answers = new Map<number, BaselineAnswer>();
    let unusable = 0;
    try {
      for (const id of ids) {
        if (this.stopHandle?.spent() === true) break; // R955
        if (!(await this.memoryGate(true))) break; // R948: no new request over the bound
        let got: BaselineAnswer | undefined;
        try {
          await this.checkBound(lane); // R652 (inside the try: a throw still releases the hold)
          this.baselineStats.requests += 1;
          got = await this.baselineRequest(lane, mode, id, stopSeconds, coverage);
        } catch (err) {
          if (!(err instanceof AlRunnerServerRequestError)) throw err;
          got = undefined; // the daemon was closed; this codeunit runs one-shot
        } finally {
          this.memoryRelease();
        }
        if (this.stopHandle?.signalled() === true) break; // R955: that call is dropped
        if (got !== undefined && !this.hasEveryRow(got.rows, this.suitePerCodeunit.get(id) ?? [])) {
          got = undefined;
        }
        if (got === undefined) {
          this.noteSkip("error", `Codeunit${id}`, sample.has(id));
          unusable += 1;
          if (unusable >= 2) {
            this.dropDaemonBaseline("two serve requests in a row gave no usable baseline answer");
            return;
          }
          continue;
        }
        unusable = 0;
        // The duration the budget will use is the verdict's: the row's, else the call's wall time.
        const tooSlow = durationCouldMoveBudget(got.rows, got.wallMs, f.floorMs);
        if (tooSlow && !sample.has(id)) this.noteSkip("tooSlow", `Codeunit${id}`, false);
        if (sample.has(id) || tooSlow) {
          const shot = await this.oneShotBaselineAnswer(lane, id, stopSeconds, coverage);
          if (shot === undefined) {
            if (!sample.has(id)) continue; // too slow, no clean one-shot: its own call runs it
            // Out of time or memory is not a mismatch.
            if (this.stopHandle?.spent() === true || this.memoryStopped) break;
            this.dropDaemonBaseline(
              `the cross-check of codeunit ${id} got no clean one-shot answer to compare the daemon's with`,
            );
            return;
          }
          if (this.stopHandle?.signalled() === true) break;
          if (sample.has(id)) {
            this.baselineStats.compared += 1;
            const why = compareBaselineAnswers(got, shot);
            if (why.length > 0) {
              this.dropDaemonBaseline(
                `the daemon's baseline of codeunit ${id} differs from a fresh process's (${why.slice(0, 3).join("; ")}${why.length > 3 ? `; and ${why.length - 3} more` : ""})`,
                why,
              );
              return;
            }
          }
          got = shot; // a fresh process's answer, and its durations, stand
        }
        answers.set(id, got);
      }
      for (const [k, v] of answers) this.daemonBaseline.set(k, v);
    } finally {
      // The test-mode daemon is not needed again; the per-test baseline starts its own.
      await this.closeLane(lane, "baseline-end");
    }
  }

  /**
   * R948 (B): R896 `method` codeunits, and `--isolate-tests`, as per-test requests to ONE
   * codeunit-isolation daemon (`testIsolation: "codeunit"` + `runSelectedOnly`), not one process per
   * test. Acceptance is `aloneAnswer`'s: exactly one row, that test's, and it ran. Any other answer,
   * a request error, and a test slow enough that a warm duration could move a budget are left
   * unanswered: that test's own call runs it alone one-shot, as before.
   */
  private async fillIsolatedViaDaemon(
    lane: Lane,
    queue: readonly TestMethodRef[],
    stopSeconds: number,
    coverage: boolean,
  ): Promise<void> {
    const f = this.budgetFloor;
    if (f === undefined) return;
    // The refs this fill answers, in queue order; the sample is by position in that order.
    const refs = queue.filter((ref) => this.isolated(this.callId(ref)) !== undefined);
    const sample = new Set(baselineSampleIds(refs.map((_, i) => i)));
    this.baselineStats.perTestRequests = refs.length;
    this.baselineStats.perTestSampled = [...sample];
    const answers = new Map<number, BaselineAnswer>();
    try {
      for (const [i, ref] of refs.entries()) {
        const key = this.callId(ref);
        // The mode is the call's own (`modeOfCall`): codeunit isolation under `method`, test
        // isolation under `--isolate-tests`; both with `runSelectedOnly`.
        const mode = this.modeOfCall(key);
        if (this.stopHandle?.spent() === true) break; // R955
        if (!(await this.memoryGate(true))) break; // R948
        let got: BaselineAnswer | undefined;
        try {
          await this.checkBound(lane); // R652 (inside the try: a throw still releases the hold)
          got = await this.baselineRequest(lane, mode, key, stopSeconds, coverage);
        } catch (err) {
          if (!(err instanceof AlRunnerServerRequestError)) throw err;
          this.noteSkip("error", `${ref.codeunitName}.${ref.method}`, sample.has(i));
          continue;
        } finally {
          this.memoryRelease();
        }
        if (this.stopHandle?.signalled() === true) break; // R955: that call is dropped
        const [row] = got?.rows ?? [];
        const name = `${ref.codeunitName}.${ref.method}`;
        if (
          got === undefined ||
          got.rows.length !== 1 ||
          row === undefined ||
          row.notRun ||
          row.method.toLowerCase() !== ref.method.toLowerCase()
        ) {
          this.noteSkip("other", name, sample.has(i));
          continue;
        }
        if (durationCouldMoveBudget([row], got.wallMs, f.floorMs)) {
          this.noteSkip("tooSlow", name, sample.has(i));
          continue;
        }
        const one = this.isolated(key);
        if (sample.has(i) && one !== undefined) {
          // The cross-check: this test alone in a fresh process, compared per test.
          const shot = await this.oneShotBaselineAnswer(
            lane,
            ref.codeunitId,
            stopSeconds,
            coverage,
            {
              ref,
              test: one.test,
            },
          );
          if (shot === undefined) {
            if (this.stopHandle?.spent() === true || this.memoryStopped) break;
            this.dropDaemonBaseline(
              `the cross-check of ${ref.codeunitName}.${ref.method} got no clean one-shot answer to compare the daemon's with`,
            );
            return;
          }
          if (this.stopHandle?.signalled() === true) break;
          this.baselineStats.compared += 1;
          const why = compareBaselineAnswers(got, shot);
          if (why.length > 0) {
            this.dropDaemonBaseline(
              `the daemon's per-test baseline of ${ref.codeunitName}.${ref.method} differs from a fresh process's (${why.slice(0, 3).join("; ")}${why.length > 3 ? `; and ${why.length - 3} more` : ""})`,
              why,
            );
            return;
          }
          got = shot;
        }
        answers.set(key, got);
      }
      for (const [k, v] of answers) this.daemonBaseline.set(k, v);
    } finally {
      await this.closeLane(lane, "baseline-end");
    }
  }

  /** R948: the answer the daemon baseline holds for this baseline call, taken once, if it matches. */
  private async takeDaemonBaseline(
    lane: Lane,
    key: number,
    perTest: boolean,
    stopSeconds: number,
    coverage: boolean,
  ): Promise<BaselineAnswer | undefined> {
    if (!this.inBaseline || lane.lastActivated !== null || !this.daemonBaselineOn())
      return undefined;
    // Whole codeunits first, always: their fill and cross-check end before ANY daemon answer, a
    // per-test one included, is served (on batch 2+ under auto a `method` call can come first).
    // A drop there leaves nothing served and the session one-shot.
    await this.fillDaemonBaseline(lane, stopSeconds, coverage);
    if (!this.daemonBaselineOn()) return undefined;
    if (perTest) {
      await this.fillIsolatedBaseline(lane, stopSeconds, coverage);
      if (!this.daemonBaselineOn()) return undefined;
    }
    const a = this.daemonBaseline.get(key);
    this.daemonBaseline.delete(key);
    if (a?.stopSeconds !== stopSeconds || a.withCoverage !== coverage) return undefined;
    if (a.fromDaemon === true) {
      this.baselineStats.served += 1;
      // R949: once per session, when the first daemon answer is used. No count here: later batches and
      // per-test fills are not known yet; the report's per-test `baselineFlaggedUnknown` is the record.
      if (!this.flaggedUnknownNoted) {
        this.flaggedUnknownNoted = true;
        this.notify(
          "al-runner-v3-serve-flagged-unknown",
          `[lethal] al-runner-v3-serve-flagged-unknown: the baseline came from an al-runner serve daemon, whose rows carry no "flagged" (a pass resting on an unprobed assumption), so every passing test the daemon answered has an UNKNOWN flagged state; the report marks each one baselineFlaggedUnknown, never unflagged. Upstream: https://github.com/aldevtools/BusinessCentral.AL.Runner/issues/7954 (R949).`,
        );
      }
    }
    return a;
  }

  /** R948: the guard's first line: the bound and where it came from, or why there is none. Once. */
  private announceMemoryGuard(): void {
    if (this.memoryGuard !== undefined) return;
    const headroom = this.cfg.memoryHeadroomGb;
    this.memoryGuard = "off";
    if (headroom === undefined) return; // no guard asked for (unit tests)
    if (headroom === 0) {
      this.notify(
        "al-runner-v3-memory-guard-off",
        '[lethal] al-runner-v3-memory-guard-off: "alRunnerV3.memoryHeadroomGb" is 0, so nothing stops this run before the container\'s memory limit (R948).',
      );
      return;
    }
    const read = this.seams.memoryReader ?? (() => readCgroupMemory());
    const s = read();
    if (s === undefined || s.maxBytes === undefined) {
      this.notify(
        "al-runner-v3-memory-guard-off",
        `[lethal] al-runner-v3-memory-guard-off: ${s === undefined ? "no cgroup v2 memory.current can be read here" : `${s.source} names no limit`}, so nothing stops this run before the container's memory limit (R948).`,
      );
      return;
    }
    const gib = (n: number) => (n / 2 ** 30).toFixed(1);
    const boundBytes = memoryBoundBytes(s.maxBytes, headroom);
    this.notify(
      "al-runner-v3-memory-guard",
      `[lethal] al-runner-v3-memory-guard: no new test call starts while the container uses more than ${gib(boundBytes)} GiB (${s.source} is ${gib(s.maxBytes)} GiB, less ${headroom} GiB headroom); it waits, then stops the run and writes its report (R948).`,
    );
    this.memoryGuard = { read, boundBytes, source: s.source };
  }

  /**
   * R948: `true` when a new call or request may start. Over the bound it re-reads (waiting
   * `MEMORY_POLL_MS` between reads, at most `MEMORY_WAIT_POLLS` times); if it never clears, the
   * session is stopped through the budget (`stopForMemory`, R955's path) and this and every later
   * gate answers `false`. Called only at call boundaries: never inside a request or a mutant group.
   */
  private memoryGate(hold = false): Promise<boolean> {
    // One caller at a time: callers that arrive together read and reserve in turn, so they cannot all
    // pass at "the bound less a little" (each started process or request is `memoryEstimate()` bytes
    // that the container's reading does not show yet).
    const turn = this.memoryChain.then(() => this.memoryGateOne(hold));
    this.memoryChain = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  }

  /** R948: what one started process or request is counted at until its caller releases it. */
  private memoryEstimate(): number {
    return this.seams.memoryEstimateBytes ?? MEMORY_CALL_ESTIMATE_BYTES;
  }

  /** R948: the caller of `memoryGate(true)` has finished its process or request: its reservation ends. */
  private memoryRelease(): void {
    if (this.memoryHeld > 0) this.memoryHeld -= 1;
  }

  /** R948: asked before the mutant loop activates a mutant: `false` = the guard stopped the session. */
  mayStartGroup(): Promise<boolean> {
    return this.memoryGate(false);
  }

  /** R948: true when this session's baseline comes from a serve daemon (see `ExecutionBackend.baselineDaemon`). */
  get baselineDaemon(): boolean {
    return this.cfg.daemonBaseline === true && this.entries;
  }

  /** R948: what the daemon baseline did, for the gate and the tests. */
  daemonBaselineReport(): {
    readonly dropped: string | undefined;
    /** Why it was dropped, per differing test and field (`failText`, `coverage`, ...), uncut. */
    readonly droppedDetail: readonly string[];
    readonly codeunits: number;
    readonly requests: number;
    readonly sampledCodeunits: readonly number[];
    readonly perTestRequests: number;
    readonly sampledPerTest: readonly number[];
    readonly compared: number;
    /** Answers a daemon gave that calls actually took (a fresh process's answer in its place is not counted). */
    readonly served: number;
    /** Names of answers not kept because 2 x duration >= floor (a warm duration could move a budget). */
    readonly skippedTooSlow: readonly string[];
    /** Names of answers lost to a serve request error or an unusable answer. */
    readonly skippedError: readonly string[];
    /** Names of per-test answers that were a refusal or not that test's row. */
    readonly skippedOther: readonly string[];
    /** Sampled items whose daemon answer was skipped (so `compared` is short by this many). */
    readonly sampledSkipped: readonly string[];
  } {
    const s = this.baselineStats;
    return {
      served: s.served,
      skippedTooSlow: [...s.skippedTooSlow],
      skippedError: [...s.skippedError],
      skippedOther: [...s.skippedOther],
      sampledSkipped: [...s.sampledSkipped],
      dropped: this.daemonBaselineOff,
      droppedDetail: [...this.daemonBaselineDetail],
      codeunits: s.codeunits,
      requests: s.requests,
      sampledCodeunits: s.sampled,
      perTestRequests: s.perTestRequests,
      sampledPerTest: s.perTestSampled,
      compared: s.compared,
    };
  }

  private async memoryGateOne(hold: boolean): Promise<boolean> {
    this.announceMemoryGuard();
    const g = this.memoryGuard;
    if (g === undefined || g === "off") return true;
    if (this.memoryStopped) return false;
    const polls = this.seams.memoryWaitPolls ?? MEMORY_WAIT_POLLS;
    const sleep =
      this.seams.memorySleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let used = 0;
    let closed = false;
    for (let i = 0; ; i += 1) {
      const s = g.read();
      if (s === undefined) return true; // unreadable now: the first read decided the guard is on, so this is not a stop
      used = s.usedBytes + this.memoryHeld * this.memoryEstimate();
      if (used <= g.boundBytes) {
        if (hold) this.memoryHeld += 1;
        return true;
      }
      if (i >= polls) break;
      if (!closed) {
        // Over the bound: the baseline's own daemon holds 2-3 GB and is not needed while waiting.
        closed = true;
        await this.closeBaselineDaemons();
      }
      await sleep(MEMORY_POLL_MS);
    }
    this.memoryStopped = true;
    const info = { usedBytes: used, boundBytes: g.boundBytes, source: g.source };
    this.notify(
      "al-runner-v3-memory-bound",
      `[lethal] al-runner-v3-memory-bound: the container uses ${(used / 2 ** 30).toFixed(1)} GiB, over the ${(g.boundBytes / 2 ** 30).toFixed(1)} GiB bound, and stayed there; no new test call starts and the run stops with its report (R948).`,
    );
    if (this.stopHandle === undefined) {
      throw new AlRunnerV3MemoryBoundError(info.usedBytes, info.boundBytes, info.source);
    }
    this.stopHandle.stopForMemory(info);
    return false;
  }

  /** R866: the answer `fillIsolatedBaseline` holds for this baseline call, taken once, if it matches. */
  private async takeIsolated(
    lane: Lane,
    key: number,
    stopSeconds: number,
    coverage: boolean,
  ): Promise<SpawnedCall | undefined> {
    if (!this.inBaseline || lane.lastActivated !== null) return undefined;
    await this.fillIsolatedBaseline(lane, stopSeconds, coverage);
    const c = this.isolatedBaseline.get(key);
    this.isolatedBaseline.delete(key);
    return c?.stopSeconds === stopSeconds && c.coverage === coverage ? c : undefined;
  }

  /** R790: a speculative baseline call for codeunit `id`, taken (once) when it matches this call. */
  private takeSpeculative(
    lane: Lane,
    id: number,
    stopSeconds: number,
    coverage: boolean,
  ): SpawnedCall | undefined {
    const s = this.speculative;
    if (s === undefined || !this.inBaseline || lane.lastActivated !== null) return undefined;
    if (lane.deployedDir !== s.dir) return undefined;
    const c = s.calls.get(id);
    if (c === undefined) return undefined;
    s.calls.delete(id);
    return c.stopSeconds === stopSeconds && c.coverage === coverage ? c : undefined;
  }

  /** R790: one v3 process for codeunit `id`; `beforeSpawn` is the last await before it starts. */
  private async spawnCodeunit(o: {
    readonly id: number;
    readonly stopSeconds: number;
    readonly coverageJson: string | undefined;
    readonly cwd: string;
    readonly activeDir: string;
    readonly testDir: string;
    readonly beforeSpawn?: () => Promise<void>;
    readonly signal?: AbortSignal;
    readonly onlyTest?: string;
    /** R907: a mutant is active for this call (`--skip-after-timeout` only then). Absent: none. */
    readonly mutantActive?: boolean;
  }): Promise<SpawnedCall | { readonly spawnError: string; readonly wallMs: number }> {
    const argv = v3CallArgv({
      alRunnerPath: absToolPath(this.cfg.alRunnerPath),
      codeunitId: o.id,
      ...(o.onlyTest !== undefined ? { onlyTest: o.onlyTest } : {}),
      // R890, R896: per codeunit, so every caller (`callCodeunit`, `speculateBaseline`,
      // `fillIsolatedBaseline`) sends the mode its codeunit is on.
      ...(this.isolationOf(o.id) === "method" ? { isolation: "codeunit" as const } : {}),
      stopSeconds: o.stopSeconds,
      packagesDir: resolve(this.cfg.packagesDir),
      bcVersion: this.cfg.bcVersion,
      noClient: this.noClient,
      environment: this.environmentChoice.value,
      ...(this.cfg.license !== undefined ? { license: this.cfg.license.path } : {}), // R956
      noDownload: this.noDownload(),
      // R907: only a call with a mutant active; a baseline Sleep test stopped at the limit would
      // otherwise leave its codeunit's later tests not run, counted refused at baseline.
      skipAfterTimeout: this.skipAfterTimeout && o.mutantActive === true,
      ...(this.sidecarPath !== undefined
        ? { dotnetSidecar: this.sidecarPath, dotnetAssemblyDirs: this.dotnetAssemblyDirs() }
        : {}),
      symbols: this.cfg.preprocessorSymbols ?? [],
      ...(o.coverageJson !== undefined ? { coverageJson: resolve(o.coverageJson) } : {}),
      activeDir: o.activeDir,
      testDir: o.testDir,
    });
    await o.beforeSpawn?.();
    // Review 5: an abort before the listener below exists would never reach the process.
    if (o.signal?.aborted === true) return { spawnError: "aborted before the spawn", wallMs: 0 };
    const deadlineMs = v3CallDeadlineMs(o.stopSeconds, this.testsPerCodeunit.get(o.id) ?? 1);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    o.signal?.addEventListener("abort", onAbort);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, deadlineMs);
    const started = Date.now();
    this.spawnCount += 1;
    this.transportFrozen = true; // R761
    try {
      const res = await this.spawn(argv, {
        signal: controller.signal,
        // R645: v3 writes coverage.cobertura.xml into its cwd; never the caller's.
        cwd: o.cwd,
        ...this.cacheEnv(),
      });
      this.watchTestDataOff(res.stdout, res.stderr); // R885
      return { res, wallMs: Date.now() - started, timedOut, deadlineMs };
    } catch (err) {
      return {
        spawnError: err instanceof Error ? err.message : String(err),
        wallMs: Date.now() - started,
      };
    } finally {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * R766 (b): lanes 1..N-1 read their own copy `active.<k>/` of the proved tree (timestamps kept, so
   * the "other files" proof sees the same mtimes). Each copy is checked once against the proof, by
   * `assertBound(lane)` (the .al hash, the other files, `app.json`, the selector, the resource file):
   * a copy that differs refuses by name. Every lane also gets its own cwd `daemon-<k>/`.
   */
  private async copyLanes(active: string): Promise<void> {
    if (!this.lanesBuilt) return;
    for (const l of this.laneList) {
      await mkdir(l.scratchCwd(), { recursive: true });
      if (l.index === 0) continue;
      const dir = l.activeDir();
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      await cp(active, dir, { recursive: true, preserveTimestamps: true });
      await this.seams.afterLaneCopy?.(dir);
      l.deployedDir = dir;
      l.realActive = await realpath(dir);
      try {
        await this.assertBound(l);
      } catch (err) {
        if (err instanceof AlRunnerV3UnprovenBatchError) {
          throw new AlRunnerV3UnprovenBatchError(
            `lane ${l.index}'s copy ${dir} is not the tree alc proved (${err.message})`,
          );
        }
        throw err;
      }
    }
  }

  /**
   * R766 (b): builds `n` lanes (2..8 is the caller's range; the cap is the orchestrator's) and returns
   * one view of the backend per lane, in lane order. Lane 0 is the backend's own lane. The views run
   * the per-mutant calls; the owner (this object) keeps deploy, the proof, the prefetch and `close`.
   * Called once, before the first `deploy()`: every deploy copies the proved tree into `active.<k>/`.
   */
  lanes(n: number): V3LaneView[] {
    if (this.lanesBuilt) throw new Error("al-runner-v3-lane-misuse: lanes(N) was already called");
    if (!Number.isInteger(n) || n < 2) {
      throw new Error(`al-runner-v3-lane-misuse: lanes(${n}): N must be an integer of 2 or more`);
    }
    // R515's re-budget (`measuredToday`) is per scope under lanes; it is off only while the in-run stop
    // is not the budget, which is true exactly in serve-entries.
    if (this.inRunStopIsBudget) {
      throw new Error(
        "al-runner-v3-lane-misuse: lanes(N) needs the serve-entries transport (inRunStopIsBudget must be false)",
      );
    }
    if (this.proof !== undefined) {
      throw new Error(
        "al-runner-v3-lane-misuse: lanes(N) must be called before the first deploy()",
      );
    }
    for (let k = 1; k < n; k++) this.laneList.push(this.makeLane(k));
    for (const l of this.laneList) {
      l.setScratchCwd(join(resolve(this.cfg.instrumentedDir), `daemon-${l.index}`));
    }
    this.lanesBuilt = true;
    return this.laneList.map((l) => this.laneView(l));
  }

  /**
   * R766 (b): the per-mutant face of one lane. Per-mutant calls act on the lane; the delegated getters
   * and capabilities read the shared backend; every owner-only method throws by name.
   */
  private laneView(lane: Lane): V3LaneView {
    const b = this;
    const no = (name: string) => (): never => b.ownerOnly(name);
    return {
      laneIndex: lane.index,
      killsMustReproduce: true,
      get inRunStopIsBudget(): boolean {
        return b.inRunStopIsBudget;
      },
      get inRunStopMs(): number | undefined {
        return b.inRunStopMs;
      },
      capabilities: () => b.capabilities(),
      dependencyPackageDirs: () => b.dependencyPackageDirs(),
      dependencyArtifactAppsDir: () => b.dependencyArtifactAppsDir(),
      latched: () => b.latched(),
      activate: (id) => b.activateOn(lane, id),
      mayStartGroup: () => b.mayStartGroup(), // R948: per activation, shared gate, one turn at a time
      run: (ref, opts) => b.runOn(lane, ref, opts),
      sendKillPair: (id, ref) => b.sendKillPairOn(lane, id, ref),
      useCoveringBudgets: (id, budgets) => b.useCoveringBudgetsOn(lane, id, budgets),
      survivorNote: (covering) => b.survivorNoteShared(covering),
      isolationOf: (cu) => b.isolationOf(cu), // R926: the mode is shared, so reach compares like with like
      deploy: no("deploy"),
      compileCheck: no("compileCheck"),
      compilePlainCheck: no("compilePlainCheck"),
      setNotify: no("setNotify"),
      decideTransport: no("decideTransport"),
      useDiscoveredTests: no("useDiscoveredTests"),
      useSessionTests: no("useSessionTests"),
      useMutantBudgetFloor: no("useMutantBudgetFloor"),
      useMutantStop: no("useMutantStop"),
      useBuildSymbols: no("useBuildSymbols"),
      baselinePhase: no("baselinePhase"),
      noteReusedBaseline: no("noteReusedBaseline"),
      chooseIsolation: no("chooseIsolation"),
      prefetchMutants: no("prefetchMutants"),
      status: no("status"),
      close: no("close"),
    };
  }

  /**
   * R766 (b): how many of `n` lanes to start. The largest k with k x 2.3 GB + 10 GB <= available, at
   * least 1 (lane 0's own floor is the per-lane hold's business). One notice names N asked, k started
   * and the available GB. The per-lane hold (`laneMayStart`) still applies to each lane.
   */
  affordableLanes(n: number): number {
    const avail = (this.seams.availableBytes ?? freemem)();
    let k = n;
    while (k > 1 && k * LANE_RSS_BYTES + LANE_MIN_AVAILABLE_BYTES > avail) k -= 1;
    if (k < n && !this.fitNoticed) {
      this.fitNoticed = true;
      this.notify(
        "al-runner-v3-lane-memory-fit",
        `[lethal] al-runner-v3-lane-memory-fit: ${(avail / 2 ** 30).toFixed(1)} GB available; ${n} lanes asked, ${k} started (each lane needs ${(LANE_RSS_BYTES / 2 ** 30).toFixed(1)} GB, and ${LANE_MIN_AVAILABLE_BYTES / 2 ** 30} GB must stay free) (R766).`,
      );
    }
    return k;
  }

  /** R785: lane 0's LATEST single daemon start plus warm-up request, in ms; 0 until it ran. */
  laneWarmupMs(): number {
    return this.lane.lastWarmupMs;
  }

  /** R785: lane 0's daemon starts so far; a change during a unit means the unit carried a warm-up. */
  laneDaemonStarts(): number {
    return this.lane.daemonStarts;
  }

  /** R785: false when the shared prefetch already holds this mutant's answer (about 0 ms of live work). */
  needsLiveCall(mutantId: string): boolean {
    return !this.prefetched.has(mutantId);
  }

  /** R785: the one-line notice of how many lanes started. */
  noteLanes(message: string): void {
    this.notify(
      "al-runner-v3-lanes-started",
      `[lethal] al-runner-v3-lanes-started: ${message} (R785).`,
    );
  }

  /**
   * R766 (b): the memory hold. A lane beyond lane 0 may start only while at least 10 GB is available;
   * under that the caller stays at the lanes it has, and one notice says so. `os.freemem()` is the
   * kernel's available figure on Linux (libuv reads MemAvailable).
   */
  laneMayStart(k: number): boolean {
    if (k === 0) return true;
    const avail = (this.seams.availableBytes ?? freemem)();
    if (avail >= LANE_MIN_AVAILABLE_BYTES) return true;
    if (!this.memoryHoldNoticed) {
      this.memoryHoldNoticed = true;
      this.notify(
        "al-runner-v3-lane-memory-hold",
        `[lethal] al-runner-v3-lane-memory-hold: ${(avail / 2 ** 30).toFixed(1)} GB available, under the ${LANE_MIN_AVAILABLE_BYTES / 2 ** 30} GB needed to start lane ${k}; this session stays at the lanes already running (R766).`,
      );
    }
    return false;
  }

  /**
   * R766 (b): why `--workers > 1` is refused on this backend now, or `undefined` when it may run in
   * parallel. Asked after `decideTransport`.
   */
  parallelRefusal(): string | undefined {
    if (this.resumeSession) {
      return "al-runner-v3-workers-refused: --workers > 1 is refused with --resume / --resume-run: a reused baseline has no rows for the lanes' serve warm-up (R766)";
    }
    if (!this.entries) {
      return 'al-runner-v3-workers-refused: --workers > 1 needs the serve-entries transport; this session runs one-shot (set "alRunnerV3.transport" to "serve-entries", or see the al-runner-v3-serve-default-fallback warning for why the default fell back) (R766)';
    }
    if (!this.sleepRuleRetiredForParallel()) {
      return "al-runner-v3-workers-refused: parallel v3 needs a build whose pin retires the §6 Sleep rule (R766, R768)";
    }
    return undefined;
  }

  /**
   * R766 (b): true when the running build's pin and the session probe say the §6 Sleep rule is retired,
   * so `run()` never opens a coverage window: R768's `sleepRuleRetired`, set by `status()`. A NEW
   * al-runner build needs its own pin before `--workers > 1` is allowed on it.
   */
  sleepRuleRetiredForParallel(): boolean {
    return this.seams.sleepRuleRetired ?? this.sleepRuleRetired;
  }

  /** R766 (b): the first latch of this batch and the mutant behind it, or `undefined`. */
  latched(): { readonly mutantId: string; readonly why: string } | undefined {
    return this.latchBy;
  }

  private noteLatch(lane: Lane, why: string): void {
    this.latchBy ??= { mutantId: lane.lastMutant ?? "<baseline>", why };
  }

  /**
   * R780: one read of the test dir. R631: it is a USER root: a link refuses rather than hashing a
   * partial tree. R608: the non-.al files of the same two folders (resources, `.alpackages`).
   */
  private async readTestDir(): Promise<TestDirRead> {
    const testScan = await scanTestDir(this.cfg.testDir);
    const testOther = await listOtherFiles(this.cfg.testDir, OTHER_FILES_UNBOUND, true);
    const bytes = await readFile(join(this.cfg.testDir, "app.json"));
    return {
      testScan,
      testOther,
      testAppJsonSha256: sha256Of(new Uint8Array(bytes)),
      testAppJsonText: bytes.toString("utf8"),
    };
  }

  private proofStore(): TestAppProofStore | undefined {
    return this.cfg.cacheDir === undefined
      ? undefined
      : new TestAppProofStore(join(resolve(this.cfg.cacheDir), "testapp-proof"));
  }

  /**
   * §3 step 2. A failure stops the session: the test app does not compile against this batch.
   * R780: with a `cacheDir`, a compile that alc already passed for the same key (see
   * `testAppCacheKey`) is skipped (`live: false`, sha256 `cached:<key>`, informational). A live,
   * passing compile returns its `key` for the CALLER to store, once it has re-read the test dir
   * and found it unchanged. A failure is never cached. No `cacheDir`: no caching at all.
   */
  private async compileTestAppAgainst(
    batchApp: string,
    active: string,
    snap: TestDirRead | undefined,
  ): Promise<{ sha256: string; live: boolean; key: string | undefined; copied: boolean }> {
    const activeAppJsonText = await readFile(join(active, "app.json"), "utf8");
    const activeApp = JSON.parse(activeAppJsonText) as Record<string, unknown>;
    const targetId = String(activeApp.id ?? "").toLowerCase();
    if (targetId === "") throw new Error(`al-runner-v3: ${active}/app.json has no id`);
    const usedDeps: { name: string; sha256: string }[] = [];
    const staged = join(this.cfg.instrumentedDir, "alc-test-pkgs");
    const copy = join(this.cfg.instrumentedDir, "alc-test-src");
    await rm(staged, { recursive: true, force: true });
    await rm(copy, { recursive: true, force: true });
    await mkdir(staged, { recursive: true });
    try {
      for (const name of await readdir(this.cfg.packagesDir)) {
        if (!name.toLowerCase().endsWith(".app")) continue;
        const bytes = await readFile(join(this.cfg.packagesDir, name));
        // An entry we cannot identify could be a stale target: refused, never skipped.
        let id: string;
        try {
          id = symbolPackageId(bytes).toLowerCase();
        } catch (err) {
          throw new TestAppError(
            "symbols-unreadable",
            `${join(this.cfg.packagesDir, name)}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (id === targetId) continue;
        usedDeps.push({ name, sha256: sha256Of(bytes) });
        await writeFile(join(staged, name), bytes);
      }
      const batchBytes = await readFile(batchApp);
      await writeFile(join(staged, "lethal-v3-batch.app"), batchBytes);
      // No snapshot (the test dir could not be read before the compile): no key, alc runs live.
      const key =
        snap === undefined
          ? undefined
          : await this.testAppKey(snap, activeAppJsonText, batchBytes, usedDeps);
      // R811: before the cache check, so a run that hits still warns, as R422 does.
      const pathChanges =
        snap === undefined
          ? []
          : testAppPathRewrite(snap.testAppJsonText, this.cfg.testDir).changes;
      if (pathChanges.length > 0 && !this.testPathsWarned) {
        this.testPathsWarned = true;
        this.notify("app-json-backslash-path", `[lethal] ${testAppPathWarning(pathChanges)}`);
      }
      const store = this.proofStore();
      const mintedOk =
        snap !== undefined &&
        mintedVersionSatisfiesTestApp(
          snap.testAppJsonText,
          {
            id: targetId,
            name: String(activeApp.name ?? ""),
            publisher: String(activeApp.publisher ?? ""),
          },
          String(activeApp.version ?? ""),
        );
      if (store !== undefined && key !== undefined && mintedOk && (await store.has(key))) {
        this.testAppCache.hits++;
        return { sha256: `cached:${key}`, live: false, key: undefined, copied: false };
      }
      this.testAppCache.misses++;
      // R811: alc reads a copy only when app.json names a path with `\`. No snapshot: in place, as above.
      const { projectDir } =
        snap === undefined
          ? { projectDir: this.cfg.testDir }
          : await stageTestProject(this.cfg.testDir, snap.testAppJsonText, copy);
      let out: { appPath: string; sha256: string };
      try {
        out = await this.compiler.compileProject({
          projectDir,
          packageCachePath: staged,
          name: "v3-testapp",
        });
      } catch (err) {
        if (err instanceof AlcCompileError) {
          throw new TestAppError(
            "compile-failed",
            `al-runner-v3: the test app does not compile against this batch, so no test of it can be trusted (R586 §3 step 2): ${err.message}`,
          );
        }
        throw err;
      }
      await rm(out.appPath, { force: true }).catch(() => {});
      // Only a PASSING compile reaches here; the caller stores the key (see above).
      return {
        sha256: out.sha256,
        live: true,
        key: store === undefined ? undefined : key,
        copied: projectDir !== this.cfg.testDir,
      };
    } finally {
      await rm(staged, { recursive: true, force: true }).catch(() => {});
      await rm(copy, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** R780: the key, or `undefined` when any part cannot be read (then nothing is cached or hit). */
  private async testAppKey(
    snap: TestDirRead,
    activeAppJsonText: string,
    targetApp: Buffer,
    deps: readonly { name: string; sha256: string }[],
  ): Promise<string | undefined> {
    const activeAppJson = appJsonForKey(activeAppJsonText);
    const symbolInterface = symbolInterfaceForKey(targetApp, !snap.testScan.hasExtensionObject);
    const alcSha = await alcSha256(this.cfg.alcPath);
    if (activeAppJson === undefined || symbolInterface === undefined || alcSha === undefined) {
      return undefined;
    }
    return testAppCacheKey({
      testDirHash: snap.testScan.hash,
      testOtherSha: new Map([...snap.testOther].map(([rel, f]) => [rel, f.sha256])),
      testAppJsonSha256: snap.testAppJsonSha256,
      activeAppJson,
      symbolInterface,
      testHasExtensionObject: snap.testScan.hasExtensionObject,
      deps,
      alcPath: this.cfg.alcPath,
      alcSha256: alcSha,
      preprocessorSymbols: this.cfg.preprocessorSymbols ?? [],
      ...(this.cfg.assemblyProbingPaths !== undefined
        ? { assemblyProbingPaths: this.cfg.assemblyProbingPaths }
        : {}),
      transport: this.entries ? "serve-entries" : "one-shot",
    });
  }

  /** R780: how many deploys skipped the test-app compile (`hits`) and how many ran it live. */
  testAppCacheStats(): Readonly<{ hits: number; misses: number }> {
    return { ...this.testAppCache };
  }

  /** §3 step 4: alc alone on a copy of `dir` (bisection's question). Never starts v3. */
  async compileCheck(instrumentedDir: string): Promise<void> {
    this.dropPair();
    const dir = join(this.cfg.instrumentedDir, "compile-check");
    try {
      await this.stage(instrumentedDir, dir);
      const out = await this.compileTarget(dir);
      await rm(out.appPath, { force: true }).catch(() => {});
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** §3 step 5 (R461): alc on the plain copy of the target. */
  async compilePlainCheck(dir: string): Promise<void> {
    this.dropPair();
    const out = await this.compileTarget(dir);
    await rm(out.appPath, { force: true }).catch(() => {});
  }

  async activate(mutantId: string | null): Promise<void> {
    return this.activateOn(this.soleLane("activate"), mutantId);
  }

  private async activateOn(lane: Lane, mutantId: string | null): Promise<void> {
    // R948: the memory guard is asked BEFORE this call, by the mutant loop (`mayStartGroup`): a
    // group the guard stopped is never activated, so nothing here waits or stops.
    // C2: the rows describe the selector as it was; dropped BEFORE the write.
    lane.rowsByCodeunit = new Map();
    lane.aloneAfterStop = new Map();
    // R653: the pair is taken out here; only the expected next activation puts anything back.
    const pair = lane.pair;
    lane.dropPair();
    const proof = this.proof;
    const dir = lane.deployedDir;
    if (proof === undefined || dir === undefined) {
      throw new Error("al-runner-v3: activate() before a successful deploy()");
    }
    if (mutantId !== null && !proof.manifestIds.has(mutantId)) {
      throw new Error(
        `al-runner-v3: activate(${mutantId}): not a mutant of the deployed batch's manifest`,
      );
    }
    if (this.entries) {
      // R635 §4: the selector never changes; a prefetched answer is MOVED here, consumed once,
      // so a re-activation (R577's reproduction) runs live.
      if (mutantId !== null && this.inBaseline) {
        throw new Error(
          `al-runner-v3: activate(${mutantId}) inside the baseline phase; the baseline runs no mutant (R635 §4)`,
        );
      }
      const pre = mutantId === null ? undefined : this.prefetched.get(mutantId);
      if (mutantId !== null && pre !== undefined) {
        this.prefetched.delete(mutantId);
        lane.rowsByCodeunit = pre;
      }
      if (mutantId !== null) lane.lastMutant = mutantId;
      if (pair?.next === "null" && mutantId === null) {
        // The kill's confirm: its rows, or the verdict its server error maps to.
        if (pair.none !== undefined) lane.rowsByCodeunit.set(this.callId(pair.ref), pair.none);
        else if (pair.noneVerdict !== undefined) lane.pairVerdict = pair.noneVerdict;
        lane.pair = { ...pair, next: "mutant" };
      } else if (pair?.next === "mutant" && mutantId === pair.mutantId) {
        // The reproduction, asked for only after the confirm passed (R577).
        this.stats.pairRequests += 1;
        if (pair.fallback === 1) this.stats.pairFallbacks1Passed += 1;
        if (pair.fallback === 2) this.stats.pairFallbacks2Passed += 1;
        if (pair.m !== undefined) lane.rowsByCodeunit.set(this.callId(pair.ref), pair.m);
      }
      lane.lastActivated = mutantId;
      return;
    }
    // The plan is NOT dropped here: keyed by mutant id and read only while that mutant is active,
    // so the R577 reproduction (after the unmutated confirm) runs at the killing call's stop.
    if (mutantId !== null) lane.lastMutant = mutantId;
    await writeFile(
      join(dir, CONTROL_SELECTOR_FILENAME),
      this.selectorText(proof.artifactId, mutantId),
      "utf8",
    );
    lane.lastActivated = mutantId;
  }

  /**
   * R652: §3 step 3 immediately before each SEND (`send`, `callCodeunit`'s spawn, a §5 window), never
   * on a `run()` served from memory: every row comes from a send that was checked just before it
   * left. A change in the gap between that check and al-runner's read cannot make a kill, because
   * R577 (`killsMustReproduce`) sends every kill's confirm and reproduction fresh, after the kill's
   * own send; R653 sends the two in ONE checked request (`sendKillPair`), confirm first. Turning
   * R577 off for v3 would reopen the gap. A lasting change in the LAST send's gap (now the pair)
   * goes unreported (build review L1). R651's timer outside the bracket.
   */
  private async checkBound(lane: Lane): Promise<void> {
    if (this.inBaseline) return this.assertBound(lane);
    this.stats.boundChecks += 1;
    await lane.timed("boundMs", () => this.assertBound(lane));
  }

  /** §3 step 3: the bytes v3 will read (the lane's dir and the test dir) are the bytes alc proved. */
  private async assertBound(lane: Lane): Promise<void> {
    const proof = this.proof;
    const dir = lane.deployedDir;
    if (proof === undefined || dir === undefined) {
      throw new AlRunnerV3UnprovenBatchError("no batch was deployed and proved");
    }
    // R655: a link that appears in active/ mid-run is drift, as in the test dir (R631).
    const activeHashNow = await linkIsUnproven(hashAlTree(dir), `${dir} after the alc proof`);
    if (activeHashNow !== proof.activeHashExceptSelector) {
      throw new AlRunnerV3UnprovenBatchError(`an .al file in ${dir} changed after the alc proof`);
    }
    const activeOtherDrift = await linkIsUnproven(
      otherFilesDrift(dir, OTHER_FILES_UNBOUND, proof.activeOther).then((d) => d ?? ""),
      `${dir} after the alc proof`,
    );
    if (activeOtherDrift !== "") {
      throw new AlRunnerV3UnprovenBatchError(
        `a non-.al file in ${dir} changed after the alc proof (${activeOtherDrift})`,
      );
    }
    if ((await fileSha256(join(dir, "app.json"))) !== proof.activeAppJsonSha256) {
      throw new AlRunnerV3UnprovenBatchError(`${dir}/app.json changed after the alc proof`);
    }
    const id = lane.lastActivated;
    if (id !== null && !proof.manifestIds.has(id)) {
      throw new AlRunnerV3UnprovenBatchError(`the last activated id ${id} is not in the manifest`);
    }
    const selector = await readFile(join(dir, CONTROL_SELECTOR_FILENAME), "utf8");
    if (this.entries) {
      // R635 §2: the resource selector as emitted; the file NONE outside §5's window. The echo
      // needs no check of its own: it is an .al file of the tree the proof hashed (above).
      const want = emitResourceSelector({
        objectId: this.cfg.selectorObjectId,
        artifactId: proof.artifactId,
        targetAppId: "",
      });
      if (selector !== want) {
        throw new AlRunnerV3UnprovenBatchError(
          "the selector is not the resource selector for this artifact",
        );
      }
      const onDisk = await readFile(lane.resourcePath(), "utf8").catch(() => "<missing>");
      if (!this.inWindow && onDisk !== SELECTOR_RESOURCE_NONE) {
        throw new AlRunnerV3UnprovenBatchError(
          `${SELECTOR_RESOURCE_NAME} holds ${JSON.stringify(onDisk.slice(0, 40))}, not ${SELECTOR_RESOURCE_NONE}, outside the coverage window`,
        );
      }
    } else if (selector !== this.selectorText(proof.artifactId, id)) {
      throw new AlRunnerV3UnprovenBatchError(
        `the selector is not the static selector for the last activated id (${id ?? "baseline"})`,
      );
    }
    // R631: a link that appears in the test dir mid-run is drift like any other change.
    const testDirHashNow = await linkIsUnproven(
      hashTestDir(this.cfg.testDir),
      "the test dir after the alc proof",
    );
    if (testDirHashNow !== proof.testDirHash) {
      throw new AlRunnerV3UnprovenBatchError(
        "an .al file in the test dir changed after the alc proof",
      );
    }
    const testOtherDrift = await linkIsUnproven(
      otherFilesDrift(this.cfg.testDir, OTHER_FILES_UNBOUND, proof.testOther).then((d) => d ?? ""),
      "the test dir after the alc proof",
    );
    if (testOtherDrift !== "") {
      throw new AlRunnerV3UnprovenBatchError(
        `a non-.al file in ${this.cfg.testDir} changed after the alc proof (${testOtherDrift})`,
      );
    }
    if ((await fileSha256(join(this.cfg.testDir, "app.json"))) !== proof.testAppJsonSha256) {
      throw new AlRunnerV3UnprovenBatchError("the test app's app.json changed after the alc proof");
    }
    const now = await listDeps(this.cfg.packagesDir, false);
    if (now.map((e) => e.name).join("\n") !== proof.deps.map((e) => e.name).join("\n")) {
      throw new AlRunnerV3UnprovenBatchError(
        `the file list of ${this.cfg.packagesDir} changed after the alc proof`,
      );
    }
    for (const [i, e] of now.entries()) {
      const was = proof.deps[i];
      if (was === undefined) continue;
      if (e.size === was.size && e.mtimeMs === was.mtimeMs) continue;
      if ((await fileSha256(join(this.cfg.packagesDir, e.name))) !== was.sha256) {
        throw new AlRunnerV3UnprovenBatchError(
          `${this.cfg.packagesDir}/${e.name} changed after the alc proof`,
        );
      }
    }
  }

  async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
    return this.runOn(this.soleLane("run"), ref, opts);
  }

  private async runOn(lane: Lane, ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
    // R652: no bound check here; each send checks (`checkBound`).
    if (this.proof === undefined || lane.deployedDir === undefined) {
      throw new AlRunnerV3UnprovenBatchError("no batch was deployed and proved");
    }
    // R653: only the pair's own confirm (after its activate(null)) keeps the pair for the
    // reproduction; any other run drops it. A stored confirm verdict is returned once.
    const pair = lane.pair;
    if (!(pair?.next === "mutant" && refKey(pair.ref) === refKey(ref))) lane.dropPair();
    const served = lane.pairVerdict;
    if (served !== undefined) {
      lane.pairVerdict = undefined;
      return { ...served, ref };
    }
    let call = lane.rowsByCodeunit.get(this.callId(ref));
    if (call?.noCoverage === true && opts.coverage !== "none") call = undefined;
    if (call === undefined) {
      // R635 §4: outside the bracket, serve-entries sends a LIVE one-group request.
      const made =
        this.entries && !this.inBaseline
          ? await this.liveCall(lane, ref)
          : await this.callCodeunit(lane, ref, opts.timeoutMs, opts.coverage !== "none");
      if ("verdict" in made) return made.verdict;
      call = made.call;
    }
    // R764: a call made without coverage must never serve a caller who wants it (its coverage
    // would read as undefined, so mutants would read no-coverage). Fail loudly.
    if (call.noCoverage === true && opts.coverage !== "none") {
      throw new AlRunnerV3NoCoverageCallReusedError(ref);
    }
    // R895: a call cut at a timeout row has rows only up to that test. A ref it has no row for is
    // run ALONE under the same mutant; its answer stands for the ref (it is not stored as the
    // codeunit's call). A ref it does have a row for reads that row, as ever.
    let alone = false;
    if (
      call.cutAtTimeout !== undefined &&
      call.refusal === undefined &&
      call.missing === undefined &&
      !call.rows.some(
        (r) => r.codeunit === ref.codeunitId && r.method.toLowerCase() === ref.method.toLowerCase(),
      )
    ) {
      const made = await this.aloneCall(lane, ref);
      if ("verdict" in made) return made.verdict;
      call = made.call;
      alone = true;
    }
    /**
     * R897, R-907: as serve's cut runs a cut codeunit's remaining covering tests alone. A one-shot
     * mutant call carried `--skip-after-timeout`, and an earlier test stopped at the limit left
     * this ref not run. Run it ALONE under the same mutant and limit, without the flag, once per
     * (mutant, ref); that answer stands for the ref.
     */
    if (
      !alone &&
      this.skipAfterTimeout &&
      !this.isBaselineCall(lane) &&
      call.refusal === undefined &&
      call.missing === undefined
    ) {
      const idx = call.rows.findIndex(
        (r) => r.codeunit === ref.codeunitId && r.method.toLowerCase() === ref.method.toLowerCase(),
      );
      const mine = call.rows[idx];
      const first = call.rows.findIndex((r) => r.notRun);
      const stop = call.rows[first];
      if (
        mine?.notRun &&
        stop !== undefined &&
        first < idx &&
        V3_TIMEOUT_MESSAGE.test(stop.message ?? "")
      ) {
        let cached = lane.aloneAfterStop.get(refKey(ref));
        if (cached === undefined) {
          const made = await this.callCodeunit(
            lane,
            ref,
            opts.timeoutMs,
            opts.coverage !== "none",
            `Codeunit${ref.codeunitId}.${ref.method}`,
          );
          if ("verdict" in made) return made.verdict;
          cached = made.call;
          lane.aloneAfterStop.set(refKey(ref), cached);
        }
        call = cached;
        alone = true;
      }
    }
    if (call.refusal !== undefined) return refusalVerdict(ref, call.refusal, call.wallMs);
    if (call.missing !== undefined) return this.rowMissing(lane, ref, call.missing, call.wallMs);
    const mine = call.rows.filter(
      (r) => r.codeunit === ref.codeunitId && r.method.toLowerCase() === ref.method.toLowerCase(),
    );
    const row = mine[0];
    if (row === undefined || mine.length !== 1) {
      // Cached only when every suite test of the codeunit had one row, so this is a ref outside
      // the suite: never a verdict.
      return this.rowMissing(
        lane,
        ref,
        `${mine.length} row(s) for ${ref.codeunitName}.${ref.method}`,
        call.wallMs,
      );
    }
    // R609: a test v3 REFUSED mid-run (notRun, not a timeout) also has a per-test entry: the code it
    // reached before the refusal. Recorded so a mutant only it reaches reads as v3's refusal, not a
    // suite gap. A refusal before the test starts has no entry: no coverage, never the §6 throw.
    const refusedMidRun =
      row.notRun &&
      row.status === "error" &&
      !(row.message !== undefined && V3_TIMEOUT_MESSAGE.test(row.message));
    let coverage =
      (row.status === "pass" && !row.notRun) || refusedMidRun
        ? this.isBaselineCall(lane) && call.noCoverage !== true
          ? this.coverageOf(lane, row.name, call.coverage)
          : undefined
        : undefined;
    if (refusedMidRun && coverage === "unavailable") coverage = undefined;
    if (coverage === "unavailable") {
      // A contract failure on an unmutated call: never read as "covered nothing" (which would
      // make its mutants no-coverage), so the session stops.
      throw new Error(
        `al-runner-v3: coverage is on and v3's --coverage-json gave no per-test coverage for ${row.name} (${call.coverage.kind === "unavailable" ? call.coverage.why : "no single per-test entry"}); refusing rather than reading it as "covered nothing" (R586 §6)`,
      );
    }
    const verdict = v3RowVerdict(ref, row, call.stopSeconds, call.wallMs, coverage, call.callId);
    if (lane.lastActivated === null) return verdict;
    // R586c (B2): alpha.5 counts a Sleep toward --test-timeout-secs on a VIRTUAL clock, so a test it
    // "stopped at 3 s" returned after a few ms. A genuine CPU stop has a wall time of at least the
    // stop (n x 1000 ms). Under a mutant, an earlier one is not a real timeout and must not kill:
    // error, never scored. Here (mutant active), not in `v3RowVerdict`: baselines keep reading such
    // a row as a timeout (X (d)'s 600 s Sleep siblings, R678's baseline symmetry).
    if (
      verdict.outcome === "timeout" &&
      typeof row.durationMs === "number" &&
      row.durationMs < (verdict.reportedStopMs ?? 0)
    )
      return {
        ref,
        outcome: "error",
        durationMs: call.wallMs,
        ...(verdict.measuredDurationMs !== undefined
          ? { measuredDurationMs: verdict.measuredDurationMs }
          : {}),
        ...(verdict.callId !== undefined ? { callId: verdict.callId } : {}),
        failureMessage: `${row.message ?? ""} [al-runner v3: stopped on v3's virtual clock; BC's real wait unknown; never scored]`,
        operation: "completed-accepted",
        runnerRow: "runner-refused",
      };
    // R-435 (upstream #5776): v3 marks a later FAILURE after an unfinished test as not trusted, but
    // not a later TIMEOUT. A timeout after a row that was refused or stopped (or holds the refusal
    // marker) may come from that row's partial state. Outside entries mode a call runs the whole
    // codeunit, so the cold confirm runs the sequence unmutated (the refused row leaves the same
    // state but the test passes) and R577's re-run repeats it: neither tells the refusal's state
    // from the mutant. Never `runner-refused`: R639 must not go on past it.
    if (verdict.outcome === "timeout") {
      const earlier = call.rows
        .slice(0, call.rows.indexOf(row))
        .filter((r) => r.notRun || isV3RefusalText(r.message));
      if (earlier.length > 0)
        return {
          ref,
          outcome: "error",
          durationMs: call.wallMs,
          ...(verdict.measuredDurationMs !== undefined
            ? { measuredDurationMs: verdict.measuredDurationMs }
            : {}),
          ...(verdict.callId !== undefined ? { callId: verdict.callId } : {}),
          failureMessage: `${row.message ?? ""} [al-runner v3: a timeout after ${earlier.map((r) => r.method).join(", ")} refused or stopped earlier in the same call is not trusted; never scored (R-435)]`,
          operation: "completed-accepted",
          runnerRow: "runner-test-error",
        };
    }
    // R639: v3's refusal that follows a timeout, where that timeout is the call's FIRST not-run row.
    // The refused row's cause is the stop's cascade, so the covering loop may go on to the next
    // test (the row it asks for is the row it would get were that test first in the order). A
    // refusal after an earlier non-timeout refusal is not flagged: that partial state is unknown.
    if (verdict.runnerRow === "runner-refused" && row.notRun) {
      const first = call.rows.findIndex((r) => r.notRun);
      const stop = call.rows[first];
      if (
        stop !== undefined &&
        first < call.rows.indexOf(row) &&
        V3_TIMEOUT_MESSAGE.test(stop.message ?? "")
      )
        return { ...verdict, refusedAfterStop: stop.method };
    }
    // A covering pass under a mutant: §6.
    // §6 on RAW lines whatever the session's coverage mode (none, or refused for a multi-object
    // or wrapped file): every call requested --coverage-json (`v3CallArgv`).
    if (verdict.outcome === "pass") {
      // R-762 B: on a pinned-gone build a Sleep costs its real (virtual) time, so a covering pass
      // is a pass; no join, no window, no second echo. B2's virtual-clock guard above stays.
      if (this.sleepRuleRetired) return verdict;
      const index = this.sleepIndex;
      if (index === undefined)
        throw new Error("al-runner-v3: no Sleep index for the deployed batch");
      if (this.entries) {
        // R635 §5: an entry carries no coverage. An empty index has nothing to find; otherwise
        // the window gives this (mutant, codeunit) a coverage read, once.
        if (index.sizes.target + index.sizes.test === 0) return verdict;
        if (alone || call.cutAtTimeout !== undefined) {
          // R895: a request is cut only on a build that retires the §6 Sleep rule (`send`), and on
          // such a build `run()` returned above. Reaching the window with a cut or alone call is a bug.
          throw new Error(
            `al-runner-v3: ${ref.method}'s call was cut at a timeout (R895) on a build where the §6 Sleep rule applies; a cut is never made there`,
          );
        }
        if (this.lanesBuilt) {
          // R766 (b): a window needs the §6 Sleep index, keyed to lane 0's tree; under --workers > 1
          // the session may run only on a build that retires the rule (R768), so this is a bug.
          throw new Error(
            "al-runner-v3-lane-misuse: a pass under a mutant reached the §6 Sleep coverage window under --workers > 1; parallel v3 needs a build whose pin retires the §6 Sleep rule (R766)",
          );
        }
        if (call.windowed !== true) {
          const w = await this.coverageWindow(lane, ref, call);
          if ("verdict" in w) return w.verdict;
          call = w.call;
          if (call.refusal !== undefined) return refusalVerdict(ref, call.refusal, call.wallMs);
        }
      }
      // R652: a window's coverage came after the window's one check, so its notes name that cause.
      const caveat = call.windowed === true ? withWindowCaveat : (s: string) => s;
      // I-1: an index that joins no path of the document is not "no hit": the session stops.
      const joinWhy = sleepJoinRefusal(call.coverage, index);
      if (joinWhy !== undefined) throw new AlRunnerV3CoverageJoinError(caveat(joinWhy));
      if (this.batchBlind === undefined) {
        const blind = blindNote(call.coverage, index);
        if (blind !== undefined) {
          this.batchBlind = caveat(blind);
          this.noteLatch(lane, this.batchBlind);
        }
      }
      const passNote = sleepPassRefusal(call.coverage, index, row.name);
      const note = this.batchBlind ?? (passNote === undefined ? undefined : caveat(passNote));
      if (note !== undefined) {
        return {
          ref,
          outcome: "error",
          durationMs: call.wallMs,
          ...(verdict.measuredDurationMs !== undefined
            ? { measuredDurationMs: verdict.measuredDurationMs }
            : {}),
          ...(verdict.callId !== undefined ? { callId: verdict.callId } : {}),
          failureMessage: note,
          operation: "completed-accepted",
          runnerRow: "runner-refused",
        };
      }
      return verdict;
    }
    if (verdict.outcome === "fail" || verdict.outcome === "timeout") {
      const note = this.stateNote(lane, ref, row, call.rows);
      return note === undefined ? verdict : { ...verdict, backendNote: note };
    }
    return verdict;
  }

  /** I1 (T24): a covering test of the killer's codeunit ran before it in v3's row order. */
  private stateNote(
    lane: Lane,
    killer: TestMethodRef,
    row: V3Row,
    rows: readonly V3Row[],
  ): string | undefined {
    const plan = lane.plan;
    if (plan === undefined || plan.mutantId !== lane.lastActivated) return undefined;
    const k = rows.indexOf(row);
    const before = rows
      .slice(0, k)
      .filter((r) => plan.budgets.has(refKeyOf(killer.codeunitId, r.method)))
      // R637 (S2): a stop and a refusal mean different things to a reader.
      .map(
        (r) =>
          `${r.method} (${r.notRun ? (V3_TIMEOUT_MESSAGE.test(r.message ?? "") ? "timed out" : "refused") : r.status})`,
      );
    return before.length === 0
      ? undefined
      : `${V3_STATE_NOTE_TAG} ${killer.method} ran after covering test(s) ${before.join(", ")} in the same v3 codeunit run (#5611), so their state may have reached it`;
  }

  /** I3 (branch b): a survivor whose covering codeunit had a test v3 refused at baseline. */
  survivorNote(covering: readonly TestMethodRef[]): string | undefined {
    this.soleLane("survivorNote");
    return this.survivorNoteShared(covering);
  }

  private survivorNoteShared(covering: readonly TestMethodRef[]): string | undefined {
    const near = [...new Set(covering.map((r) => r.codeunitId))].flatMap((id) =>
      [...(this.baselineRefused.get(id) ?? [])].map(
        (m) => `${covering.find((c) => c.codeunitId === id)?.codeunitName ?? id}.${m}`,
      ),
    );
    return near.length === 0
      ? undefined
      : `${V3_REFUSED_NEARBY_TAG} ${near.join(", ")}: refused by v3 at baseline in a covering test's codeunit, so a kill it might make on BC is not measured here`;
  }

  private coverageOf(
    lane: Lane,
    rowName: string,
    doc: V3CoverageRead,
  ): CoverageMap | undefined | "unavailable" {
    const index = this.coverageIndex;
    if (index === undefined) return undefined;
    if (doc.kind === "unavailable") return "unavailable";
    const own = doc.perTestCoverage.filter((e) => e.test === rowName);
    const entry = own[0];
    if (entry === undefined || own.length !== 1) return "unavailable";
    // F1 (delta review): on the unmutated call, a hit in a file under the real `active/` must be a
    // file the coverage index knows (indexed or deliberately skipped). One that is neither means v3
    // names our files in another form, and the empty join would make its mutants no-coverage. An
    // uncovered mutant is never activated, so this is checked here, per test, not at `activate`.
    const real = lane.realActive;
    if (real !== undefined) {
      const root = `${normalizeFileKey(real).replace(/\/+$/, "")}/`;
      const control = new Set(
        [
          CONTROL_SELECTOR_FILENAME,
          CONTROL_REGISTER_FILENAME,
          CONTROL_UPGRADE_FILENAME,
          SELECTOR_ECHO_FILENAME,
        ].map(normalizeFileKey),
      );
      for (const f of entry.coverage) {
        if (!(f.statements ?? []).some((s) => (s.hits ?? 0) > 0)) continue;
        const key = normalizeFileKey(f.file);
        if (!key.startsWith(root)) continue;
        const rel = key.slice(root.length);
        if (control.has(rel) || index.byFile.has(rel) || index.skippedFiles.includes(rel)) continue;
        throw new AlRunnerV3CoverageJoinError(
          `al-runner-v3-coverage-join-refused: ${rowName}'s per-test coverage has a hit in ${f.file}, under the deployed batch (${real}), but the coverage index knows no file "${rel}"; reading it as "covered nothing" would be an empty join, so the session stops (R586 I-1, F1)`,
        );
      }
    }
    return alRunnerCoverageFromServer(
      { test: entry.test, coverage: entry.coverage },
      index,
      this.notify,
    );
  }

  private rowMissing(lane: Lane, ref: TestMethodRef, why: string, wallMs: number): TestVerdict {
    const err = new AlRunnerV3RowMissingError(why);
    if (lane.lastActivated === null) throw err;
    return {
      ref,
      outcome: "error",
      durationMs: wallMs,
      failureMessage: err.message,
      operation: "completed-accepted",
      runnerRow: "runner-test-error",
    };
  }

  /** One v3 process for `ref`'s codeunit; its rows are cached only after a full valid decode. */
  private async callCodeunit(
    lane: Lane,
    ref: TestMethodRef,
    timeoutMs: number,
    wantCoverage: boolean,
    /** R907: run exactly this test, alone, without `--skip-after-timeout`; rows are not stored. */
    aloneTest?: string,
  ): Promise<{ readonly call: CallRows } | { readonly verdict: TestVerdict }> {
    const id = ref.codeunitId;
    // R857: one test alone, one process. Only the baseline gets here under --isolate-tests: entries
    // carry no coverage, and a mutant call is an entry.
    const key = this.callId(ref);
    const onlyTest = aloneTest ?? this.isolated(key)?.test;
    // R762 A: an UNMUTATED call that asked for no coverage (a kill confirm) needs none: no flag and
    // no join. A mutant call keeps it whatever it asked: the Sleep rule (§6) reads it.
    // In serve-entries the baseline bracket (`inBaseline`) alone says what the baseline is (R635 §4).
    const noCoverage = !wantCoverage && lane.lastActivated === null && !this.inBaseline;
    // F5: the largest budget of any ref of this codeunit the loop will send for this mutant.
    let budget = timeoutMs;
    const plan = lane.plan;
    if (plan !== undefined && plan.mutantId === lane.lastActivated) {
      for (const [k, ms] of plan.budgets)
        if (k.startsWith(`${id}\u0000`) && ms > budget) budget = ms;
    }
    const stopSeconds = stopSecondsOf(budget);
    const covDir = join(this.cfg.instrumentedDir, "cov");
    await mkdir(covDir, { recursive: true });
    this.callSeq += 1;
    const covPath = join(covDir, `call-${this.callSeq}.json`);
    await rm(covPath, { force: true });
    // R-762 B: a mutant call on a pinned-gone build asks for no coverage (nothing reads it). The
    // baseline test is `isBaselineCall` (as in the verdict path), so one-shot and serve-entries agree.
    const coverageRequested = !noCoverage && !(this.sleepRuleRetired && !this.isBaselineCall(lane));
    // R790 (A1): a baseline call deploy() already ran, on the proved bytes, is served once instead of
    // a spawn; everything below reads its raw answer exactly as a live one's.
    // R948: under serve-entries the baseline's answers come from one daemon (`fillDaemonBaseline`,
    // `fillIsolatedViaDaemon`); a call it could not answer, or a session that dropped the daemon
    // baseline, runs one-shot below exactly as before.
    const viaDaemon =
      aloneTest === undefined
        ? await this.takeDaemonBaseline(
            lane,
            key,
            onlyTest !== undefined,
            stopSeconds,
            coverageRequested,
          )
        : undefined;
    if (viaDaemon !== undefined) {
      await this.checkBound(lane); // R652: as before a send; the bytes now are the proved bytes
      const call: CallRows = {
        rows: viaDaemon.rows,
        stopSeconds,
        wallMs: viaDaemon.wallMs,
        // R963: one daemon baseline answer is one request (`baselineRequest`, one `plain()` per call): its own call id.
        callId: randomUUID(),
        coverage: viaDaemon.coverage,
        ...(noCoverage ? { noCoverage: true } : {}),
      };
      this.noteBaselineRows(lane, key, viaDaemon.rows);
      lane.rowsByCodeunit.set(key, call);
      return { call };
    }
    const spec =
      aloneTest !== undefined || viaDaemon !== undefined
        ? undefined
        : onlyTest !== undefined
          ? await this.takeIsolated(lane, key, stopSeconds, coverageRequested)
          : this.takeSpeculative(lane, id, stopSeconds, coverageRequested);
    // R948: a baseline call over the memory bound starts no process and is dropped like a signalled
    // one (the orchestrator sees the stop and discards its row): never a verdict, never stored.
    let held = false;
    if (spec === undefined && aloneTest === undefined && this.isBaselineCall(lane)) {
      held = true;
      if (!(await this.memoryGate(true))) {
        held = false;
        return {
          verdict: transportFailure(
            ref,
            "al-runner-v3-memory-bound: the container is over its memory bound, so this baseline call was not started and its row is dropped (R948)",
            0,
          ),
        };
      }
    }
    let raw: SpawnedCall;
    if (spec !== undefined) {
      // R652: still checked, as before a send: the bytes now are the proved bytes.
      await this.checkBound(lane);
      raw = spec;
    } else {
      const made = await this.spawnCodeunit({
        id,
        stopSeconds,
        coverageJson: coverageRequested ? covPath : undefined,
        cwd: lane.scratchCwd(),
        // I-1: the same real paths the Sleep index is keyed by.
        activeDir: lane.realActive ?? resolve(lane.activeDir()),
        testDir: this.realTestDir ?? resolve(this.cfg.testDir),
        // R652: the last await before the spawn; nothing below reads the disk before v3 does.
        beforeSpawn: () => this.checkBound(lane),
        ...(onlyTest !== undefined ? { onlyTest } : {}),
        mutantActive: aloneTest === undefined && !this.isBaselineCall(lane),
      }).finally(() => {
        if (held) this.memoryRelease();
      });
      if ("spawnError" in made) {
        return {
          verdict: transportFailure(ref, `could not run v3: ${made.spawnError}`, made.wallMs),
        };
      }
      raw = made;
    }
    const { res, wallMs, timedOut, deadlineMs } = raw;
    // R590: first, so a skipped dependency is named as the cause, not a later symptom.
    refuseDependencySkip(res.stderr);
    refuseMissingDependency(res.exitCode, res.stderr); // R860
    if (timedOut) {
      return {
        verdict: {
          ref,
          outcome: "deadline-exceeded",
          durationMs: wallMs,
          failureMessage: `al-runner-v3: the call for codeunit ${id} passed LethAL's outer bound of ${deadlineMs} ms and was killed; never a kill (R586 §5)`,
        },
      };
    }
    if (res.exitCode === 6) {
      if (exit6Kind(res.stderr) !== "ran-no-test")
        throw new AlRunnerV3SelectionError(id, res.stderr);
      if (lane.lastActivated === null) throw new AlRunnerV3NoTestRanError(id);
      return { verdict: this.rowMissing(lane, ref, ranNoTestWhy(id), wallMs) };
    }
    // R944: on a baseline call a compile refusal is the app's, not this test's: stop the session
    // once, by name. Under a mutant (a chunked or bisected batch compiles its own artifact) it is
    // that batch's, so it stays a transport failure there and the other batches still run.
    const compileRefusal = v3CompileRefusal(res.exitCode, `${res.stdout}\n${res.stderr}`);
    if (compileRefusal !== undefined && this.isBaselineCall(lane))
      throw new AlRunnerV3CompileRefusedError(compileRefusal);
    if (![0, 1, 7, 8].includes(res.exitCode)) {
      return {
        verdict: transportFailure(
          ref,
          `v3 exited ${res.exitCode}: ${res.stderr.slice(-400)}`,
          wallMs,
        ),
      };
    }
    if (res.exitCode === 8 && !this.dotnetHelperWarned) {
      this.dotnetHelperWarned = true;
      this.notify(
        "al-runner-v3-dotnet-helper-missing",
        "[lethal] al-runner-v3-dotnet-helper-missing: v3 exited 8, some tests were not run because its .NET helper could not be used; those tests are never scored (R586 §5).",
      );
    }
    const decoded = decodeV3Rows(res.stdout, id);
    if ("why" in decoded) {
      return { verdict: transportFailure(ref, `codeunit ${id}: ${decoded.why}`, wallMs) };
    }
    this.observedSeed = decoded.seed ?? this.observedSeed;
    // Every suite test of this codeunit (and the asking ref) has exactly one row, or nothing is cached.
    const needed = [...(onlyTest !== undefined ? [] : (this.suitePerCodeunit.get(id) ?? [])), ref];
    for (const t of needed) {
      const n = decoded.rows.filter(
        (r) => r.method.toLowerCase() === t.method.toLowerCase(),
      ).length;
      if (n !== 1) {
        return {
          verdict: this.rowMissing(
            lane,
            ref,
            `codeunit ${id}'s call has ${n} row(s) for ${t.codeunitName}.${t.method}`,
            wallMs,
          ),
        };
      }
    }
    if (this.coverageTamper !== undefined && coverageRequested && lane.lastActivated !== null) {
      await this.coverageTamper(covPath);
    }
    let covText: string | undefined;
    if (spec !== undefined) {
      covText = spec.covText; // read when its call ended, before deploy() returned
    } else {
      try {
        covText = await readFile(covPath, "utf8");
      } catch {
        covText = undefined;
      }
      await rm(covPath, { force: true }).catch(() => {});
    }
    const call: CallRows = {
      rows: decoded.rows,
      stopSeconds,
      wallMs,
      callId: randomUUID(),
      coverage: decodeV3Coverage(covText),
      ...(noCoverage ? { noCoverage: true } : {}),
    };
    if (aloneTest !== undefined) return { call };
    this.noteBaselineRows(lane, key, decoded.rows);
    lane.rowsByCodeunit.set(key, call);
    return { call };
  }

  /** I3, and R635 §3 (N1): a baseline call's refusals, and in serve-entries its rows. */
  private noteBaselineRows(lane: Lane, key: number, rows: readonly V3Row[]): void {
    if (!this.isBaselineCall(lane)) return;
    if (this.entries) this.baselineRows.set(key, rows);
    for (const r of rows) {
      // R678: exactly `v3RowVerdict`'s refusal branch (a notRun with another status is a contract
      // error), so a reused snapshot's verdicts give the same set (`noteReusedBaseline`).
      if (isNamedRefusalRow(r)) this.noteRefused(r.codeunit, r.method);
    }
  }

  /** R678: a reused baseline's refusals, read back from the verdicts `v3RowVerdict` stored. */
  noteReusedBaseline(
    baseline: readonly { readonly ref: TestMethodRef; readonly verdict: TestVerdict }[],
  ): void {
    for (const { ref, verdict } of baseline) {
      if (verdict.failureMessage?.endsWith(V3_NOT_RUN_SUFFIX) !== true) continue;
      // Unreachable today (`v3RowVerdict` writes the suffix only with the runnerRow); never silent.
      if (verdict.runnerRow !== "runner-refused") {
        throw new AlRunnerV3ReusedBaselineUnclassifiedError(
          `${ref.codeunitName}.${ref.method} (runnerRow ${verdict.runnerRow ?? "<none>"})`,
        );
      }
      this.noteRefused(ref.codeunitId, ref.method);
    }
  }

  private noteRefused(id: number, method: string): void {
    const set = this.baselineRefused.get(id) ?? new Set<string>();
    set.add(method);
    this.baselineRefused.set(id, set);
  }

  private requireEchoId(): number {
    const id = this.echoId;
    if (id === undefined) throw new Error("al-runner-v3: serve-entries before a deploy()");
    return id;
  }

  /**
   * R635 §3: the daemon, started lazily with its union warm-up. Throws
   * `AlRunnerV3EntriesRefusedError` (N1 before anything is sent, then N3, then disagreement) or
   * `AlRunnerServerRequestError`; either way no daemon is left behind.
   */
  private async ensureDaemon(lane: Lane, mode: RequestMode): Promise<Daemon> {
    const had = lane.daemonFor(mode);
    // R954: a daemon started under another stop (before `useMutantStop`) is replaced.
    if (had !== undefined && had.stopSeconds === this.serveStopSeconds()) return had;
    if (had !== undefined) await this.closeLane(lane, "mutant-stop");
    const before = lane.timers.warmupMs;
    const d = await lane.timed("warmupMs", () => this.startDaemon(lane, mode));
    lane.lastWarmupMs = lane.timers.warmupMs - before; // this start alone, not the session total
    lane.daemonStarts += 1;
    return d;
  }

  /** A started `serve` daemon, set as `lane`'s for `mode` (no request sent yet). */
  private async spawnDaemon(lane: Lane, mode: RequestMode, stopSeconds: number): Promise<Daemon> {
    const server = new AlRunnerServer(
      absToolPath(this.cfg.alRunnerPath),
      (argv) => this.serverSpawn(argv, { cwd: lane.scratchCwd(), ...this.cacheEnv() }),
      this.cfg.preprocessorSymbols ?? [],
      "serve",
    );
    await server.start(SERVE_READY_MS, [resolve(this.cfg.packagesDir)], stopSeconds, [
      "--bc-version",
      this.cfg.bcVersion,
      "--environment",
      this.environmentChoice.value,
      ...(this.cfg.license !== undefined ? ["--license", this.cfg.license.path] : []), // R956
      ...(this.noDownload() ? ["--no-download"] : []),
      ...(this.sidecarPath !== undefined
        ? [
            "--dotnet-sidecar",
            this.sidecarPath,
            ...this.dotnetAssemblyDirs().flatMap((d) => ["--dotnet-assembly-dir", d]),
          ]
        : []),
    ]);
    this.stats.daemons += 1;
    const daemon: Daemon = { server, dirty: false, stopSeconds };
    lane.setDaemon(mode, daemon);
    return daemon;
  }

  /**
   * R927: on an EXPLICIT serve-entries transport only, before the first baseline: one NONE entry for
   * the test codeunit with the fewest tests, on a daemon closed right after. It judges one thing,
   * whether serve refuses every entry with one reason (`entries-batch-refused`, R635 §6), which no
   * warm-up after the baseline could change, so the session stops in seconds, not after the whole
   * baseline. Nothing else of its answer is read: no baseline exists yet to compare it with. The
   * default transport never probes (its warm-up falls back, R786).
   */
  private async probeBatchRefusal(lane: Lane): Promise<void> {
    if (!this.entries || this.cfg.transportSource !== "explicit" || this.batchProbed) return;
    const smallest = [...this.suitePerCodeunit].sort(
      (a, b) => a[1].length - b[1].length || a[0] - b[0],
    )[0];
    if (smallest === undefined) return;
    const s = this.serveStopSeconds();
    if (s === undefined) throw new AlRunnerV3ServeStopUnsetError();
    this.batchProbed = true;
    this.transportFrozen = true; // R761
    const [cu] = smallest;
    const mode = this.modeOfCall(cu);
    const started = Date.now();
    // Timed as a warm-up (review r1), so its seconds show where the warm-up count does.
    await lane.timed("warmupMs", async () => {
      try {
        // Inside the try (review r1): a daemon that cannot start is not this probe's to judge.
        await this.spawnDaemon(lane, mode, s);
        // Counted as a warm-up, so R652's `boundChecks = warmups + ...` still holds.
        this.stats.warmups += 1;
        await this.send(
          lane,
          [{ mutantId: SELECTOR_RESOURCE_NONE, codeunits: [cu] }],
          "warmup",
          mode,
        );
      } catch (err) {
        if (
          err instanceof AlRunnerV3EntriesRefusedError &&
          err.code === "al-runner-v3-entries-batch-refused"
        ) {
          const why = err.message.slice(err.code.length + 2).replace(/ \(R635 plan §3, §6\)$/, "");
          throw new AlRunnerV3EntriesRefusedError(
            err.code,
            `${why}; found before the baseline by the probe of codeunit ${cu} (${Date.now() - started} ms, R927)`,
          );
        }
        // Anything else is not this probe's to judge: the warm-up after the baseline judges it.
      } finally {
        await this.closeLane(lane, "probe");
      }
    });
  }

  private batchProbed = false;

  private async startDaemon(lane: Lane, mode: RequestMode): Promise<Daemon> {
    const s = this.serveStopSeconds();
    if (s === undefined) throw new AlRunnerV3ServeStopUnsetError();
    this.transportFrozen = true; // R761
    // R896 (review 6a): a daemon is warmed up with, and checked against, its own mode's calls only.
    const union = [...this.union]
      .filter((id) => modeKey(this.modeOfCall(id)) === modeKey(mode))
      .sort((a, b) => Math.abs(a) - Math.abs(b));
    const none = union.filter((cu) => !this.baselineRows.has(cu));
    if (none.length > 0) {
      const named = none.map((id) => this.isolated(id)?.test ?? id);
      throw new AlRunnerV3EntriesRefusedError(
        "al-runner-v3-entries-no-baseline-rows",
        `codeunit(s) ${named.join(", ")} of the warm-up union have no baseline rows recorded by this backend (a reused --resume snapshot runs no baseline), so the warm-up has nothing to be compared with; never empty against empty`,
      );
    }
    const daemon = await this.spawnDaemon(lane, mode, s);
    try {
      this.stats.warmups += 1;
      const { sent, rows } = await this.send(
        lane,
        [{ mutantId: SELECTOR_RESOURCE_NONE, codeunits: union }],
        "warmup",
        mode,
      );
      const disagree: string[] = [];
      const echo = rows.get(sent[0]?.id ?? "") ?? [];
      const echoWhy = echoMismatch(echo, SELECTOR_RESOURCE_NONE);
      if (echoWhy !== undefined) disagree.push(`echo: ${echoWhy}`);
      for (const e of sent.slice(1)) {
        const got = rowsClass(rows.get(e.id) ?? []);
        const want = rowsClass(this.baselineRows.get(callOf(e)) ?? []);
        if (got !== want)
          disagree.push(`codeunit ${e.codeunit}: serve [${got}], one-shot [${want}]`);
      }
      if (disagree.length > 0) {
        throw new AlRunnerV3EntriesRefusedError(
          "al-runner-v3-entries-warmup-disagrees",
          `the daemon's NONE rows are not this batch's one-shot baseline (${disagree.join("; ")}), so no entry on it is trusted`,
        );
      }
      // Build review r1 M1: a warm-up row R612 does not keep (a union test that times out under
      // NONE) would leave every later request on an untrusted daemon, and every fresh daemon repeats
      // it, so re-sending cannot help: refused by name before any mutant entry is sent.
      const unkept: { readonly e: SentEntry; readonly bad: V3Row | undefined }[] = [];
      for (const e of sent) {
        const mine = rows.get(e.id) ?? [];
        if (serveDaemonReusable(serveLines(mine), "v3")) continue;
        const bad = mine.filter((r) => !serveDaemonReusable(serveLines([r]), "v3"));
        if (bad.length === 0) unkept.push({ e, bad: undefined });
        for (const b of bad) unkept.push({ e, bad: b });
      }
      const first = unkept[0];
      if (first !== undefined) {
        // R786: the disagreement check above passed, so one-shot's baseline held the same rows. On
        // the default transport "run one-shot" is right only when EVERY unkept row, in every entry,
        // is a named refusal; one timeout or other unkept kind among them still refuses.
        if (
          this.cfg.transportSource === "default" &&
          first.bad !== undefined &&
          unkept.every((u) => u.bad !== undefined && isNamedRefusalRow(u.bad))
        ) {
          throw new AlRunnerV3ServeFallbackWarmupError(
            `${first.bad.name} (codeunit ${first.e.codeunit})`,
            first.bad.message ?? "?",
          );
        }
        // Name the row that blocks the fallback when there is one, else the first unkept row.
        const blocker = unkept.find((u) => u.bad === undefined || !isNamedRefusalRow(u.bad));
        const named = blocker ?? first;
        // R927: on an explicit transport whose every unkept row is a named refusal, the default
        // would have re-run the session one-shot (R786): say so, so the user knows the way out.
        const wayOut =
          blocker === undefined
            ? `; with no "alRunnerV3.transport" key the default would re-run this session one-shot instead (R786)`
            : "";
        throw new AlRunnerV3EntriesRefusedError(
          "al-runner-v3-entries-warmup-dirty",
          `the warm-up row ${named.bad?.name ?? named.e.id} (codeunit ${named.e.codeunit}) is ${r672Unkept(named.bad) ?? "one R612 does not keep"} (${named.bad?.message ?? named.bad?.status ?? "?"}); every daemon repeats it, so no entry is trusted on any${wayOut}`,
        );
      }
    } catch (err) {
      // A failed request already closed (and counted) its daemon; this finds none then.
      await this.closeLane(
        lane,
        err instanceof AlRunnerV3EntriesRefusedError ||
          err instanceof AlRunnerV3ServeFallbackWarmupError
          ? "warmup-refused"
          : "request-failed",
      );
      throw err;
    }
    return daemon;
  }

  /** R766 (b): every lane's daemon; all are tried even if one close fails, then the first failure is thrown. */
  private async closeAllDaemons(reason: "deploy" | "session-end"): Promise<void> {
    const done = await Promise.allSettled(this.laneList.map((l) => this.closeLane(l, reason)));
    for (const d of done) if (d.status === "rejected") throw d.reason;
  }

  /**
   * R635 §3, §6: one entries request on the current daemon. Returns the sent table and every
   * entry's rows only for a fully valid answer; a request error, a partial or invalid answer
   * closes the daemon and throws `AlRunnerServerRequestError`, and a refusal of the whole request
   * throws `al-runner-v3-entries-batch-refused`. `cached:false` is counted before the decode (N4).
   * R652: the bound is checked here, the last await before the bytes leave, for every kind.
   */
  private async send(
    lane: Lane,
    groups: readonly EntryGroup[],
    kind: "warmup" | "prefetch" | "live",
    mode: RequestMode,
    /** R896 (build review 4): the group count before `request()` split it by mode. */
    groupCount: number = groups.length,
    /** R895: one test alone: call id `call` selects exactly `selection`, and `runSelectedOnly` is sent
     *  in this request's body (on the daemon of the call's own mode). */
    alone?: { readonly call: number; readonly selection: IsolatedSelection },
  ): Promise<{
    readonly sent: readonly SentEntry[];
    readonly rows: ReadonlyMap<string, readonly V3Row[]>;
    /** R895: the answer was cut at a timeout row; only a prefetch or live request can be. */
    readonly cut?: SentCut;
  }> {
    const daemon = lane.daemonFor(mode);
    const s = this.serveStopSeconds();
    if (daemon === undefined || s === undefined)
      throw new Error("al-runner-v3: send() without a daemon");
    const sent = encodeGroups(groups, this.requireEchoId(), (id) =>
      alone !== undefined && id === alone.call ? alone.selection : this.isolated(id),
    );
    const tests = sent.reduce(
      (n, e) =>
        n + (e.echo || e.call !== undefined ? 1 : (this.testsPerCodeunit.get(e.codeunit) ?? 1)),
      0,
    );
    const body = {
      ...lane.requestBase(alone !== undefined ? { ...mode, runSelectedOnly: true } : mode),
      entries: sent.map((e) => ({
        id: e.id,
        resources: e.resources,
        test: e.test,
        ...(e.excludeTests !== undefined ? { excludeTests: e.excludeTests } : {}),
      })),
    };
    await this.checkBound(lane);
    // R652 (review r1 #2): counted with the check, so `boundChecks = warmups + prefetchRequests +
    // liveRequests + coverageRequests` holds whatever fails (a daemon start, a request). Build
    // review L3: a send the check refuses sends no entries.
    this.stats.entriesSent += sent.length;
    if (kind === "prefetch") this.stats.prefetchRequests += 1;
    else if (kind === "live") this.stats.liveRequests += 1;
    let answer: Awaited<ReturnType<AlRunnerServer["runEntries"]>>;
    try {
      // R895: prefetch and live requests stop at a streamed timeout row; the warm-up never does. Only
      // on a build that retires the §6 Sleep rule: the coverage window compares a whole-codeunit run
      // with the call's rows, which a cut call does not have, so where §6 applies nothing is cut.
      answer = await daemon.server.runEntries(
        body,
        // R912: only a prefetch request is clamped to the time left. A live request never is: its
        // deadline would become `deadline-exceeded`, an error verdict.
        kind === "prefetch" && this.prefetchRemainingMs !== undefined
          ? Math.max(1000, Math.min(v3CallDeadlineMs(s, tests), this.prefetchRemainingMs()))
          : v3CallDeadlineMs(s, tests),
        kind !== "warmup" && this.sleepRuleRetiredForParallel(),
      );
    } catch (err) {
      await this.closeLane(lane, "request-failed");
      throw missingDependencyOr(err);
    }
    await this.refuseDaemonDependencySkip(lane, daemon);
    if (answer.cut !== undefined) {
      // A partial answer has no summary: no R807 seed to read, no `cached` to count.
      this.stats.timeoutCuts += 1;
    } else {
      if (typeof answer.summary.seed === "number") this.observedSeed = answer.summary.seed; // R807: AlRunnerServer already checked it
      if (answer.summary.cached === false) this.stats.cachedFalse += 1;
    }
    const decoded = decodeEntriesAnswer(sent, answer, this.serveRowFields);
    if ("why" in decoded) {
      await this.closeLane(lane, "answer-unreadable");
      throw new AlRunnerServerRequestError(
        "protocol",
        `the entries answer is invalid: ${decoded.why}`,
      );
    }
    // Build review r1 L2: only the warm-up or a PREFETCH of 2+ groups speaks for the batch; a lone
    // group's refused rows are that mutant's `error` (its echo did not run), never a batch stop.
    // R653: a live kill pair (NONE and M) speaks for one kill, like a lone live group.
    // R912: a prefetch speaks for the BATCH, not for its window. The group count is the batch's, and
    // the request is placed in the 256-entry chunk a whole-batch prefetch would have put it in: if
    // an earlier window of that chunk had an entry that ran, this one cannot be a batch refusal, as the
    // chunk holding both would not have been. Chunk boundaries fall where `chunkGroups` puts them.
    const batch = kind === "prefetch" ? this.prefetchBatch : undefined;
    if (batch !== undefined && batch.size + sent.length > ENTRIES_CHUNK_CAP) {
      batch.size = 0;
      batch.ran = false;
    }
    const speaksForBatch =
      kind === "warmup" ||
      (kind === "prefetch" && (batch?.groups ?? groupCount) >= 2 && batch?.ran !== true);
    const refused = speaksForBatch
      ? batchRefusalReason(
          decoded.rows,
          (m) => Object.values(V3_SERVE_SAFE_REFUSALS).some((re) => re.test(m)),
          (m) => V3_TIMEOUT_MESSAGE.test(m),
        )
      : undefined;
    if (batch !== undefined) {
      batch.size += sent.length;
      if (refused === undefined) batch.ran = true;
    }
    if (refused !== undefined) {
      await this.closeLane(lane, "batch-refused");
      throw new AlRunnerV3EntriesRefusedError(
        "al-runner-v3-entries-batch-refused",
        `every entry of the request was refused with one reason outside V3_SERVE_SAFE_REFUSALS: ${refused}. Nothing is re-sent`,
      );
    }
    return { sent, rows: decoded.rows, ...(decoded.cut !== undefined ? { cut: decoded.cut } : {}) };
  }

  /**
   * R635 §3, §7: send `groups` on a warm daemon and turn the answer into per-mutant rows. R612's
   * keep rule runs per entry IN ENTRY ORDER: at the first unkept entry the daemon is closed; it
   * and the entries before it stand, every later entry is returned in `resend` as groups (an
   * unkept ECHO's whole group too). A group's rows are `refusal`s when its echo is wrong.
   */
  private async request(
    lane: Lane,
    groups: readonly EntryGroup[],
    phase: "prefetchMs" | "liveMs",
    /** R895: one test alone (see `send`); its entry's rows are checked by the caller, not `suiteMissing`. */
    alone?: { readonly call: number; readonly selection: IsolatedSelection },
  ): Promise<RequestOut> {
    // R896: a request holds one mode's entries. A group whose calls span two modes is split into
    // one group per mode (same mutant and key, each with its own echo), sent as one request per
    // mode, in the order the modes first appear. With one mode this is exactly the old request.
    const byMode = new Map<string, { mode: RequestMode; groups: EntryGroup[] }>();
    for (const g of groups) {
      const parts = new Map<string, number[]>();
      for (const cu of g.codeunits) {
        const mode = this.modeOfCall(cu);
        const k = modeKey(mode);
        if (!byMode.has(k)) byMode.set(k, { mode, groups: [] });
        parts.set(k, [...(parts.get(k) ?? []), cu]);
      }
      for (const [k, codeunits] of parts) byMode.get(k)?.groups.push({ ...g, codeunits });
    }
    const outs: RequestOut[] = [];
    for (const { mode, groups: mine } of byMode.values()) {
      outs.push(await this.requestOne(lane, mine, phase, mode, groups.length, alone));
    }
    const [first, ...rest] = outs;
    if (first === undefined) throw new Error("al-runner-v3: request() with no entries");
    if (rest.length === 0) return first;
    const results = new Map<string, Map<number, CallRows>>();
    const reached = new Set<string>();
    for (const o of outs) {
      for (const [k, m] of o.results) results.set(k, new Map([...(results.get(k) ?? []), ...m]));
      for (const k of o.reached) reached.add(k);
    }
    const cutWhy = outs.find((o) => o.cutWhy !== undefined)?.cutWhy;
    return {
      results,
      resend: outs.flatMap((o) => o.resend),
      // The last request's number: every entry of the merged answer was sent at or before it.
      seq: outs.reduce((n, o) => Math.max(n, o.seq), 0),
      reached,
      ...(cutWhy !== undefined ? { cutWhy } : {}),
    };
  }

  private async requestOne(
    lane: Lane,
    groups: readonly EntryGroup[],
    phase: "prefetchMs" | "liveMs",
    mode: RequestMode,
    /** Build review 4: how many groups the caller asked for, before the split by mode. */
    groupCount: number,
    alone?: { readonly call: number; readonly selection: IsolatedSelection },
  ): Promise<RequestOut> {
    const seq = ++this.requestSeq;
    const daemon = await this.ensureDaemon(lane, mode);
    const started = Date.now();
    const {
      sent,
      rows,
      cut: partial,
    } = await lane.timed(phase, () =>
      this.send(
        lane,
        groups,
        phase === "prefetchMs" ? "prefetch" : "live",
        mode,
        groupCount,
        alone,
      ),
    );
    const wallMs = Date.now() - started;
    const s = this.serveStopSeconds() ?? 1;
    let cut = sent.length;
    for (const [i, e] of sent.entries()) {
      if (!serveDaemonReusable(serveLines(rows.get(e.id) ?? []), "v3")) {
        cut = i;
        break;
      }
    }
    // R895: a cut answer's daemon is already killed; `closeDaemon` clears the lane's reference to it.
    // R939: the reason is the first unkept row's (a refusal's family, a timeout); `dirty` alone is
    // set only by a §6 coverage window whose rows were not kept, with its own `dirtyWhy`.
    const unkept =
      cut < sent.length
        ? unkeptRowReason(serveLines(rows.get(sent[cut]?.id ?? "") ?? []))
        : daemon.dirtyWhy;
    if (cut < sent.length || daemon.dirty)
      await this.closeLane(lane, unkept?.reason ?? "unkept-row", unkept?.family);
    // An unkept ECHO stands like any entry, but its group's codeunit entries come after it, so the
    // whole group is re-sent (§7).
    const standing = sent.slice(0, cut + 1);
    const results = new Map<string, Map<number, CallRows>>();
    const requestCallId = randomUUID(); // R963: one id for the whole request: they share one wall
    let echoWhy: string | undefined;
    const reached = new Set<string>();
    for (const e of standing) {
      reached.add(e.key);
      const mine = rows.get(e.id) ?? [];
      if (e.echo) {
        echoWhy = echoMismatch(mine, e.mutantId);
        if (echoWhy !== undefined) this.stats.echoMismatches += 1;
        continue;
      }
      // R895: the entry the answer was cut in holds the rows it had; its other tests did not run.
      const cutHere = partial !== undefined && partial.entry === e.id;
      const missing =
        cutHere || (alone !== undefined && callOf(e) === alone.call)
          ? undefined
          : this.suiteMissing(callOf(e), mine);
      const call: CallRows = {
        rows: mine,
        stopSeconds: s,
        wallMs,
        callId: requestCallId,
        coverage: { kind: "unavailable", why: "an entries answer carries no coverage (R635 §5)" },
        ...(echoWhy !== undefined
          ? {
              refusal: `entries-echo-mismatch: ${e.mutantId}'s echo in the same request does not vouch for its override (${echoWhy}); never scored (R635 §6)`,
            }
          : {}),
        ...(missing !== undefined ? { missing } : {}),
        ...(cutHere && partial !== undefined ? { cutAtTimeout: { test: partial.test } } : {}),
      };
      const m = results.get(e.key) ?? new Map<number, CallRows>();
      m.set(callOf(e), call);
      results.set(e.key, m);
    }
    const resend: EntryGroup[] = [];
    const keyed = (e: SentEntry) => (e.key === e.mutantId ? {} : { key: e.key });
    for (const e of sent.slice(standing.length)) {
      if (e.echo) continue;
      const last = resend.at(-1);
      if (last !== undefined && (last.key ?? last.mutantId) === e.key) {
        resend[resend.length - 1] = {
          mutantId: e.mutantId,
          ...keyed(e),
          codeunits: [...last.codeunits, callOf(e)],
        };
      } else resend.push({ mutantId: e.mutantId, ...keyed(e), codeunits: [callOf(e)] });
    }
    const cutRow = (rows.get(sent[cut]?.id ?? "") ?? []).find(
      (r) => !serveDaemonReusable(serveLines([r]), "v3"),
    );
    const r672 = r672Unkept(cutRow);
    return {
      results,
      resend,
      seq,
      reached,
      ...(cutRow !== undefined
        ? {
            cutWhy: `${cutRow.name}: ${cutRow.message ?? cutRow.status}${r672 !== undefined ? ` (${r672})` : ""}`,
          }
        : {}),
    };
  }

  /** §6 (#5704): the suite test of `cu` without exactly one row, or `undefined`. */
  private suiteMissing(cu: number, rows: readonly V3Row[]): string | undefined {
    const one = this.isolatedRefs.get(cu);
    // R857: a second row means a test discovery did not see ran beside this one, so it was not alone.
    if (one !== undefined && rows.length > 1) {
      return `the entry for ${one.codeunitName}.${one.method} has ${rows.length} rows, so that test did not run alone`;
    }
    for (const t of one !== undefined ? [one] : (this.suitePerCodeunit.get(cu) ?? [])) {
      const n = rows.filter((r) => r.method.toLowerCase() === t.method.toLowerCase()).length;
      if (n !== 1)
        return `codeunit ${one?.codeunitId ?? cu}'s entry has ${n} row(s) for ${t.codeunitName}.${t.method}`;
    }
    return undefined;
  }

  /**
   * R635 §4: once per mutant-loop call, every covered mutant as one group, in chunks. Only a
   * fully valid answer is stored. A request error leaves its mutants to live requests; a refusal
   * by name stops the session (no mutant of this batch is scored yet). Each group is re-sent at
   * most once (§7: no loop).
   */
  async prefetchMutants(
    plans: readonly { readonly mutantId: string; readonly refs: readonly TestMethodRef[] }[],
    opts?: {
      readonly remainingMs?: () => number;
      /** R912: every covered mutant of the call. Its codeunits join the warm-up union before any
       *  window's daemon starts, as one whole-batch prefetch did; a window alone would warm less. */
      readonly batchPlans?: readonly {
        readonly mutantId: string;
        readonly refs: readonly TestMethodRef[];
      }[];
    },
  ): Promise<void> {
    this.dropPair();
    this.pairStore.clear();
    if (!this.entries) return;
    this.prefetched = new Map();
    for (const p of opts?.batchPlans ?? [])
      for (const cu of new Set(p.refs.map((r) => this.callId(r)))) this.union.add(cu);
    if (opts?.batchPlans !== undefined) {
      this.prefetchBatch = { groups: opts.batchPlans.length, size: 0, ran: false };
    }
    this.prefetchRemainingMs = opts?.remainingMs;
    try {
      await this.prefetchWindow(plans);
    } finally {
      this.prefetchRemainingMs = undefined;
    }
  }

  private async prefetchWindow(
    plans: readonly { readonly mutantId: string; readonly refs: readonly TestMethodRef[] }[],
  ): Promise<void> {
    const groups: EntryGroup[] = plans.map((p) => ({
      mutantId: p.mutantId,
      // By size, as R857's test ids are negative and numbered in the order the tests first ran.
      codeunits: [...new Set(p.refs.map((r) => this.callId(r)))].sort(
        (a, b) => Math.abs(a) - Math.abs(b),
      ),
    }));
    for (const g of groups) for (const cu of g.codeunits) this.union.add(cu);
    const queue = chunkGroups(groups);
    const resent = new Set<string>();
    for (let chunk = queue.shift(); chunk !== undefined; chunk = queue.shift()) {
      // R948: a prefetch request starts no group while the container is over its memory bound; the
      // session stops by the guard (R955's path), so the rest is never scored.
      if (!(await this.memoryGate())) break;
      let out: Awaited<ReturnType<AlRunnerV3Backend["request"]>>;
      try {
        // R766 (b): the shared prefetch runs on lane 0 with the N = 1 grouping; any lane consumes it.
        out = await this.request(this.lane, chunk, "prefetchMs");
      } catch (err) {
        if (err instanceof AlRunnerServerRequestError) {
          // Never silent: its mutants run live, so a cause like a timer overflow shows.
          this.stats.prefetchDropped += 1;
          this.notify(
            "al-runner-v3-entries-prefetch-dropped",
            `[lethal] al-runner-v3-entries-prefetch-dropped: a prefetch request of ${chunk.length} mutant group(s) gave no usable answer (${err.kind}: ${err.message.slice(0, 300)}); its mutants run as live requests (R635 §6).`,
          );
          continue;
        }
        throw err;
      }
      for (const [m, rows] of out.results) {
        const had = this.prefetched.get(m) ?? new Map<number, CallRows>();
        for (const [cu, c] of rows) had.set(cu, { ...c, prefetchSeq: out.seq });
        this.prefetched.set(m, had);
      }
      const again = out.resend.filter((g) => !resent.has(g.mutantId));
      for (const g of again) resent.add(g.mutantId);
      queue.push(...chunkGroups(again));
    }
    await this.batchKillPairs(plans);
  }

  /**
   * R778: the kills the prefetch's rows show (per mutant, the first covering test that FAILED, as
   * the orchestrator's cold loop will see it) get their NONE confirm and mutant reproduction in a
   * few chunked requests, each kill's NONE group directly before its M group (so per kill the order
   * is: the kill, in the prefetch; NONE; M). Kind `live`: a refusal of one of these costs a kill's
   * saving, never the session (build review A5). The pairs wait in `pairStore` for `sendKillPair`.
   * A chunk that throws stores nothing and ends the batch (each kill then takes today's path); an
   * R612 cut keeps the pairs whose two entries both stood, leaves the cut kill to today's path and
   * re-sends the kills after it once, on a fresh daemon.
   */
  private async batchKillPairs(
    plans: readonly { readonly mutantId: string; readonly refs: readonly TestMethodRef[] }[],
  ): Promise<void> {
    const proof = this.proof;
    if (
      !this.pairBatch ||
      this.entriesRefused !== undefined ||
      this.inBaseline ||
      proof === undefined
    )
      return;
    type Kill = { readonly mutantId: string; readonly cu: number };
    const kills: Kill[] = [];
    for (const p of plans) {
      for (const r of p.refs) {
        const call = this.prefetched.get(p.mutantId)?.get(this.callId(r));
        if (call === undefined || call.refusal !== undefined || call.missing !== undefined)
          continue;
        const mine = call.rows.filter(
          (x) => x.codeunit === r.codeunitId && x.method.toLowerCase() === r.method.toLowerCase(),
        );
        const row = mine[0];
        if (mine.length === 1 && row?.status === "fail" && row.notRun !== true) {
          kills.push({ mutantId: p.mutantId, cu: this.callId(r) });
          // R857: a pair holds only its one test, and the kill ledger can make any failing test
          // the killer, so under --isolate-tests each one gets a pair. R896: per codeunit.
          if (!this.perTest(r.codeunitId)) break;
        }
      }
    }
    const tagOf = (k: Kill) => this.pairTag(k.mutantId, k.cu);
    // A kill is 4 entries (two groups of echo + codeunit); a pair is never split across chunks.
    const perChunk = Math.max(1, Math.floor(ENTRIES_CHUNK_CAP / 4));
    const chunksOf = (ks: readonly Kill[]): Kill[][] => {
      const out: Kill[][] = [];
      for (let i = 0; i < ks.length; i += perChunk) out.push(ks.slice(i, i + perChunk));
      return out;
    };
    const queue = chunksOf(kills);
    const resent = new Set<string>();
    for (let chunk = queue.shift(); chunk !== undefined; chunk = queue.shift()) {
      const groups: EntryGroup[] = chunk.flatMap((k) => [
        {
          mutantId: SELECTOR_RESOURCE_NONE,
          key: `${SELECTOR_RESOURCE_NONE}#${tagOf(k)}`,
          codeunits: [k.cu],
        },
        { mutantId: k.mutantId, key: `${tagOf(k)}#m`, codeunits: [k.cu] },
      ]);
      const liveBefore = this.stats.liveRequests;
      let out: Awaited<ReturnType<AlRunnerV3Backend["request"]>>;
      try {
        out = await this.request(this.lane, groups, "liveMs");
      } catch (err) {
        // Like `prefetchMutants`: only a request error is absorbed; a refusal, an unproven batch
        // or a skipped dependency stops the session (S1: never serve stored pairs after one).
        if (!(err instanceof AlRunnerServerRequestError)) throw err;
        this.notify(
          "al-runner-v3-pair-batch-skipped",
          `[lethal] al-runner-v3-pair-batch-skipped: a batch of ${chunk.length} kill pair(s) gave no usable answer (${err.kind}: ${err.message.slice(0, 300)}); nothing of it is stored, and each kill sends its own pair (R778).`,
        );
        return;
      } finally {
        this.stats.pairBatchRequests += this.stats.liveRequests - liveBefore;
      }
      const after: Kill[] = [];
      for (const k of chunk) {
        const tag = tagOf(k);
        const noneKey = `${SELECTOR_RESOURCE_NONE}#${tag}`;
        const none = out.results.get(noneKey)?.get(k.cu);
        const m = out.results.get(`${tag}#m`)?.get(k.cu);
        if (none !== undefined && m !== undefined) {
          this.pairStore.set(`${proof.artifactId}|${tag}`, {
            cu: k.cu,
            seq: out.seq,
            none,
            m,
          });
          this.stats.pairBatchStored += 1;
        } else if (!out.reached.has(noneKey) && !resent.has(tag)) {
          // Nothing of it stood: it lies after the cut. Re-sent once, whole, on a fresh daemon.
          // (A kill with something standing but not both entries is the cut kill: whatever stood
          // is dropped and it takes today's path, so a M row never stands without its NONE row.)
          resent.add(tag);
          after.push(k);
        }
      }
      queue.push(...chunksOf(after));
    }
  }

  /** R857: what names a stored pair: its mutant, and under --isolate-tests also its one test. */
  private pairTag(mutantId: string, id: number): string {
    // R896: per call id; one test's id is in `isolatedRefs`, a whole codeunit's never is.
    return this.isolatedRefs.has(id) ? `${mutantId}#${Math.abs(id)}` : mutantId;
  }

  /**
   * R778 (A2, A4, A6): the stored pair for this kill, or `undefined`. The entry is deleted at the
   * first lookup, match or not. It serves only a kill whose run came from PREFETCHED rows of the
   * codeunit, and only if the pair's request came after that prefetch request; its `ref` is the
   * actual killer (the rows cover the whole codeunit).
   */
  private takeStoredPair(lane: Lane, mutantId: string, ref: TestMethodRef): KillPair | undefined {
    const proof = this.proof;
    if (proof === undefined) return undefined;
    const id = this.callId(ref);
    const key = `${proof.artifactId}|${this.pairTag(mutantId, id)}`;
    const stored = this.pairStore.get(key);
    if (stored === undefined) return undefined;
    this.pairStore.delete(key);
    const killSeq = lane.rowsByCodeunit.get(id)?.prefetchSeq;
    if (stored.cu !== id || killSeq === undefined || stored.seq <= killSeq) {
      this.stats.pairBatchRefused += 1;
      return undefined;
    }
    this.stats.pairBatchServed += 1;
    return { mutantId, ref, none: stored.none, m: stored.m, next: "null" };
  }

  /**
   * R653: a cold fail kill's confirm (NONE) and R577 reproduction (`mutantId`) as ONE live request,
   * confirm FIRST, so the three runs stay kill, NONE, M (a change of the killer's outcome over time
   * cannot make a kill). Stores the answers for the next `activate(null)` and `activate(mutantId)`;
   * sends and stores nothing (today's two live calls) unless serve-entries is live and unlatched,
   * outside the baseline, right after the kill under `mutantId`. An R612 cut keeps what stood: the
   * NONE answer alone (`pairFallbacks1`), or nothing (`pairFallbacks2`).
   * R778: first a pair `batchKillPairs` stored after the prefetch is used (see `takeStoredPair`),
   * which sends nothing.
   */
  async sendKillPair(mutantId: string, ref: TestMethodRef): Promise<void> {
    return this.sendKillPairOn(this.soleLane("sendKillPair"), mutantId, ref);
  }

  private async sendKillPairOn(lane: Lane, mutantId: string, ref: TestMethodRef): Promise<void> {
    lane.dropPair();
    if (
      !this.entries ||
      this.entriesRefused !== undefined ||
      this.inBaseline ||
      lane.lastActivated !== mutantId
    ) {
      return;
    }
    const stored = this.takeStoredPair(lane, mutantId, ref);
    if (stored !== undefined) {
      lane.pair = stored;
      return;
    }
    const cu = this.callId(ref);
    this.union.add(cu);
    const started = Date.now();
    let out: Awaited<ReturnType<AlRunnerV3Backend["request"]>>;
    try {
      out = await this.request(
        lane,
        [
          { mutantId: SELECTOR_RESOURCE_NONE, codeunits: [cu] },
          { mutantId, codeunits: [cu] },
        ],
        "liveMs",
      );
    } catch (err) {
      if (
        err instanceof AlRunnerV3EntriesRefusedError ||
        err instanceof AlRunnerServerRequestError
      ) {
        // As `liveCall` maps the same throw (a refusal latches).
        const noneVerdict = this.liveFailure(lane, ref, err, Date.now() - started);
        lane.pair = { mutantId, ref, noneVerdict, next: "null" };
        return;
      }
      if (
        err instanceof AlRunnerV3DependencySkippedError ||
        err instanceof AlRunnerV3DependencyMissingError ||
        err instanceof AlRunnerV3SeedError ||
        err instanceof AlRunnerV3ServeFallbackWarmupError
      )
        throw err;
      this.notify(
        "al-runner-v3-pair-skipped",
        `[lethal] al-runner-v3-pair-skipped: the kill pair for ${mutantId} was not sent (${err instanceof Error ? `${err.name}: ${err.message.slice(0, 300)}` : String(err)}); the confirm and the reproduction run as live requests (R653).`,
      );
      return;
    }
    // Stored only now: request() may itself close the daemon (an R612 cut, a dirty daemon).
    const none = out.results.get(SELECTOR_RESOURCE_NONE)?.get(cu);
    const m = out.results.get(mutantId)?.get(cu);
    const fallback = none === undefined ? 2 : m === undefined ? 1 : undefined;
    if (fallback === 2) this.stats.pairFallbacks2 += 1;
    if (fallback === 1) this.stats.pairFallbacks1 += 1;
    lane.pair = {
      mutantId,
      ref,
      ...(none !== undefined ? { none } : {}),
      ...(none !== undefined && m !== undefined ? { m } : {}),
      ...(fallback !== undefined ? { fallback } : {}),
      next: "null",
    };
  }

  /** R635 §4: one group (the echo + `ref`'s codeunit) under `lastActivated ?? NONE`. */
  private async liveCall(
    lane: Lane,
    ref: TestMethodRef,
  ): Promise<{ readonly call: CallRows } | { readonly verdict: TestVerdict }> {
    const started = Date.now();
    if (this.entriesRefused !== undefined) {
      return { verdict: transportFailure(ref, this.entriesRefused, 0) };
    }
    const m = lane.lastActivated ?? SELECTOR_RESOURCE_NONE;
    const id = this.callId(ref);
    this.union.add(id);
    try {
      const out = await this.request(lane, [{ mutantId: m, codeunits: [id] }], "liveMs");
      const call = out.results.get(m)?.get(id);
      if (call === undefined) {
        // Its echo was the unkept entry, so nothing of the group stands: this mutant's `error`
        // with the reason (build review r1 L2), never a verdict and never a batch stop.
        return {
          verdict: refusalVerdict(
            ref,
            `entries-echo-mismatch: ${m}'s echo did not run, so nothing of its group is trusted (${out.cutWhy ?? "no reason"}); never scored (R635 §6)`,
            Date.now() - started,
          ),
        };
      }
      this.noteBaselineRows(lane, id, call.rows);
      lane.rowsByCodeunit.set(id, call);
      return { call };
    } catch (err) {
      return { verdict: this.liveFailure(lane, ref, err, Date.now() - started) };
    }
  }

  /**
   * R895: `ref` alone, under the active mutant (or NONE): one live request that selects exactly
   * this test (`isolatedSelection`, with `runSelectedOnly` for this request only). Its call is the
   * ref's answer; the caller never stores it as the codeunit's.
   */
  private async aloneCall(
    lane: Lane,
    ref: TestMethodRef,
  ): Promise<{ readonly call: CallRows } | { readonly verdict: TestVerdict }> {
    const started = Date.now();
    if (this.entriesRefused !== undefined) {
      return { verdict: transportFailure(ref, this.entriesRefused, 0) };
    }
    const m = lane.lastActivated ?? SELECTOR_RESOURCE_NONE;
    const id = this.callId(ref);
    this.union.add(id);
    const selection = isolatedSelection(
      ref.codeunitId,
      ref.method,
      this.discovered.filter((t) => t.codeunitId === ref.codeunitId).map((t) => t.method),
    );
    try {
      const out = await this.request(lane, [{ mutantId: m, codeunits: [id] }], "liveMs", {
        call: id,
        selection,
      });
      const call = out.results.get(m)?.get(id);
      if (call === undefined) {
        return {
          verdict: refusalVerdict(
            ref,
            `entries-echo-mismatch: ${m}'s echo did not run, so nothing of its group is trusted (${out.cutWhy ?? "no reason"}); never scored (R635 §6)`,
            Date.now() - started,
          ),
        };
      }
      return { call };
    } catch (err) {
      return { verdict: this.liveFailure(lane, ref, err, Date.now() - started) };
    }
  }

  /** A live request's throw: a refusal latches (N2: the session stops), a request error is one
   *  transport failure, the deadline is `deadline-exceeded`; anything else propagates. */
  private liveFailure(lane: Lane, ref: TestMethodRef, err: unknown, wallMs: number): TestVerdict {
    if (err instanceof AlRunnerV3EntriesRefusedError) {
      this.entriesRefused = err.message;
      this.noteLatch(lane, err.message);
      return transportFailure(ref, err.message, wallMs);
    }
    if (err instanceof AlRunnerServerRequestError) {
      if (err.kind === "deadline") {
        return {
          ref,
          outcome: "deadline-exceeded",
          durationMs: wallMs,
          failureMessage: `${err.message}; never a kill (R635 §6)`,
        };
      }
      return transportFailure(ref, err.message, wallMs);
    }
    throw err;
  }

  /**
   * R635 §5: the coverage window for a pass under a mutant, once per (mutant, codeunit), on one
   * daemon: the file says the mutant; [echo]; the codeunit with coverage; echo; NONE restored in
   * a `finally`. The window's rows must equal the entry's, and each echo must read the mutant.
   */
  private async coverageWindow(
    lane: Lane,
    ref: TestMethodRef,
    call: CallRows,
  ): Promise<{ readonly call: CallRows } | { readonly verdict: TestVerdict }> {
    if (this.entriesRefused !== undefined) {
      return { verdict: transportFailure(ref, this.entriesRefused, 0) };
    }
    const m = lane.lastActivated ?? SELECTOR_RESOURCE_NONE;
    const echoId = this.requireEchoId();
    const started = Date.now();
    let next: CallRows;
    let checked = false;
    try {
      // R896: the window's echo and coverage request go to the daemon of the call's own mode.
      const mode = this.modeOfCall(this.callId(ref));
      const daemon = await this.ensureDaemon(lane, mode);
      // R652 Rule A: ONE check for the window's 2-3 plain sends, BEFORE `inWindow` (review r1 #1),
      // so it still requires the resource file to read NONE. Counted with its coverage request.
      await this.checkBound(lane);
      this.stats.coverageRequests += 1;
      checked = true;
      const windowT0 = this.now();
      this.inWindow = true;
      try {
        await writeFile(lane.resourcePath(), m, "utf8");
        const echoOk = async (): Promise<string | undefined> => {
          this.stats.echoRequests += 1;
          const why = echoMismatch(
            (await lane.timed("echoMs", () => this.plain(lane, daemon, mode, echoId, false))).rows,
            m,
          );
          if (why !== undefined) this.stats.echoMismatches += 1;
          return why;
        };
        const before = this.cfg.secondEcho === false ? undefined : await echoOk();
        if (before !== undefined) this.stats.secondEchoMismatches += 1;
        const cov = await lane.timed("coverageMs", () =>
          this.plain(lane, daemon, mode, this.callId(ref), true),
        );
        const after = await echoOk();
        const echoWhy = before ?? after;
        const differ = rowsClass(cov.rows) !== rowsClass(call.rows);
        next = {
          ...call,
          coverage: cov.coverage,
          windowed: true,
          ...(echoWhy !== undefined
            ? {
                refusal: withWindowCaveat(
                  `entries-echo-mismatch: the coverage window's echo did not read ${m} (${echoWhy}); never scored (R635 §5)`,
                ),
              }
            : differ
              ? {
                  refusal: withWindowCaveat(
                    `entries-coverage-disagreement: under ${m} the coverage request's rows [${rowsClass(cov.rows)}] are not the entry's [${rowsClass(call.rows)}]; never scored (R635 §5)`,
                  ),
                }
              : {}),
        };
      } finally {
        await writeFile(lane.resourcePath(), SELECTOR_RESOURCE_NONE, "utf8");
        this.inWindow = false;
        if (daemon.dirty)
          await this.closeLane(
            lane,
            daemon.dirtyWhy?.reason ?? "unkept-row",
            daemon.dirtyWhy?.family,
          );
        lane.timers.windowMs += this.now() - windowT0;
      }
    } catch (err) {
      const v = this.liveFailure(lane, ref, err, Date.now() - started);
      return {
        verdict:
          checked && v.failureMessage !== undefined
            ? { ...v, failureMessage: withWindowCaveat(v.failureMessage) }
            : v,
      };
    }
    lane.rowsByCodeunit.set(this.callId(ref), next);
    return { call: next };
  }

  /**
   * R590 (R-537 plan review 2): the daemon reloads its dependencies on every request and logs a skip
   * on its stderr only; the `.alpackages` dirs v3 also searches are outside the §3 proof. Read after
   * every request, over the whole kept tail, so a line that lands late still stops the next request.
   * ponytail: stderr is pumped by its own loop, so one event-loop turn is yielded first; v3 writes the
   * line when it loads dependencies, long before the answer, but a line later than that turn is seen
   * only by the next request.
   */
  private async refuseDaemonDependencySkip(lane: Lane, daemon: Daemon): Promise<void> {
    await new Promise<void>((r) => setImmediate(r));
    this.watchTestDataOff(daemon.server.stderrSoFar()); // R885
    const lines = v3DependencySkipLines(daemon.server.stderrSoFar());
    if (lines.length === 0) return;
    await this.closeLane(lane, "dependency-skip");
    throw new AlRunnerV3DependencySkippedError(lines);
  }

  /**
   * R635 §5: a plain request for one codeunit (the echo, or `call` with coverage) on `daemon`.
   * R857: `call` is one test's id under `--isolate-tests`.
   */
  private async plain(
    lane: Lane,
    daemon: Daemon,
    mode: RequestMode,
    call: number,
    coverage: boolean,
    /** R948: the baseline daemon's own stop; absent: the mutant phase's `serveStopSeconds`. */
    stopSeconds?: number,
  ): Promise<{ readonly rows: readonly V3Row[]; readonly coverage: V3CoverageRead }> {
    const s = stopSeconds ?? this.serveStopSeconds() ?? 1;
    const one = this.isolated(call);
    const cu = one?.codeunit ?? call;
    const body = {
      ...lane.requestBase(mode),
      test: one?.test ?? `Codeunit${cu}.`,
      ...(one?.excludeTests !== undefined ? { excludeTests: one.excludeTests } : {}),
      ...(coverage ? { coverage: true, perTestCoverage: true } : {}),
    };
    let answer: Awaited<ReturnType<AlRunnerServer["runEntries"]>>;
    try {
      answer = await daemon.server.runEntries(
        body,
        v3CallDeadlineMs(s, this.testsPerCodeunit.get(cu) ?? 1),
      );
    } catch (err) {
      await this.closeLane(lane, "request-failed");
      throw missingDependencyOr(err);
    }
    await this.refuseDaemonDependencySkip(lane, daemon);
    if (typeof answer.summary.seed === "number") this.observedSeed = answer.summary.seed; // R807: AlRunnerServer already checked it
    if (answer.summary.cached === false) this.stats.cachedFalse += 1;
    const rows: V3Row[] = [];
    for (const t of answer.tests) {
      const r = serveRow(t, this.serveRowFields);
      if (typeof r === "string" || r.codeunit !== cu) {
        await this.closeLane(lane, "answer-unreadable");
        throw new AlRunnerServerRequestError(
          "protocol",
          `the plain request for codeunit ${cu} answered ${typeof r === "string" ? r : r.name}`,
        );
      }
      rows.push(r);
    }
    if (!serveDaemonReusable(serveLines(rows), "v3")) {
      daemon.dirty = true;
      daemon.dirtyWhy ??= unkeptRowReason(serveLines(rows));
    }
    return {
      rows,
      coverage: coverage
        ? decodeV3Coverage(
            JSON.stringify({
              coverage: answer.summary.coverage,
              perTestCoverage: answer.summary.perTestCoverage,
            }),
          )
        : { kind: "unavailable", why: "not requested" },
    };
  }

  async close(): Promise<void> {
    // R766 (b): every lane's daemon, whether or not the transport is serve-entries.
    await this.closeAllDaemons("session-end");
    if (this.entries) {
      const s = this.entriesStats();
      console.warn(
        `[lethal] al-runner-v3 serve-entries (R635): daemons ${s.daemons}, cached:false ${s.cachedFalse}, requests warm-up ${s.warmups} / prefetch ${s.prefetchRequests} / live ${s.liveRequests} / coverage ${s.coverageRequests} / echo ${s.echoRequests}, entries sent ${s.entriesSent}, echo mismatches ${s.echoMismatches}, kill pairs ${s.pairRequests} (fallbacks M cut ${s.pairFallbacks1}, confirm passed ${s.pairFallbacks1Passed} / NONE cut ${s.pairFallbacks2}, confirm passed ${s.pairFallbacks2Passed}; batched pairs: requests ${s.pairBatchRequests}, stored ${s.pairBatchStored}, served ${s.pairBatchServed}, refused ${s.pairBatchRefused}); wall ms warm-up ${s.warmupMs} / prefetch ${s.prefetchMs} / live ${s.liveMs} / windows ${s.windowMs} (coverage ${s.coverageMs}, echo ${s.echoMs}) / bound ${s.boundMs} over ${s.boundChecks} checks; test-app compile cache (R780) hits ${this.testAppCache.hits} / misses ${this.testAppCache.misses}; ${v3DaemonClosesText(this.daemonCloses())}.`,
      );
    }
    await rm(join(this.cfg.instrumentedDir, "cov"), { recursive: true, force: true }).catch(
      () => {},
    );
  }
}

/** §6 case 2 or 4, from ONE call: the note that makes every later covering pass of the batch error. */
function blindNote(doc: V3CoverageRead, index: SleepIndex): string | undefined {
  // Case 1 (no document) and case 4 (an unowned hit) are about THIS call only; case 2 sticks.
  if (doc.kind === "unavailable") return undefined;
  const note = sleepCallRefusal(doc, index);
  return note?.includes("not in v3's coverage") === true ? note : undefined;
}

function refKeyOf(codeunitId: number, method: string): string {
  return `${codeunitId}\u0000${method.toLowerCase()}`;
}
function refKey(ref: TestMethodRef): string {
  return refKeyOf(ref.codeunitId, ref.method);
}

/** R635 §6: a row of a group whose echo (or §5 window) does not vouch for it: never scored. */
function refusalVerdict(ref: TestMethodRef, note: string, wallMs: number): TestVerdict {
  return {
    ref,
    outcome: "error",
    durationMs: wallMs,
    failureMessage: note,
    operation: "completed-accepted",
    runnerRow: "runner-test-error",
  };
}

/** R635: rows as R612's keep rule reads them. */
function serveLines(rows: readonly V3Row[]): ServerTestLine[] {
  return rows.map((r) => ({
    name: r.name,
    status: r.status,
    ...(r.message !== undefined ? { message: r.message } : {}),
    notRun: r.notRun,
  }));
}

/** R672 (review r2 nit), R675: a plain pass/fail (no notRun) that holds v3's refusal marker
 *  anywhere is closed by R672's rule, not R612's. */
function r672Unkept(r: V3Row | undefined): string | undefined {
  return r !== undefined &&
    r.notRun !== true &&
    (r.status === "pass" || r.status === "fail") &&
    isV3RefusalText(r.message)
    ? `a plain ${r.status} that holds v3's refusal marker (R675), which R672 does not keep`
    : undefined;
}

/** R635 §3, §5: rows compared by method, status, notRun and (for notRun) the reason, in method
 *  order. A fail's text is not compared: it may carry a call stack. */
function rowsClass(rows: readonly V3Row[]): string {
  return rows
    .map((r) => `${r.method.toLowerCase()}=${r.notRun ? `notRun:${r.message ?? ""}` : r.status}`)
    .sort()
    .join(", ");
}

/** A call that gave no readable answer: `pre-dispatch-rejected`, retried once, then the session stops. */
function transportFailure(ref: TestMethodRef, why: string, wallMs: number): TestVerdict {
  return {
    ref,
    outcome: "error",
    durationMs: wallMs,
    failureMessage: `al-runner-v3 transport failure: ${why}; never read as "all passed" (R586 §5)`,
    operation: "pre-dispatch-rejected",
  };
}
