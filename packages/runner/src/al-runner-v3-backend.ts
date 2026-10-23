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
 *   `al-runner-v3-sleep.ts`).
 * One-shot with the static selector by default (`selectorMode: "resource"` is refused by name).
 * R635 adds an opt-in transport, `transport: "serve-entries"` (plan
 * `docs/superpowers/plans/2026-10-22-r635-v3-serve-entries.md`, r3): the baseline stays one-shot,
 * every other run goes to a warm `serve` daemon as entries with a per-entry resource override,
 * each mutant's group vouched for by an echo test (`al-runner-v3-entries.ts`).
 */
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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
  AlRunnerCoverageFrameError,
  type AlRunnerCoverageIndex,
  alRunnerCoverageFromServer,
  buildAlRunnerCoverageIndex,
  normalizeFileKey,
} from "./al-runner-coverage";
import { isV3RefusalText, verdictFromRunnerTest } from "./al-runner-rows";
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
import { assertBcVersionMatchesPackages } from "./al-runner-v3-config";
import {
  type V3ContractResult,
  runV3ContractProbe,
  v3ContractRefusals,
  v3ContractSummary,
  v3DefectWarnings,
} from "./al-runner-v3-contract";
import {
  AlRunnerV3EntriesRefusedError,
  type EntryGroup,
  SELECTOR_ECHO_FILENAME,
  type SentEntry,
  batchRefusalReason,
  chunkGroups,
  decodeEntriesAnswer,
  echoMismatch,
  emitSelectorEcho,
  encodeGroups,
  serveRow,
} from "./al-runner-v3-entries";
import { AlRunnerV3UngatedBuildError, checkGated } from "./al-runner-v3-pin";
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
import { AlcCompileError, ArtifactCompiler, type ArtifactIo, defaultArtifactIo } from "./artifact";
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
} from "./baseline-snapshot";
import { assertManifestObjectsDeclared, readManifestObjectKeys } from "./line-map";
import { type SpawnFn, absToolPath, defaultSpawn } from "./publisher";
import { assertResourceSelectorRuntime, installResourceSelector } from "./resource-selector";
import { TestAppError, symbolPackageId } from "./test-app-publish";
import { LINK_EXCUSED_DIRS, ProjectSymlinkRefusedError } from "./walk";

/**
 * `--version` of a v3 build: `alrunner 3.0.0-alpha.2 (91253f2d6)` (alpha.3 renamed it `al-runner`).
 * R639 F1: an edge build carries SemVer build metadata, `al-runner 3.0.0-alpha.4+edge.20261022
 * (57f1e4f98)`; the metadata is one or more of `[0-9A-Za-z.-]`, never empty and never a space.
 */
export const AL_RUNNER_V3_VERSION =
  /^al-?runner 3\.\d+\.\d+(?:-[\w.]+)?(?:\+[0-9A-Za-z.-]+)? \([0-9a-f]+\)$/;

/** v3's refusal row prefix; R675 moved its one source to `al-runner-rows.ts`. */
export { V3_REFUSAL_PREFIX } from "./al-runner-rows";

/** v3's timeout row (`notRun: true`), anchored: `Test exceeded <N>s timeout.` */
export const V3_TIMEOUT_MESSAGE = /^Test exceeded (\d+)s timeout\.$/;

/**
 * The end of a v3 refusal's verdict text (a notRun `error` row that is not a timeout). R678: a
 * reused snapshot's refusals are read back by it. Changing its text needs an IDENTITY_SCHEME bump:
 * otherwise a same-build snapshot stored under the old text is lent, and its refusals lose their
 * `[v3-refused-test-nearby]` notes on a resume.
 */
const V3_NOT_RUN_SUFFIX =
  "[al-runner v3 did not run this test (notRun), so whether the mutant changes its outcome on BC is unknown: NOT scored (R586 §5)]";

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

/** §5, #5613: exit 6, "the selection matched no test", with no document. Stops the session. */
export class AlRunnerV3SelectionError extends Error {
  constructor(codeunitId: number, stderr: string) {
    super(
      `al-runner-v3: --codeunit ${codeunitId} selected no test (exit 6, no document, #5613). stderr: ${stderr.slice(-400)}`,
    );
    this.name = "AlRunnerV3SelectionError";
  }
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

/** §4: a session-suite test has no row (or two) in its codeunit's call. At baseline it stops. */
export class AlRunnerV3RowMissingError extends Error {
  constructor(readonly detail: string) {
    super(`al-runner-v3: ${detail} (R586 plan §4, rows are cached only after a full decode)`);
    this.name = "AlRunnerV3RowMissingError";
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
  /** v3 `--bc-version` (four numbers), sent with `--no-download`. */
  readonly bcVersion: string;
  readonly selectorObjectId: number;
  readonly alcPath: string;
  readonly coverage?: "al-runner" | "none";
  readonly preprocessorSymbols?: readonly string[];
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
}

/** One row of v3's `--output-json` `tests[]`, decoded. */
export interface V3Row {
  readonly codeunit: number;
  readonly method: string;
  readonly name: string;
  readonly status: "pass" | "fail" | "error";
  readonly durationMs?: number;
  readonly message?: string;
  readonly notRun: boolean;
}

/**
 * Strict decode of one call's document. Any row of the wrong shape, of another codeunit, or a name
 * that is not `Codeunit<codeunit>.<method>` makes the whole document invalid: a call's rows are
 * cached only after a FULL valid decode (F5).
 */
export function decodeV3Rows(
  stdout: string,
  codeunitId: number,
): { readonly rows: readonly V3Row[] } | { readonly why: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return { why: "the --output-json document is not JSON" };
  }
  const tests = (raw as { tests?: unknown } | null)?.tests;
  if (!Array.isArray(tests)) return { why: "the --output-json document has no tests[]" };
  const rows: V3Row[] = [];
  for (const [i, t] of tests.entries()) {
    const r = (t ?? {}) as Record<string, unknown>;
    const { codeunit, method, name, status, durationMs, message, notRun } = r;
    if (
      typeof codeunit !== "number" ||
      typeof method !== "string" ||
      typeof name !== "string" ||
      (status !== "pass" && status !== "fail" && status !== "error") ||
      (durationMs !== undefined && typeof durationMs !== "number") ||
      (message !== undefined && typeof message !== "string") ||
      (notRun !== undefined && typeof notRun !== "boolean")
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
      notRun: notRun === true,
    });
  }
  return { rows };
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
): TestVerdict {
  if (row.notRun) {
    if (row.status !== "error") {
      return {
        ref,
        outcome: "error",
        durationMs: wallMs,
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
          failureMessage: `al-runner-v3 contract: ${row.name} reports a ${n}s stop, but the call was sent --test-timeout-secs ${callStopSeconds}; never scored (R586 §5)`,
          operation: "completed-accepted",
          runnerRow: "runner-test-error",
        };
      }
      return {
        ref,
        outcome: "timeout",
        durationMs: wallMs,
        reportedStopMs: n * 1000,
        timeoutIn: "body",
        failureMessage: row.message ?? "",
      };
    }
    return {
      ref,
      outcome: "error",
      durationMs: wallMs,
      failureMessage: `${row.message ?? "<no message>"} ${V3_NOT_RUN_SUFFIX}`,
      operation: "completed-accepted",
      runnerRow: "runner-refused",
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
      failureMessage: `${row.message ?? ""} [al-runner v3: a ${row.status} that holds v3's refusal marker; never scored (R639, R675)]`,
      operation: "completed-accepted",
      runnerRow: "runner-test-error",
    };
  }
  return verdictFromRunnerTest(
    ref,
    row.name,
    {
      status: row.status,
      ...(row.message !== undefined ? { message: row.message } : {}),
      ...(row.durationMs !== undefined ? { durationMs: row.durationMs } : {}),
    },
    wallMs,
    coverage,
  );
}

