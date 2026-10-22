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
 * One-shot only; the static selector only (the resource selector is refused by name).
 */
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  CONTROL_REGISTER_FILENAME,
  CONTROL_SELECTOR_FILENAME,
  CONTROL_UPGRADE_FILENAME,
  emitStaticSelector,
} from "@lethal/schemata";
import { verdictFromRunnerTest } from "./al-runner-backend";
import {
  AlRunnerCoverageFrameError,
  type AlRunnerCoverageIndex,
  alRunnerCoverageFromServer,
  buildAlRunnerCoverageIndex,
  normalizeFileKey,
} from "./al-runner-coverage";
import { assertBcVersionMatchesPackages } from "./al-runner-v3-config";
import {
  type V3ContractResult,
  runV3ContractProbe,
  v3ContractRefusals,
  v3ContractSummary,
  v3DefectWarnings,
} from "./al-runner-v3-contract";
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
import { hashAlTree, hashTestDir } from "./baseline-snapshot";
import { assertManifestObjectsDeclared, readManifestObjectKeys } from "./line-map";
import { type SpawnFn, defaultSpawn } from "./publisher";
import { TestAppError, symbolPackageId } from "./test-app-publish";
import { ProjectSymlinkRefusedError } from "./walk";

/** `--version` of a v3 build: `alrunner 3.0.0-alpha.2 (91253f2d6)` (alpha.3 renamed it `al-runner`). */
export const AL_RUNNER_V3_VERSION = /^al-?runner 3\.\d+\.\d+(?:-[\w.]+)? \([0-9a-f]+\)$/;

/** v3's timeout row (`notRun: true`), anchored: `Test exceeded <N>s timeout.` */
export const V3_TIMEOUT_MESSAGE = /^Test exceeded (\d+)s timeout\.$/;

/** The four note tags (plan §4, §6), in `failureNote`; the gate and any count read them by tag. */
export const V3_STATE_NOTE_TAG = "[v3-codeunit-state-possible]";
export const V3_REFUSED_NEARBY_TAG = "[v3-refused-test-nearby]";

/** §3: the bytes v3 would read are not the bytes alc proved. Stops the session. */
export class AlRunnerV3UnprovenBatchError extends Error {
  constructor(what: string) {
    super(
      `al-runner-v3: refusing to start v3: ${what}. v3 runs code that does not compile (#5602), so it may only run the exact bytes LethAL's alc compile proved for this batch (R586 plan §3).`,
    );
    this.name = "AlRunnerV3UnprovenBatchError";
  }
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
      failureMessage: `${row.message ?? "<no message>"} [al-runner v3 did not run this test (notRun), so whether the mutant changes its outcome on BC is unknown: NOT scored (R586 §5)]`,
      operation: "completed-accepted",
      runnerRow: "runner-refused",
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

/** §5: the outer wall bound of one call, `10 x N x tests + 90 s` (v3 stops a waiting test at 10 x N). */
export function v3CallDeadlineMs(stopSeconds: number, testsInCodeunit: number): number {
  return 10 * stopSeconds * 1000 * Math.max(1, testsInCodeunit) + 90_000;
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
}

const sha256Of = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

async function fileSha256(path: string): Promise<string> {
  return sha256Of(new Uint8Array(await readFile(path)));
}

async function listDeps(dir: string, withSha: boolean): Promise<DepsEntry[]> {
  const out: DepsEntry[] = [];
  for (const name of (await readdir(dir)).sort()) {
    const p = join(dir, name);
    const s = await stat(p);
    if (!s.isFile()) continue;
    out.push({
      name,
      size: s.size,
      mtimeMs: s.mtimeMs,
      sha256: withSha ? await fileSha256(p) : "",
    });
  }
  return out;
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
  /** One-shot: the stop a call is sent is the largest budget of its refs (F5). */
  readonly inRunStopIsBudget = true;

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
  /** I3: tests v3 refused at baseline (notRun, not a timeout), per codeunit. */
  private baselineRefused = new Map<number, Set<string>>();
  private dotnetHelperWarned = false;
  private readonly compiler: ArtifactCompiler;
  /** Test hook (legs X (e), (f)): rewrites a mutant call's coverage file before it is read. */
  coverageTamper?: (path: string) => Promise<void>;
  /** How many v3 processes this backend started (legs X (a), (c)). */
  spawnCount = 0;

  constructor(
    private readonly cfg: AlRunnerV3Config,
    private readonly spawn: SpawnFn = defaultSpawn,
    alcIo: ArtifactIo = defaultArtifactIo,
  ) {
    if (cfg.selectorMode === "resource") throw new AlRunnerV3ResourceSelectorRefusedError();
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
    for (const line of v3DefectWarnings(this.contract)) console.warn(line);
    const refusals = v3ContractRefusals(this.contract);
    if (refusals.length > 0) return { ok: false, details: refusals.join("\n") };
    return { ok: true, details: `${reported}; ${v3ContractSummary(this.contract)}` };
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
    this.buildSymbols = [...symbols];
  }

  useDiscoveredTests(tests: readonly TestMethodRef[]): void {
    const m = new Map<number, number>();
    for (const t of tests) m.set(t.codeunitId, (m.get(t.codeunitId) ?? 0) + 1);
    this.testsPerCodeunit = m;
  }

  useSessionTests(suite: readonly TestMethodRef[]): void {
    const m = new Map<number, TestMethodRef[]>();
    for (const t of suite) m.set(t.codeunitId, [...(m.get(t.codeunitId) ?? []), t]);
    this.suitePerCodeunit = m;
  }

  /** F5: the covering refs of `mutantId` and the budget each will be sent. */
  useCoveringBudgets(
    mutantId: string,
    budgets: readonly { readonly ref: TestMethodRef; readonly budgetMs: number }[],
  ): void {
    this.plan = {
      mutantId,
      budgets: new Map(budgets.map((b) => [refKey(b.ref), b.budgetMs])),
    };
  }

  dependencyPackageDirs(): readonly string[] {
    return [this.cfg.packagesDir];
  }

  /** Index-only refusals, merged into selection by `runSession` after each deploy (as v2). */
  async coverageRefusals(): Promise<ReadonlyMap<string, string>> {
    return this.coverageIndex?.refusals ?? new Map();
  }

  /** The Sleep index size of the deployed batch (the pre-committed figure). */
  sleepIndexSize(): { readonly target: number; readonly test: number } | undefined {
    return this.sleepIndex?.sizes;
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
  }

  /** A batch as v3 reads it: control files dropped, the static selector at the baseline. */
  private async stage(fromDir: string, toDir: string): Promise<string> {
    await rm(toDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    await cp(fromDir, toDir, { recursive: true });
    for (const f of [CONTROL_REGISTER_FILENAME, CONTROL_UPGRADE_FILENAME]) {
      await rm(join(toDir, f), { force: true });
    }
    const { artifactId } = await readManifestIds(toDir);
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
    this.resetLayoutState();
    const active = this.activeDir();
    const artifactId = await this.stage(instrumentedDir, active);
    const { ids } = await readManifestIds(active);
    // Step 1: the target. AlcCompileError goes to the orchestrator's R461 / bisection path.
    const target = await this.compileTarget(active);
    try {
      // Step 2: the test app, against the batch's .app plus `<deps>` without any copy of the target.
      const testAppSha256 = await this.compileTestAppAgainst(target.appPath, active);
      // Step 3: the proof, every <deps> file hashed now (m-2), and the per-run checks' baseline.
      this.proof = {
        activeHashExceptSelector: await hashAlTree(active),
        activeAppJsonSha256: await fileSha256(join(active, "app.json")),
        // R631: the test dir is a USER root: a link refuses rather than hashing a partial tree.
        testDirHash: await hashTestDir(this.cfg.testDir),
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
    const out = await this.compileTarget(dir);
    await rm(out.appPath, { force: true }).catch(() => {});
  }

  async activate(mutantId: string | null): Promise<void> {
    // C2: the rows describe the selector as it was; dropped BEFORE the write.
    this.rowsByCodeunit = new Map();
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
    // The plan is NOT dropped here: keyed by mutant id and read only while that mutant is active,
    // so the R577 reproduction (after the unmutated confirm) runs at the killing call's stop.
    await writeFile(
      join(dir, CONTROL_SELECTOR_FILENAME),
      this.selectorText(proof.artifactId, mutantId),
      "utf8",
    );
    this.lastActivated = mutantId;
  }

  /** §3 step 3 at EVERY `run()`: the bytes v3 will read are the bytes alc proved. */
  private async assertBound(): Promise<void> {
    const proof = this.proof;
    const dir = this.deployedDir;
    if (proof === undefined || dir === undefined) {
      throw new AlRunnerV3UnprovenBatchError("no batch was deployed and proved");
    }
    if ((await hashAlTree(dir)) !== proof.activeHashExceptSelector) {
      throw new AlRunnerV3UnprovenBatchError(`an .al file in ${dir} changed after the alc proof`);
    }
    if ((await fileSha256(join(dir, "app.json"))) !== proof.activeAppJsonSha256) {
      throw new AlRunnerV3UnprovenBatchError(`${dir}/app.json changed after the alc proof`);
    }
    const id = this.lastActivated;
    if (id !== null && !proof.manifestIds.has(id)) {
      throw new AlRunnerV3UnprovenBatchError(`the last activated id ${id} is not in the manifest`);
    }
    const selector = await readFile(join(dir, CONTROL_SELECTOR_FILENAME), "utf8");
    if (selector !== this.selectorText(proof.artifactId, id)) {
      throw new AlRunnerV3UnprovenBatchError(
        `the selector is not the static selector for the last activated id (${id ?? "baseline"})`,
      );
    }
    // R631: a link that appears in the test dir mid-run is drift like any other change.
    const testDirHashNow = await hashTestDir(this.cfg.testDir).catch((err: unknown) => {
      if (err instanceof ProjectSymlinkRefusedError) {
        throw new AlRunnerV3UnprovenBatchError(
          `a link appeared in the test dir after the alc proof (${err.linkPath})`,
        );
      }
      throw err;
    });
    if (testDirHashNow !== proof.testDirHash) {
      throw new AlRunnerV3UnprovenBatchError(
        "an .al file in the test dir changed after the alc proof",
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
    await this.assertBound();
    let call = this.rowsByCodeunit.get(ref.codeunitId);
    if (call === undefined) {
      const made = await this.callCodeunit(ref, opts.timeoutMs);
      if ("verdict" in made) return made.verdict;
      call = made.call;
    }
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
      row.status === "pass" && !row.notRun && this.lastActivated === null
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
    // A covering pass under a mutant: §6.
    // §6 on RAW lines whatever the session's coverage mode (none, or refused for a multi-object
    // or wrapped file): every call requested --coverage-json (`v3CallArgv`).
    if (verdict.outcome === "pass") {
      const index = this.sleepIndex;
      if (index === undefined)
        throw new Error("al-runner-v3: no Sleep index for the deployed batch");
      // I-1: an index that joins no path of the document is not "no hit": the session stops.
      const joinWhy = sleepJoinRefusal(call.coverage, index);
      if (joinWhy !== undefined) throw new AlRunnerV3CoverageJoinError(joinWhy);
      this.batchBlind ??= blindNote(call.coverage, index);
      const note = this.batchBlind ?? sleepPassRefusal(call.coverage, index, row.name);
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
        [CONTROL_SELECTOR_FILENAME, CONTROL_REGISTER_FILENAME, CONTROL_UPGRADE_FILENAME].map(
          normalizeFileKey,
        ),
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
      alRunnerPath: this.cfg.alRunnerPath,
      codeunitId: id,
      stopSeconds,
      packagesDir: resolve(this.cfg.packagesDir),
      bcVersion: this.cfg.bcVersion,
      symbols: this.cfg.preprocessorSymbols ?? [],
      coverageJson: covPath,
      // I-1: the same real paths the Sleep index is keyed by.
      activeDir: this.realDirs?.active ?? resolve(this.activeDir()),
      testDir: this.realDirs?.test ?? resolve(this.cfg.testDir),
    });
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
        ...(this.cfg.cacheDir !== undefined ? { env: { ALRUNNER_CACHE: this.cfg.cacheDir } } : {}),
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
    if (this.lastActivated === null) {
      for (const r of decoded.rows) {
        if (r.notRun && !(r.message !== undefined && V3_TIMEOUT_MESSAGE.test(r.message))) {
          const set = this.baselineRefused.get(id) ?? new Set<string>();
          set.add(r.method);
          this.baselineRefused.set(id, set);
        }
      }
    }
    this.rowsByCodeunit.set(id, call);
    return { call };
  }

  async close(): Promise<void> {
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