/** The argv of one call (T5): one `--codeunit`, `--coverage-json` always, no name selection. */
export function v3CallArgv(a: {
  readonly alRunnerPath: string;
  readonly codeunitId: number;
  readonly stopSeconds: number;
  readonly packagesDir: string;
  readonly bcVersion: string;
  readonly symbols: readonly string[];
  readonly coverageJson: string;
  readonly activeDir: string;
  readonly testDir: string;
}): string[] {
  return [
    a.alRunnerPath,
    "test",
    "--output-json",
    "--isolation",
    "test",
    "--test-timeout-secs",
    String(a.stopSeconds),
    "--codeunit",
    String(a.codeunitId),
    "--package-cache",
    a.packagesDir,
    "--bc-version",
    a.bcVersion,
    "--no-download",
    ...a.symbols.flatMap((s) => ["--define", s]),
    "--coverage-json",
    a.coverageJson,
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
  readonly testAppSha256: string;
}

/** One codeunit call's answer for the active mutant, cached until the next `activate()`/`deploy()`. */
interface CallRows {
  readonly rows: readonly V3Row[];
  readonly stopSeconds: number;
  readonly wallMs: number;
  readonly coverage: V3CoverageRead;
  /** R635: every row of this call is `error` (`entries-echo-mismatch`, `-coverage-disagreement`). */
  readonly refusal?: string;
  /** R635: a suite test of this codeunit had no row (or two) in its entry: `rowMissing`. */
  readonly missing?: string;
  /** R635 §5: the coverage window already ran for this (mutant, codeunit). */
  readonly windowed?: boolean;
}

/** R635: what the serve-entries transport did, for `status()`, the close line and the gate. */
export interface V3EntriesStats {
  daemons: number;
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

/** A started serve daemon; `dirty` closes it after the §5 window in flight (R612 on a plain request). */
interface Daemon {
  readonly server: AlRunnerServer;
  dirty: boolean;
}

/** v3 serve's readiness wait: a cold start may load dependencies (measure.md §8). */
const SERVE_READY_MS = 300_000;

const sha256Of = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

async function fileSha256(path: string): Promise<string> {
  return sha256Of(new Uint8Array(await readFile(path)));
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

export class AlRunnerV3Backend implements ExecutionBackend {
  /** R577 with C2: every activate/deploy clears the rows, so a reproduction really re-runs. */
  readonly killsMustReproduce = true;
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
  private readonly entries: boolean;
  /** §4: set ONLY by the orchestrator's `baselinePhase` bracket. */
  private inBaseline = false;
  /** §3 (N1): the one-shot baseline's rows per codeunit, recorded inside the bracket. */
  private baselineRows = new Map<number, readonly V3Row[]>();
  /** §4: per mutant, the rows a fully valid prefetch answer gave; consumed by `activate`. */
  private prefetched = new Map<string, Map<number, CallRows>>();
  /** §3: the covering codeunits of the batch: the warm-up's union. */
  private union = new Set<number>();
  private daemon: Daemon | undefined;
  /** §3 (N2): a live warm-up refusal; every later run is a transport failure. */
  private entriesRefused: string | undefined;
  /** §2: the echo codeunit, `selectorIds.controlId` of the deployed manifest. */
  private echoId: number | undefined;
  /** §5: true while `active-mutant.txt` legitimately holds a mutant id. */
  private inWindow = false;
  private budgetFloor: { readonly floorMs: number; readonly baselineTimeoutMs: number } | undefined;
  private readonly stats: V3EntriesStats = {
    daemons: 0,
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
    warmupMs: 0,
    prefetchMs: 0,
    liveMs: 0,
    windowMs: 0,
    coverageMs: 0,
    echoMs: 0,
    boundChecks: 0,
    boundMs: 0,
    pairRequests: 0,
    pairFallbacks1: 0,
    pairFallbacks2: 0,
    pairFallbacks1Passed: 0,
    pairFallbacks2Passed: 0,
  };

  private deployedDir: string | undefined;
  private proof: BatchProof | undefined;
  /** F3: the id the last `activate()` wrote; `null` is the baseline selector. */
  private lastActivated: string | null = null;
  private rowsByCodeunit = new Map<number, CallRows>();
  private coverageIndex: AlRunnerCoverageIndex | undefined;
  private sleepIndex: SleepIndex | undefined;
  /** I-1: `active/` and the test dir under `realpath`, the form the index and the argv both use. */
  private realDirs: { readonly active: string; readonly test: string } | undefined;
  /** §6 case 2: a mutant call showed v3 cannot see an indexed Sleep line: every later pass errors. */
  private batchBlind: string | undefined;
  private buildSymbols: readonly string[] | undefined;
  private callSeq = 0;
  /** F5: per mutant, the budgets the covering loop will send each ref (`useCoveringBudgets`). */
  private plan:
    | { readonly mutantId: string; readonly budgets: ReadonlyMap<string, number> }
    | undefined;
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
  private readonly compiler: ArtifactCompiler;
  /** Test hook (legs X (e), (f)): rewrites a mutant call's coverage file before it is read. */
  coverageTamper?: (path: string) => Promise<void>;
  /** How many v3 processes this backend started (legs X (a), (c)). */
  spawnCount = 0;
  /**
   * R653: a fail kill's answers from `sendKillPair`, for the next `activate(null)` (the confirm:
   * its rows `none`, or the verdict a server error maps to) and then `activate(mutantId)` (the
   * reproduction's rows `m`). No rows at all when the NONE entry did not stand. Every public method
   * that works drops it, except the consuming `activate` and the confirm's own `run`.
   */
  private pair:
    | {
        readonly mutantId: string;
        readonly ref: TestMethodRef;
        readonly none?: CallRows;
        readonly noneVerdict?: TestVerdict;
        readonly m?: CallRows;
        /** Which R612 fallback this pair was: 1 (M cut), 2 (NONE cut). */
        readonly fallback?: 1 | 2;
        readonly next: "null" | "mutant";
      }
    | undefined;
  /** R653: the confirm's verdict from the pair, for ONE `run`. */
  private pairVerdict: TestVerdict | undefined;

  private dropPair(): void {
    this.pair = undefined;
    this.pairVerdict = undefined;
  }

  constructor(
    private readonly cfg: AlRunnerV3Config,
    private readonly spawn: SpawnFn = defaultSpawn,
    alcIo: ArtifactIo = defaultArtifactIo,
    /** R635: the serve daemon's spawn (serve-entries only). */
    private readonly serverSpawn: ServerSpawnFn = defaultServerSpawn,
    /** R651: the clock of the phase timers only (a test's fake clock). */
    private readonly now: () => number = Date.now,
  ) {
    if (cfg.selectorMode === "resource") throw new AlRunnerV3ResourceSelectorRefusedError();
    this.entries = cfg.transport === "serve-entries";
    this.compiler = new ArtifactCompiler(
      {
        alcPath: cfg.alcPath,
        packageCachePath: cfg.packagesDir,
        outputDir: join(cfg.instrumentedDir, "alc-out"),
        ...(cfg.preprocessorSymbols !== undefined
          ? { preprocessorSymbols: cfg.preprocessorSymbols }
          : {}),
      },
      alcIo,
    );
  }

  capabilities(): BackendCapabilities {
    return {
      kind: "al-runner-v3",
      coverage: this.cfg.coverage ?? "none",
      deploy: "none",
      // Read by nothing today; `--isolation test` rolls the database back per test, while the
      // codeunit's variables are kept (plan §2).
      isolation: "session",
      // Until #5602, #5603 and #5605 are measured gone (plan §7).
      authoritative: false,
    };
  }

  /** `--version` must be a v3 build and, when pinned, the binary must be the pinned bytes. */
  async status(): Promise<BackendStatus> {
    this.dropPair();
    const res = await this.spawn([this.cfg.alRunnerPath, "--version"]).catch((e) => ({
      exitCode: -1,
      stdout: "",
      stderr: String(e),
    }));
    const reported = (res.stdout || res.stderr).trim();
    if (res.exitCode !== 0) {
      return { ok: false, details: `al-runner v3 not runnable: ${reported.slice(0, 300)}` };
    }
    if (!AL_RUNNER_V3_VERSION.test(reported)) {
      return {
        ok: false,
        details: `${this.cfg.alRunnerPath} reports "${reported.slice(0, 200)}", which is not an al-runner v3 build (R586)`,
      };
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
    try {
      const gated = await checkGated(this.cfg.alRunnerPath, reported, {
        ...(this.cfg.candidate === true ? { candidate: true } : {}),
      });
      this.build = { version: reported, binarySha256: gated.binarySha256 };
      gatedWarnFacts = gated.warnFacts;
      // M1: a session trusts leg C's gate-only facts from this record instead of re-measuring them.
      gateRecord =
        this.cfg.candidate === true
          ? "this update gate's own leg C (a candidate build)"
          : `the gated build's leg C (.gated lethalCommit ${gated.lethalCommit})`;
    } catch (err) {
      if (err instanceof AlRunnerV3UngatedBuildError) return { ok: false, details: err.message };
      throw err;
    }
    // §8: the contract probe, once per backend (one session), after the version and pin checks.
    this.contract ??= await runV3ContractProbe({
      alRunnerPath: this.cfg.alRunnerPath,
      expectedVersion: reported,
      packagesDir: resolve(this.cfg.packagesDir),
      bcVersion: this.cfg.bcVersion,
      alcPath: this.cfg.alcPath,
      ...(this.cfg.cacheDir !== undefined ? { cacheDir: this.cfg.cacheDir } : {}),
      ...(Bun.which("taskset") !== null ? { tasksetPath: Bun.which("taskset") ?? "" } : {}),
      gateOnlyTrusted: gateRecord,
      ...(gatedWarnFacts !== undefined ? { gatedWarnFacts } : {}),
      spawn: this.spawn,
    });
    // R639 r9 §2: `unlike-bc` refuses a normal session; a candidate (update-gate) session warns.
    const kind = { candidate: this.cfg.candidate === true };
    for (const line of v3DefectWarnings(this.contract, kind)) console.warn(line);
    const refusals = v3ContractRefusals(this.contract, kind);
    if (refusals.length > 0) return { ok: false, details: refusals.join("\n") };
    return {
      ok: true,
      details: `${reported}; ${v3ContractSummary(this.contract)}${this.entries ? `; transport serve-entries (R635), secondEcho ${this.cfg.secondEcho !== false}` : ""}`,
    };
  }

  /** §8: the measured contract, for the gate's leg C and the report line. */
  private contract: V3ContractResult | undefined;

  contractResult(): V3ContractResult | undefined {
    return this.contract;
  }

  private build: { readonly version: string; readonly binarySha256: string } | undefined;

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
    this.dropPair();
    this.plan = {
      mutantId,
      budgets: new Map(budgets.map((b) => [refKey(b.ref), b.budgetMs])),
    };
  }

  dependencyPackageDirs(): readonly string[] {
    return [this.cfg.packagesDir];
  }

  /** R635 §3 (R517): the daemon's stop, `S = max(1, ceil(max(floor, baseline) / 1000))`. */
  useMutantBudgetFloor(floorMs: number, baselineTimeoutMs: number): void {
    this.dropPair();
    this.budgetFloor = { floorMs, baselineTimeoutMs };
  }

  private serveStopSeconds(): number | undefined {
    const f = this.budgetFloor;
    return f === undefined ? undefined : stopSecondsOf(Math.max(f.floorMs, f.baselineTimeoutMs));
  }

  /** R635 §4: the orchestrator's bracket around its baseline step. The ONLY source of `inBaseline`. */
  baselinePhase(on: boolean): void {
    this.dropPair();
    this.inBaseline = on;
  }

  /** R635: the transport's counters (serve-entries). */
  entriesStats(): Readonly<V3EntriesStats> {
    return { ...this.stats };
  }

  /** R635 §4: one-shot keeps `lastActivated === null`; serve-entries reads the bracket only. */
  private isBaselineCall(): boolean {
    return this.entries ? this.inBaseline : this.lastActivated === null;
  }

  /** Index-only refusals, merged into selection by `runSession` after each deploy (as v2). */
  async coverageRefusals(): Promise<ReadonlyMap<string, string>> {
    return this.coverageIndex?.refusals ?? new Map();
  }

  /** The Sleep index size of the deployed batch (the pre-committed figure). */
  sleepIndexSize(): { readonly target: number; readonly test: number } | undefined {
    return this.sleepIndex?.sizes;
  }

  /** R645: the working directory of every v3 process of the session (absolute, never the caller's). */
  private scratchCwd(): string {
    return resolve(this.cfg.instrumentedDir);
  }

  /** R645: `ALRUNNER_CACHE`, absolute, because v3 now runs in another cwd. */
  private cacheEnv(): { env: Record<string, string> } | Record<string, never> {
    return this.cfg.cacheDir !== undefined
      ? { env: { ALRUNNER_CACHE: resolve(this.cfg.cacheDir) } }
      : {};
  }

  private activeDir(): string {
    return join(this.cfg.instrumentedDir, "active");
  }

  /** C2 and R349: every field derived from the deployed layout or the active mutant. */
  private resetLayoutState(): void {
    this.rowsByCodeunit = new Map();
    this.coverageIndex = undefined;
    this.sleepIndex = undefined;
    this.proof = undefined;
    this.batchBlind = undefined;
    this.deployedDir = undefined;
    this.lastActivated = null;
    this.prefetched = new Map();
    this.baselineRows = new Map();
    this.union = new Set();
    this.echoId = undefined;
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
    await this.closeDaemon();
    this.resetLayoutState();
    const active = this.activeDir();
    const artifactId = await this.stage(instrumentedDir, active);
    if (this.entries) this.echoId = await readEchoId(active);
    const { ids } = await readManifestIds(active);
    // Step 1: the target. AlcCompileError goes to the orchestrator's R461 / bisection path.
    const target = await this.compileTarget(active);
    try {
      // Step 2: the test app, against the batch's .app plus `<deps>` without any copy of the target.
      const testAppSha256 = await this.compileTestAppAgainst(target.appPath, active);
      // Step 3: the proof, every <deps> file hashed now (m-2), and the per-run checks' baseline.
      this.proof = {
        // R655: active/ is LethAL's copy and holds no link; one refuses here, by path.
        activeHashExceptSelector: await linkIsUnproven(hashAlTree(active), "the staged batch"),
        activeAppJsonSha256: await fileSha256(join(active, "app.json")),
        // R631: the test dir is a USER root: a link refuses rather than hashing a partial tree.
        testDirHash: await hashTestDir(this.cfg.testDir),
        // R608: the same two folders' non-.al files (resources, `.alpackages`).
        activeOther: await listOtherFiles(active, OTHER_FILES_UNBOUND, true),
        testOther: await listOtherFiles(this.cfg.testDir, OTHER_FILES_UNBOUND, true),
        testAppJsonSha256: await fileSha256(join(this.cfg.testDir, "app.json")),
        deps: await listDeps(this.cfg.packagesDir, true),
        artifactId,
        manifestIds: ids,
        targetAppSha256: target.sha256,
        testAppSha256,
      };
    } finally {
      await rm(target.appPath, { force: true }).catch(() => {});
    }
    this.deployedDir = active;
    if ((this.cfg.coverage ?? "none") !== "none") {
      const symbols = this.buildSymbols;
      if (symbols === undefined) {
        throw new Error(
          "al-runner-v3: coverage is on but the session's build symbols were never handed over (useBuildSymbols); refusing rather than guessing the #if arms (R-300b).",
        );
      }
      const index = await buildAlRunnerCoverageIndex(active, {
        symbols,
        ...(this.cfg.sourceProjectDir !== undefined
          ? { sourceProjectDir: this.cfg.sourceProjectDir }
          : {}),
      });
      if (index.multiObjectFiles.length > 0) {
        throw new AlRunnerCoverageFrameError(
          `al-runner-v3: coverage is on and the batch holds multi-object file(s) ${index.multiObjectFiles.join(", ")}; v3's frame for them is not measured, so they are not admitted`,
        );
      }
      assertManifestObjectsDeclared(
        await readManifestObjectKeys(active),
        index.declared,
        index.lineMap.mappedKeys(),
        index.exempt,
      );
      this.coverageIndex = index;
    }
    // §6 (I-1 (1)): from the text v3 reads, rebuilt with every deploy.
    this.sleepIndex = await buildSleepIndex(active, this.cfg.testDir);
    this.realDirs = { active: await realpath(active), test: await realpath(this.cfg.testDir) };
    return null;
  }

  /** §3 step 2. A failure stops the session: the test app does not compile against this batch. */
  private async compileTestAppAgainst(batchApp: string, active: string): Promise<string> {
    const targetId = String(
      (JSON.parse(await readFile(join(active, "app.json"), "utf8")) as { id?: unknown }).id ?? "",
    ).toLowerCase();
    if (targetId === "") throw new Error(`al-runner-v3: ${active}/app.json has no id`);
    const staged = join(this.cfg.instrumentedDir, "alc-test-pkgs");
    await rm(staged, { recursive: true, force: true });
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
        await writeFile(join(staged, name), bytes);
      }
      await writeFile(join(staged, "lethal-v3-batch.app"), await readFile(batchApp));
      let out: { appPath: string; sha256: string };
      try {
        out = await this.compiler.compileProject({
          projectDir: this.cfg.testDir,
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
      return out.sha256;
    } finally {
      await rm(staged, { recursive: true, force: true }).catch(() => {});
    }
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
    // C2: the rows describe the selector as it was; dropped BEFORE the write.
    this.rowsByCodeunit = new Map();
    // R653: the pair is taken out here; only the expected next activation puts anything back.
    const pair = this.pair;
    this.dropPair();
    const proof = this.proof;
    const dir = this.deployedDir;
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
        this.rowsByCodeunit = pre;
      }
      if (pair?.next === "null" && mutantId === null) {
        // The kill's confirm: its rows, or the verdict its server error maps to.
        if (pair.none !== undefined) this.rowsByCodeunit.set(pair.ref.codeunitId, pair.none);
        else if (pair.noneVerdict !== undefined) this.pairVerdict = pair.noneVerdict;
        this.pair = { ...pair, next: "mutant" };
      } else if (pair?.next === "mutant" && mutantId === pair.mutantId) {
        // The reproduction, asked for only after the confirm passed (R577).
        this.stats.pairRequests += 1;
        if (pair.fallback === 1) this.stats.pairFallbacks1Passed += 1;
        if (pair.fallback === 2) this.stats.pairFallbacks2Passed += 1;
        if (pair.m !== undefined) this.rowsByCodeunit.set(pair.ref.codeunitId, pair.m);
      }
      this.lastActivated = mutantId;
      return;
    }
    // The plan is NOT dropped here: keyed by mutant id and read only while that mutant is active,
    // so the R577 reproduction (after the unmutated confirm) runs at the killing call's stop.
    await writeFile(
      join(dir, CONTROL_SELECTOR_FILENAME),
      this.selectorText(proof.artifactId, mutantId),
      "utf8",
    );
    this.lastActivated = mutantId;
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
  private async checkBound(): Promise<void> {
    if (this.inBaseline) return this.assertBound();
    this.stats.boundChecks += 1;
    await this.timed("boundMs", () => this.assertBound());
  }

  /** §3 step 3: the bytes v3 will read are the bytes alc proved. */
  private async assertBound(): Promise<void> {
    const proof = this.proof;
    const dir = this.deployedDir;
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
    const id = this.lastActivated;
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
      const onDisk = await readFile(this.resourcePath(), "utf8").catch(() => "<missing>");
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
    // R652: no bound check here; each send checks (`checkBound`).
    if (this.proof === undefined || this.deployedDir === undefined) {
      throw new AlRunnerV3UnprovenBatchError("no batch was deployed and proved");
    }
    // R653: only the pair's own confirm (after its activate(null)) keeps the pair for the
    // reproduction; any other run drops it. A stored confirm verdict is returned once.
    const pair = this.pair;
    if (!(pair?.next === "mutant" && refKey(pair.ref) === refKey(ref))) this.dropPair();
    const served = this.pairVerdict;
    if (served !== undefined) {
      this.pairVerdict = undefined;
      return { ...served, ref };
    }
    let call = this.rowsByCodeunit.get(ref.codeunitId);
    if (call === undefined) {
      // R635 §4: outside the bracket, serve-entries sends a LIVE one-group request.
      const made =
        this.entries && !this.inBaseline
          ? await this.liveCall(ref)
          : await this.callCodeunit(ref, opts.timeoutMs);
      if ("verdict" in made) return made.verdict;
      call = made.call;
    }
    if (call.refusal !== undefined) return refusalVerdict(ref, call.refusal, call.wallMs);
    if (call.missing !== undefined) return this.rowMissing(ref, call.missing, call.wallMs);
    const mine = call.rows.filter(
      (r) => r.codeunit === ref.codeunitId && r.method.toLowerCase() === ref.method.toLowerCase(),
    );
    const row = mine[0];
    if (row === undefined || mine.length !== 1) {
      // Cached only when every suite test of the codeunit had one row, so this is a ref outside
      // the suite: never a verdict.
      return this.rowMissing(
        ref,
        `${mine.length} row(s) for ${ref.codeunitName}.${ref.method}`,
        call.wallMs,
      );
    }
    const coverage =
      row.status === "pass" && !row.notRun && this.isBaselineCall()
        ? this.coverageOf(row.name, call.coverage)
        : undefined;
    if (coverage === "unavailable") {
      // A contract failure on an unmutated call: never read as "covered nothing" (which would
      // make its mutants no-coverage), so the session stops.
      throw new Error(
        `al-runner-v3: coverage is on and v3's --coverage-json gave no per-test coverage for ${row.name} (${call.coverage.kind === "unavailable" ? call.coverage.why : "no single per-test entry"}); refusing rather than reading it as "covered nothing" (R586 §6)`,
      );
    }
    const verdict = v3RowVerdict(ref, row, call.stopSeconds, call.wallMs, coverage);
    if (this.lastActivated === null) return verdict;
    // R-435 (upstream #5776): v3 marks a later FAILURE after an unfinished test as not trusted, but
    // not a later TIMEOUT. A timeout after a row that was refused or stopped (or holds the refusal
    // marker) may come from that row's partial state, and the cold confirm and R577's re-run both
    // run the test alone, so neither sees it. Never `runner-refused`: R639 must not go on past it.
    if (verdict.outcome === "timeout") {
      const earlier = call.rows
        .slice(0, call.rows.indexOf(row))
        .filter((r) => r.notRun || isV3RefusalText(r.message));
      if (earlier.length > 0)
        return {
          ref,
          outcome: "error",
          durationMs: call.wallMs,
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
      const index = this.sleepIndex;
      if (index === undefined)
        throw new Error("al-runner-v3: no Sleep index for the deployed batch");
      if (this.entries) {
        // R635 §5: an entry carries no coverage. An empty index has nothing to find; otherwise
        // the window gives this (mutant, codeunit) a coverage read, once.
        if (index.sizes.target + index.sizes.test === 0) return verdict;
        if (call.windowed !== true) {
          const w = await this.coverageWindow(ref, call);
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
        if (blind !== undefined) this.batchBlind = caveat(blind);
      }
      const passNote = sleepPassRefusal(call.coverage, index, row.name);
      const note = this.batchBlind ?? (passNote === undefined ? undefined : caveat(passNote));
      if (note !== undefined) {
        return {
          ref,
          outcome: "error",
          durationMs: call.wallMs,
          failureMessage: note,
          operation: "completed-accepted",
          runnerRow: "runner-refused",
        };
      }
      return verdict;
    }
    if (verdict.outcome === "fail" || verdict.outcome === "timeout") {
      const note = this.stateNote(ref, row, call.rows);
      return note === undefined ? verdict : { ...verdict, backendNote: note };
    }
    return verdict;
  }

  /** I1 (T24): a covering test of the killer's codeunit ran before it in v3's row order. */
  private stateNote(killer: TestMethodRef, row: V3Row, rows: readonly V3Row[]): string | undefined {
    const plan = this.plan;
    if (plan === undefined || plan.mutantId !== this.lastActivated) return undefined;
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
    const real = this.realDirs?.active;
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
    return alRunnerCoverageFromServer({ test: entry.test, coverage: entry.coverage }, index);
  }

  private rowMissing(ref: TestMethodRef, why: string, wallMs: number): TestVerdict {
    const err = new AlRunnerV3RowMissingError(why);
    if (this.lastActivated === null) throw err;
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
    ref: TestMethodRef,
    timeoutMs: number,
  ): Promise<{ readonly call: CallRows } | { readonly verdict: TestVerdict }> {
    const id = ref.codeunitId;
    // F5: the largest budget of any ref of this codeunit the loop will send for this mutant.
    let budget = timeoutMs;
    const plan = this.plan;
    if (plan !== undefined && plan.mutantId === this.lastActivated) {
      for (const [k, ms] of plan.budgets)
        if (k.startsWith(`${id}\u0000`) && ms > budget) budget = ms;
    }
    const stopSeconds = stopSecondsOf(budget);
    const covDir = join(this.cfg.instrumentedDir, "cov");
    await mkdir(covDir, { recursive: true });
    this.callSeq += 1;
    const covPath = join(covDir, `call-${this.callSeq}.json`);
    await rm(covPath, { force: true });
    const argv = v3CallArgv({
      alRunnerPath: absToolPath(this.cfg.alRunnerPath),
      codeunitId: id,
      stopSeconds,
      packagesDir: resolve(this.cfg.packagesDir),
      bcVersion: this.cfg.bcVersion,
      symbols: this.cfg.preprocessorSymbols ?? [],
      coverageJson: resolve(covPath),
      // I-1: the same real paths the Sleep index is keyed by.
      activeDir: this.realDirs?.active ?? resolve(this.activeDir()),
      testDir: this.realDirs?.test ?? resolve(this.cfg.testDir),
    });
    // R652: the last await before the spawn; nothing below reads the disk before v3 does.
    await this.checkBound();
    const deadlineMs = v3CallDeadlineMs(stopSeconds, this.testsPerCodeunit.get(id) ?? 1);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, deadlineMs);
    const started = Date.now();
    let res: { exitCode: number; stdout: string; stderr: string };
    this.spawnCount += 1;
    try {
      res = await this.spawn(argv, {
        signal: controller.signal,
        // R645: v3 writes coverage.cobertura.xml into its cwd; never the caller's.
        cwd: this.scratchCwd(),
        ...this.cacheEnv(),
      });
    } catch (err) {
      clearTimeout(timer);
      return {
        verdict: transportFailure(
          ref,
          `could not run v3: ${err instanceof Error ? err.message : String(err)}`,
          Date.now() - started,
        ),
      };
    }
    clearTimeout(timer);
    const wallMs = Date.now() - started;
    // R590: first, so a skipped dependency is named as the cause, not a later symptom.
    refuseDependencySkip(res.stderr);
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
    if (res.exitCode === 6) throw new AlRunnerV3SelectionError(id, res.stderr);
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
      console.warn(
        "[lethal] al-runner-v3-dotnet-helper-missing: v3 exited 8, some tests were not run because its .NET helper could not be used; those tests are never scored (R586 §5).",
      );
    }
    const decoded = decodeV3Rows(res.stdout, id);
    if ("why" in decoded) {
      return { verdict: transportFailure(ref, `codeunit ${id}: ${decoded.why}`, wallMs) };
    }
    // Every suite test of this codeunit (and the asking ref) has exactly one row, or nothing is cached.
    const needed = [...(this.suitePerCodeunit.get(id) ?? []), ref];
    for (const t of needed) {
      const n = decoded.rows.filter(
        (r) => r.method.toLowerCase() === t.method.toLowerCase(),
      ).length;
      if (n !== 1) {
        return {
          verdict: this.rowMissing(
            ref,
            `codeunit ${id}'s call has ${n} row(s) for ${t.codeunitName}.${t.method}`,
            wallMs,
          ),
        };
      }
    }
    if (this.coverageTamper !== undefined && this.lastActivated !== null) {
      await this.coverageTamper(covPath);
    }
    let covText: string | undefined;
    try {
      covText = await readFile(covPath, "utf8");
    } catch {
      covText = undefined;
    }
    await rm(covPath, { force: true }).catch(() => {});
    const call: CallRows = {
      rows: decoded.rows,
      stopSeconds,
      wallMs,
      coverage: decodeV3Coverage(covText),
    };
    this.noteBaselineRows(id, decoded.rows);
    this.rowsByCodeunit.set(id, call);
    return { call };
  }

  /** I3, and R635 §3 (N1): a baseline call's refusals, and in serve-entries its rows. */
  private noteBaselineRows(id: number, rows: readonly V3Row[]): void {
    if (!this.isBaselineCall()) return;
    if (this.entries) this.baselineRows.set(id, rows);
    for (const r of rows) {
      // R678: exactly `v3RowVerdict`'s refusal branch (a notRun with another status is a contract
      // error), so a reused snapshot's verdicts give the same set (`noteReusedBaseline`).
      if (
        r.notRun &&
        r.status === "error" &&
        !(r.message !== undefined && V3_TIMEOUT_MESSAGE.test(r.message))
      ) {
        this.noteRefused(id, r.method);
      }
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

  private resourcePath(): string {
    return join(this.activeDir(), SELECTOR_RESOURCE_FOLDER, SELECTOR_RESOURCE_NAME);
  }

  /** R635 §3: `{ command, sourcePaths, testIsolation }`, the same two roots one-shot passes. */
  private requestBase(): Record<string, unknown> {
    return {
      command: "runTests",
      sourcePaths: [
        this.realDirs?.active ?? resolve(this.activeDir()),
        this.realDirs?.test ?? resolve(this.cfg.testDir),
      ],
      testIsolation: "test",
    };
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
  private async ensureDaemon(): Promise<Daemon> {
    if (this.daemon !== undefined) return this.daemon;
    return this.timed("warmupMs", () => this.startDaemon());
  }

  /** R651: `f`'s wall time into `stats[k]`, thrown or not. TIMING ONLY: no verdict reads it. */
  private async timed<T>(k: V3PhaseTimer, f: () => Promise<T>): Promise<T> {
    const t0 = this.now();
    const bound0 = this.stats.boundMs;
    try {
      return await f();
    } finally {
      // R652: a bound check nested inside this phase (the warm-up's, a request's) is `boundMs`.
      const nested = k === "boundMs" ? 0 : this.stats.boundMs - bound0;
      this.stats[k] += this.now() - t0 - nested;
    }
  }

  private async startDaemon(): Promise<Daemon> {
    const s = this.serveStopSeconds();
    if (s === undefined) throw new AlRunnerV3ServeStopUnsetError();
    const union = [...this.union].sort((a, b) => a - b);
    const none = union.filter((cu) => !this.baselineRows.has(cu));
    if (none.length > 0) {
      throw new AlRunnerV3EntriesRefusedError(
        "al-runner-v3-entries-no-baseline-rows",
        `codeunit(s) ${none.join(", ")} of the warm-up union have no baseline rows recorded by this backend (a reused --resume snapshot runs no baseline), so the warm-up has nothing to be compared with; never empty against empty`,
      );
    }
    const server = new AlRunnerServer(
      absToolPath(this.cfg.alRunnerPath),
      (argv) => this.serverSpawn(argv, { cwd: this.scratchCwd(), ...this.cacheEnv() }),
      this.cfg.preprocessorSymbols ?? [],
      "serve",
    );
    await server.start(SERVE_READY_MS, [resolve(this.cfg.packagesDir)], s, [
      "--bc-version",
      this.cfg.bcVersion,
      "--no-download",
    ]);
    this.stats.daemons += 1;
    const daemon: Daemon = { server, dirty: false };
    this.daemon = daemon;
    try {
      this.stats.warmups += 1;
      const { sent, rows } = await this.send(
        [{ mutantId: SELECTOR_RESOURCE_NONE, codeunits: union }],
        "warmup",
      );
      const disagree: string[] = [];
      const echo = rows.get(sent[0]?.id ?? "") ?? [];
      const echoWhy = echoMismatch(echo, SELECTOR_RESOURCE_NONE);
      if (echoWhy !== undefined) disagree.push(`echo: ${echoWhy}`);
      for (const e of sent.slice(1)) {
        const got = rowsClass(rows.get(e.id) ?? []);
        const want = rowsClass(this.baselineRows.get(e.codeunit) ?? []);
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
      for (const e of sent) {
        const mine = rows.get(e.id) ?? [];
        if (serveDaemonReusable(serveLines(mine), "v3")) continue;
        const bad = mine.find((r) => !serveDaemonReusable(serveLines([r]), "v3"));
        throw new AlRunnerV3EntriesRefusedError(
          "al-runner-v3-entries-warmup-dirty",
          `the warm-up row ${bad?.name ?? e.id} (codeunit ${e.codeunit}) is ${r672Unkept(bad) ?? "one R612 does not keep"} (${bad?.message ?? bad?.status ?? "?"}); every daemon repeats it, so no entry is trusted on any`,
        );
      }
    } catch (err) {
      await this.closeDaemon();
      throw err;
    }
    return daemon;
  }

  private async closeDaemon(): Promise<void> {
    // R653 C5: at most a lost saving; a pair is stored only after its request() returned.
    this.dropPair();
    const d = this.daemon;
    this.daemon = undefined;
    await d?.server.close();
  }

  /**
   * R635 §3, §6: one entries request on the current daemon. Returns the sent table and every
   * entry's rows only for a fully valid answer; a request error, a partial or invalid answer
   * closes the daemon and throws `AlRunnerServerRequestError`, and a refusal of the whole request
   * throws `al-runner-v3-entries-batch-refused`. `cached:false` is counted before the decode (N4).
   * R652: the bound is checked here, the last await before the bytes leave, for every kind.
   */
  private async send(
    groups: readonly EntryGroup[],
    kind: "warmup" | "prefetch" | "live",
  ): Promise<{
    readonly sent: readonly SentEntry[];
    readonly rows: ReadonlyMap<string, readonly V3Row[]>;
  }> {
    const daemon = this.daemon;
    const s = this.serveStopSeconds();
    if (daemon === undefined || s === undefined)
      throw new Error("al-runner-v3: send() without a daemon");
    const sent = encodeGroups(groups, this.requireEchoId());
    const tests = sent.reduce(
      (n, e) => n + (e.echo ? 1 : (this.testsPerCodeunit.get(e.codeunit) ?? 1)),
      0,
    );
    const body = {
      ...this.requestBase(),
      entries: sent.map((e) => ({ id: e.id, resources: e.resources, test: e.test })),
    };
    await this.checkBound();
    // R652 (review r1 #2): counted with the check, so `boundChecks = warmups + prefetchRequests +
    // liveRequests + coverageRequests` holds whatever fails (a daemon start, a request). Build
    // review L3: a send the check refuses sends no entries.
    this.stats.entriesSent += sent.length;
    if (kind === "prefetch") this.stats.prefetchRequests += 1;
    else if (kind === "live") this.stats.liveRequests += 1;
    let answer: Awaited<ReturnType<AlRunnerServer["runEntries"]>>;
    try {
      answer = await daemon.server.runEntries(body, v3CallDeadlineMs(s, tests));
    } catch (err) {
      await this.closeDaemon();
      throw err;
    }
    await this.refuseDaemonDependencySkip(daemon);
    if (answer.summary.cached === false) this.stats.cachedFalse += 1;
    const decoded = decodeEntriesAnswer(sent, answer);
    if ("why" in decoded) {
      await this.closeDaemon();
      throw new AlRunnerServerRequestError(
        "protocol",
        `the entries answer is invalid: ${decoded.why}`,
      );
    }
    // Build review r1 L2: only the warm-up or a PREFETCH of 2+ groups speaks for the batch; a lone
    // group's refused rows are that mutant's `error` (its echo did not run), never a batch stop.
    // R653: a live kill pair (NONE and M) speaks for one kill, like a lone live group.
    const refused =
      kind === "warmup" || (kind === "prefetch" && groups.length >= 2)
        ? batchRefusalReason(
            decoded.rows,
            (m) => Object.values(V3_SERVE_SAFE_REFUSALS).some((re) => re.test(m)),
            (m) => V3_TIMEOUT_MESSAGE.test(m),
          )
        : undefined;
    if (refused !== undefined) {
      await this.closeDaemon();
      throw new AlRunnerV3EntriesRefusedError(
        "al-runner-v3-entries-batch-refused",
        `every entry of the request was refused with one reason outside V3_SERVE_SAFE_REFUSALS: ${refused}. Nothing is re-sent`,
      );
    }
    return { sent, rows: decoded.rows };
  }

  /**
   * R635 §3, §7: send `groups` on a warm daemon and turn the answer into per-mutant rows. R612's
   * keep rule runs per entry IN ENTRY ORDER: at the first unkept entry the daemon is closed; it
   * and the entries before it stand, every later entry is returned in `resend` as groups (an
   * unkept ECHO's whole group too). A group's rows are `refusal`s when its echo is wrong.
   */
  private async request(
    groups: readonly EntryGroup[],
    phase: "prefetchMs" | "liveMs",
  ): Promise<{
    readonly results: ReadonlyMap<string, Map<number, CallRows>>;
    readonly resend: readonly EntryGroup[];
    /** The first row R612 did not keep, at the cut. */
    readonly cutWhy?: string;
  }> {
    const daemon = await this.ensureDaemon();
    const started = Date.now();
    const { sent, rows } = await this.timed(phase, () =>
      this.send(groups, phase === "prefetchMs" ? "prefetch" : "live"),
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
    if (cut < sent.length || daemon.dirty) await this.closeDaemon();
    // An unkept ECHO stands like any entry, but its group's codeunit entries come after it, so the
    // whole group is re-sent (§7).
    const standing = sent.slice(0, cut + 1);
    const results = new Map<string, Map<number, CallRows>>();
    let echoWhy: string | undefined;
    for (const e of standing) {
      const mine = rows.get(e.id) ?? [];
      if (e.echo) {
        echoWhy = echoMismatch(mine, e.mutantId);
        if (echoWhy !== undefined) this.stats.echoMismatches += 1;
        continue;
      }
      const missing = this.suiteMissing(e.codeunit, mine);
      const call: CallRows = {
        rows: mine,
        stopSeconds: s,
        wallMs,
        coverage: { kind: "unavailable", why: "an entries answer carries no coverage (R635 §5)" },
        ...(echoWhy !== undefined
          ? {
              refusal: `entries-echo-mismatch: ${e.mutantId}'s echo in the same request does not vouch for its override (${echoWhy}); never scored (R635 §6)`,
            }
          : {}),
        ...(missing !== undefined ? { missing } : {}),
      };
      const m = results.get(e.mutantId) ?? new Map<number, CallRows>();
      m.set(e.codeunit, call);
      results.set(e.mutantId, m);
    }
    const resend: EntryGroup[] = [];
    for (const e of sent.slice(standing.length)) {
      if (e.echo) continue;
      const last = resend.at(-1);
      if (last !== undefined && last.mutantId === e.mutantId) {
        resend[resend.length - 1] = {
          mutantId: e.mutantId,
          codeunits: [...last.codeunits, e.codeunit],
        };
      } else resend.push({ mutantId: e.mutantId, codeunits: [e.codeunit] });
    }
    const cutRow = (rows.get(sent[cut]?.id ?? "") ?? []).find(
      (r) => !serveDaemonReusable(serveLines([r]), "v3"),
    );
    const r672 = r672Unkept(cutRow);
    return {
      results,
      resend,
      ...(cutRow !== undefined
        ? {
            cutWhy: `${cutRow.name}: ${cutRow.message ?? cutRow.status}${r672 !== undefined ? ` (${r672})` : ""}`,
          }
        : {}),
    };
  }

  /** §6 (#5704): the suite test of `cu` without exactly one row, or `undefined`. */
  private suiteMissing(cu: number, rows: readonly V3Row[]): string | undefined {
    for (const t of this.suitePerCodeunit.get(cu) ?? []) {
      const n = rows.filter((r) => r.method.toLowerCase() === t.method.toLowerCase()).length;
      if (n !== 1)
        return `codeunit ${cu}'s entry has ${n} row(s) for ${t.codeunitName}.${t.method}`;
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
  ): Promise<void> {
    this.dropPair();
    if (!this.entries) return;
    this.prefetched = new Map();
    const groups: EntryGroup[] = plans.map((p) => ({
      mutantId: p.mutantId,
      codeunits: [...new Set(p.refs.map((r) => r.codeunitId))].sort((a, b) => a - b),
    }));
    for (const g of groups) for (const cu of g.codeunits) this.union.add(cu);
    const queue = chunkGroups(groups);
    const resent = new Set<string>();
    for (let chunk = queue.shift(); chunk !== undefined; chunk = queue.shift()) {
      let out: Awaited<ReturnType<AlRunnerV3Backend["request"]>>;
      try {
        out = await this.request(chunk, "prefetchMs");
      } catch (err) {
        if (err instanceof AlRunnerServerRequestError) {
          // Never silent: its mutants run live, so a cause like a timer overflow shows.
          this.stats.prefetchDropped += 1;
          console.warn(
            `[lethal] al-runner-v3-entries-prefetch-dropped: a prefetch request of ${chunk.length} mutant group(s) gave no usable answer (${err.kind}: ${err.message.slice(0, 300)}); its mutants run as live requests (R635 §6).`,
          );
          continue;
        }
        throw err;
      }
      for (const [m, rows] of out.results) {
        const had = this.prefetched.get(m) ?? new Map<number, CallRows>();
        for (const [cu, c] of rows) had.set(cu, c);
        this.prefetched.set(m, had);
      }
      const again = out.resend.filter((g) => !resent.has(g.mutantId));
      for (const g of again) resent.add(g.mutantId);
      queue.push(...chunkGroups(again));
    }
  }

  /**
   * R653: a cold fail kill's confirm (NONE) and R577 reproduction (`mutantId`) as ONE live request,
   * confirm FIRST, so the three runs stay kill, NONE, M (a change of the killer's outcome over time
   * cannot make a kill). Stores the answers for the next `activate(null)` and `activate(mutantId)`;
   * sends and stores nothing (today's two live calls) unless serve-entries is live and unlatched,
   * outside the baseline, right after the kill under `mutantId`. An R612 cut keeps what stood: the
   * NONE answer alone (`pairFallbacks1`), or nothing (`pairFallbacks2`).
   */
  async sendKillPair(mutantId: string, ref: TestMethodRef): Promise<void> {
    this.dropPair();
    if (
      !this.entries ||
      this.entriesRefused !== undefined ||
      this.inBaseline ||
      this.lastActivated !== mutantId
    ) {
      return;
    }
    const cu = ref.codeunitId;
    this.union.add(cu);
    const started = Date.now();
    let out: Awaited<ReturnType<AlRunnerV3Backend["request"]>>;
    try {
      out = await this.request(
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
        const noneVerdict = this.liveFailure(ref, err, Date.now() - started);
        this.pair = { mutantId, ref, noneVerdict, next: "null" };
        return;
      }
      if (err instanceof AlRunnerV3DependencySkippedError) throw err;
      console.warn(
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
    this.pair = {
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
    ref: TestMethodRef,
  ): Promise<{ readonly call: CallRows } | { readonly verdict: TestVerdict }> {
    const started = Date.now();
    if (this.entriesRefused !== undefined) {
      return { verdict: transportFailure(ref, this.entriesRefused, 0) };
    }
    const m = this.lastActivated ?? SELECTOR_RESOURCE_NONE;
    this.union.add(ref.codeunitId);
    try {
      const out = await this.request([{ mutantId: m, codeunits: [ref.codeunitId] }], "liveMs");
      const call = out.results.get(m)?.get(ref.codeunitId);
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
      this.noteBaselineRows(ref.codeunitId, call.rows);
      this.rowsByCodeunit.set(ref.codeunitId, call);
      return { call };
    } catch (err) {
      return { verdict: this.liveFailure(ref, err, Date.now() - started) };
    }
  }

  /** A live request's throw: a refusal latches (N2: the session stops), a request error is one
   *  transport failure, the deadline is `deadline-exceeded`; anything else propagates. */
  private liveFailure(ref: TestMethodRef, err: unknown, wallMs: number): TestVerdict {
    if (err instanceof AlRunnerV3EntriesRefusedError) {
      this.entriesRefused = err.message;
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
    ref: TestMethodRef,
    call: CallRows,
  ): Promise<{ readonly call: CallRows } | { readonly verdict: TestVerdict }> {
    if (this.entriesRefused !== undefined) {
      return { verdict: transportFailure(ref, this.entriesRefused, 0) };
    }
    const m = this.lastActivated ?? SELECTOR_RESOURCE_NONE;
    const echoId = this.requireEchoId();
    const started = Date.now();
    let next: CallRows;
    let checked = false;
    try {
      const daemon = await this.ensureDaemon();
      // R652 Rule A: ONE check for the window's 2-3 plain sends, BEFORE `inWindow` (review r1 #1),
      // so it still requires the resource file to read NONE. Counted with its coverage request.
      await this.checkBound();
      this.stats.coverageRequests += 1;
      checked = true;
      const windowT0 = this.now();
      this.inWindow = true;
      try {
        await writeFile(this.resourcePath(), m, "utf8");
        const echoOk = async (): Promise<string | undefined> => {
          this.stats.echoRequests += 1;
          const why = echoMismatch(
            (await this.timed("echoMs", () => this.plain(daemon, echoId, false))).rows,
            m,
          );
          if (why !== undefined) this.stats.echoMismatches += 1;
          return why;
        };
        const before = this.cfg.secondEcho === false ? undefined : await echoOk();
        if (before !== undefined) this.stats.secondEchoMismatches += 1;
        const cov = await this.timed("coverageMs", () => this.plain(daemon, ref.codeunitId, true));
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
        await writeFile(this.resourcePath(), SELECTOR_RESOURCE_NONE, "utf8");
        this.inWindow = false;
        if (daemon.dirty) await this.closeDaemon();
        this.stats.windowMs += this.now() - windowT0;
      }
    } catch (err) {
      const v = this.liveFailure(ref, err, Date.now() - started);
      return {
        verdict:
          checked && v.failureMessage !== undefined
            ? { ...v, failureMessage: withWindowCaveat(v.failureMessage) }
            : v,
      };
    }
    this.rowsByCodeunit.set(ref.codeunitId, next);
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
  private async refuseDaemonDependencySkip(daemon: Daemon): Promise<void> {
    await new Promise<void>((r) => setImmediate(r));
    const lines = v3DependencySkipLines(daemon.server.stderrSoFar());
    if (lines.length === 0) return;
    await this.closeDaemon();
    throw new AlRunnerV3DependencySkippedError(lines);
  }

  /** R635 §5: a plain request for one codeunit (the echo, or `cu` with coverage) on `daemon`. */
  private async plain(
    daemon: Daemon,
    cu: number,
    coverage: boolean,
  ): Promise<{ readonly rows: readonly V3Row[]; readonly coverage: V3CoverageRead }> {
    const s = this.serveStopSeconds() ?? 1;
    const body = {
      ...this.requestBase(),
      test: `Codeunit${cu}.`,
      ...(coverage ? { coverage: true, perTestCoverage: true } : {}),
    };
    let answer: Awaited<ReturnType<AlRunnerServer["runEntries"]>>;
    try {
      answer = await daemon.server.runEntries(
        body,
        v3CallDeadlineMs(s, this.testsPerCodeunit.get(cu) ?? 1),
      );
    } catch (err) {
      await this.closeDaemon();
      throw err;
    }
    await this.refuseDaemonDependencySkip(daemon);
    if (answer.summary.cached === false) this.stats.cachedFalse += 1;
    const rows: V3Row[] = [];
    for (const t of answer.tests) {
      const r = serveRow(t);
      if (typeof r === "string" || r.codeunit !== cu) {
        await this.closeDaemon();
        throw new AlRunnerServerRequestError(
          "protocol",
          `the plain request for codeunit ${cu} answered ${typeof r === "string" ? r : r.name}`,
        );
      }
      rows.push(r);
    }
    if (!serveDaemonReusable(serveLines(rows), "v3")) daemon.dirty = true;
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
    if (this.entries) {
      await this.closeDaemon();
      const s = this.stats;
      console.warn(
        `[lethal] al-runner-v3 serve-entries (R635): daemons ${s.daemons}, cached:false ${s.cachedFalse}, requests warm-up ${s.warmups} / prefetch ${s.prefetchRequests} / live ${s.liveRequests} / coverage ${s.coverageRequests} / echo ${s.echoRequests}, entries sent ${s.entriesSent}, echo mismatches ${s.echoMismatches}, kill pairs ${s.pairRequests} (fallbacks M cut ${s.pairFallbacks1}, confirm passed ${s.pairFallbacks1Passed} / NONE cut ${s.pairFallbacks2}, confirm passed ${s.pairFallbacks2Passed}); wall ms warm-up ${s.warmupMs} / prefetch ${s.prefetchMs} / live ${s.liveMs} / windows ${s.windowMs} (coverage ${s.coverageMs}, echo ${s.echoMs}) / bound ${s.boundMs} over ${s.boundChecks} checks.`,
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
