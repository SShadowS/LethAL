import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CONTROL_REGISTER_FILENAME,
  CONTROL_UPGRADE_FILENAME,
  emitStaticSelector,
} from "@lethal/schemata";
import { OneShotTransport, qualifiedTestName } from "./al-runner-transport";
import type { AlRunnerTransport } from "./al-runner-transport";
import type { CompiledArtifact } from "./artifact";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  RunOpts,
  TestMethodRef,
  TestOutcome,
  TestVerdict,
} from "./backend";
import { defaultSpawn } from "./publisher";
import type { SpawnFn } from "./publisher";

/**
 * al-runner's own per-test timeout message — BOTH wordings it has used, because the wording is not
 * stable and we have watched it move.
 *
 * Measured, all on this machine: v1.0.31 said `status: "fail"` with `Test exceeded <n>s timeout`.
 * al-runner **2.0.0.0** said `status: "error"` with `TIMEOUT after <n>s`. al-runner **2.0.1.0**,
 * published the same day and installed hours later, went back to `Test exceeded <n>s timeout.` while
 * KEEPING `status: "error"`. So neither the status nor the text is a stable key on its own, and the
 * union of two literals is a stopgap rather than a design — see `AL_RUNNER_UNCLASSIFIED_ERROR` for
 * the part that does not depend on guessing the wording right.
 *
 * Exported for the R123 wire-contract probe (`al-runner-contract.ts`), which times a real test out
 * on purpose and checks the wording it gets back against THIS regex rather than against a copy of
 * it. A probe with its own spelling could pass while the decode below failed — the two would be
 * measuring different things, which is the one outcome that makes the probe worse than nothing.
 */
export const RUNNER_TIMEOUT_MESSAGE = /TIMEOUT after \d+s|Test exceeded \d+s timeout/;

/**
 * Prefix on the `failureMessage` of an al-runner `status: "error"` this build could not classify.
 *
 * Exported so a test can pin the behaviour by NAME rather than by quoting the sentence, and so a
 * reader meeting one in a report can grep for where it came from. The verdict such a run produces is
 * `error` — not measured — never `fail`; see `run()` for why that asymmetry is the whole design.
 */
export const AL_RUNNER_UNCLASSIFIED_ERROR =
  "al-runner reported an error this build cannot classify";

/**
 * v2 answers `--version` with `al-runner v2.0.0.0` and exit 0 (measured 2026-08-07). v1.0.31
 * REJECTED `--version` outright, so a binary that fails this check is either v1 or not al-runner.
 *
 * Exported for the same reason as `RUNNER_TIMEOUT_MESSAGE`: the R123 contract probe measures the
 * binary's own `--version` and must accept exactly what `status()` accepts. Two spellings of "is
 * this a v2" would let one of them go stale without the other noticing.
 */
export const AL_RUNNER_V2_VERSION = /\bv2\.\d/;

/** The actionable half of `status()`'s refusal — what is wrong and what to do about it. */
const AL_RUNNER_V2_REQUIRED =
  "This adapter targets al-runner v2: it sends --isolation/--test/--package-cache and " +
  'positional bundle dirs, which v1 rejects, and reads v2\'s "TIMEOUT after <n>s" shape. ' +
  "Install al-runner v2, or use --backend bcdev.";

/**
 * `mutant-manifest.json` is written by `writeInstrumentedProject` for every
 * real batch, but some fixtures (e.g. `al-runner-backend.test.ts`'s synthetic
 * source dirs) hand-build a directory with only `MutationSelector.Codeunit.al`
 * and no manifest at all. A missing manifest (Node's `ENOENT`) is the ONLY
 * thing tolerated here — it falls back to "", a harmless no-identity default
 * since nothing keys off it except `MutationControl_Identity`, added in this
 * same task.
 *
 * Everything else — corrupt JSON, a manifest with a missing/wrong-typed
 * `artifactId`, or a read failure that ISN'T "file doesn't exist" (e.g. the
 * EBUSY/EPERM Windows lock hazard `deploy()` already retries around, see its
 * comment below) — must fail loudly. Swallowing those would let a broken
 * manifest produce a *successful* deploy with `exit('')` baked into every
 * activation and `MutationControl_Identity` silently returning "" — exactly
 * the silent-wrong-verdict shape this project keeps guarding against, once a
 * later task starts comparing that value against something.
 */
async function readArtifactId(dir: string): Promise<string> {
  const manifestPath = join(dir, "mutant-manifest.json");
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw new Error(
      `readArtifactId: could not read ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `readArtifactId: ${manifestPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const artifactId =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { artifactId?: unknown }).artifactId
      : undefined;
  if (typeof artifactId !== "string") {
    throw new Error(
      `readArtifactId: ${manifestPath} has no string "artifactId" field (got ${JSON.stringify(artifactId)})`,
    );
  }
  return artifactId;
}

export interface AlRunnerConfig {
  readonly alRunnerPath: string; // path to the al-runner executable
  readonly instrumentedDir: string; // schemata output (LethAL-owned scratch)
  readonly testDir: string;
  readonly packagesDir?: string; // --package-cache symbol resolution
  readonly selectorObjectId: number; // id used when rewriting MutationSelector.Codeunit.al
  /**
   * REFUSED on v2 — the constructor throws when this is true. Kept as a field, rather than
   * dropped, precisely so a config that still asks for it gets told why instead of having the
   * request silently ignored. See the constructor for the R97 measurement.
   */
  readonly serverMode?: boolean;
}

/**
 * Why `serverMode` is refused, in the message a caller actually sees.
 *
 * Exported so the refusal test pins it by NAME rather than by quoting a sentence that would then
 * exist in two places and drift.
 *
 * The ORIGINAL reason (R97, measured 2026-08-05 on 2.0.0.0) was that the server's `runTests` read
 * only `sourcePaths[0]`, so the test bundle never ran and every mutant scored SURVIVED off an
 * empty green result. **That is fixed.** Re-measured 2026-08-08 against al-runner 2.1.0.0:
 * `sourcePaths: [sourceDir, testDir]` runs BOTH bundles and answers `total: 2, passed: 2` on
 * `fixtures/sandbox-app` + `fixtures/sandbox-tests`.
 *
 * Two NEW, measured reasons replaced it, and neither is an upstream defect:
 *
 * 1. **The server has no per-test selection.** The CLI takes `--test <qualified>` and runs exactly
 *    that one test; the server ran the WHOLE suite under every field name a caller could plausibly
 *    send (`testFilter`, `filter`, `test`, `tests`, `testName`, `pattern` — all six ignored, all
 *    six returned `total: 2`). `ExecutionBackend.run()` is called once per TEST, so server mode
 *    would execute T tests for each of the T calls that make up one mutant: quadratic where the
 *    CLI is linear. Warm-process speed does not pay for that on any suite big enough to care.
 * 2. **The response shape moved and is no longer the envelope this repo decoded.** 2.1.0.0 streams
 *    one `{"type":"test",...}` line per test and then one
 *    `{"type":"summary","exitCode":0,"passed":2,...,"protocolVersion":2}` line. The old decoder read
 *    ONE line and looked for a `tests` array, so on the current binary it would have produced an
 *    empty list from the first per-test line — this project's signature bug, now sitting in our
 *    code rather than upstream's.
 *
 * So the transport that decoded the old envelope is DELETED rather than carried: a branch nothing
 * runs, against a protocol nothing speaks, is a lie waiting to happen (R93's own argument for
 * deleting the v1 path). Server mode becomes worth revisiting when the backend interface can make
 * ONE call per mutant instead of one per test — filed as R126.
 */
export const AL_RUNNER_SERVER_MODE_REFUSED =
  "AlRunnerBackend: serverMode is not supported. al-runner 2.1.0.0's server protocol runs the " +
  "WHOLE suite per runTests (no per-test selection under any field name — measured), while this " +
  "backend's run() is called once per test, so server mode is quadratic where the CLI's --test " +
  "filter is linear. Its response shape also moved to streaming per-test JSON lines plus a " +
  'summary line, which the transport this repo carried could not read. Remove "serverMode" ' +
  "from the alRunner config section to use the one-shot transport (R97, R126).";

export class AlRunnerBackend implements ExecutionBackend {
  // Set by deploy(); until then (or if deploy() is never called — existing
  // callers may drive activate()/run() directly against cfg.instrumentedDir)
  // activeDir() falls back to the statically configured instrumented dir.
  private deployedDir: string | undefined;
  private readonly transport: AlRunnerTransport;

  constructor(
    private readonly cfg: AlRunnerConfig,
    private readonly spawn: SpawnFn = defaultSpawn,
  ) {
    // R97, re-measured 2026-08-08 against al-runner 2.1.0.0. The upstream defect this refusal
    // was FIRST built for (server reads only sourcePaths[0]) is fixed; two measured reasons of
    // our own replaced it. See AL_RUNNER_SERVER_MODE_REFUSED for both, and for why the
    // ServerTransport that decoded the old envelope was deleted rather than repaired.
    if (cfg.serverMode === true) {
      throw new Error(AL_RUNNER_SERVER_MODE_REFUSED);
    }
    this.transport = new OneShotTransport(cfg.alRunnerPath, spawn);
  }

  /**
   * `isolation: "full-reset"` is honest only because the transport actually sends
   * `--isolation test` (see OneShotTransport.send) — v2's mode that gives every [Test] fresh
   * state. Do not claim it back if that flag ever changes.
   *
   * `authoritative: false` stays false, but NOT for the reason this comment used to give. The
   * two measured al-runner defects it named — R7 (`asserterror I := 1;`, a statement that cannot
   * raise, reported `pass`) and R8 (a table object's own global not surviving a trigger write
   * back into a later call on the same record variable) — are FIXED on v2 (R99, measured against
   * v2.0.0.0). `runAlRunnerCanary` re-measures both every session rather than trusting either
   * this comment or that one.
   *
   * What still makes this backend non-authoritative is architectural, and v2 does not close it:
   * there is no BC service tier, so there are no transactions — `Commit()` and `Rollback()` are
   * no-ops, `StartSession` runs inline instead of in a separate session, and the base
   * application's tables are empty (upstream `docs/limitations.md`). A mutant whose only
   * observable effect is on any of those is judged against semantics that are not BC's. Combined
   * with `coverage: "none"` — no per-procedure coverage, so nothing here can narrow which tests
   * matter — a verdict from this backend is a fast signal, not a result to act on. bcdev remains
   * the authority.
   */
  capabilities(): BackendCapabilities {
    return { coverage: "none", deploy: "none", isolation: "full-reset", authoritative: false };
  }

  async status(): Promise<BackendStatus> {
    // v2 HAS `--version` (prints `al-runner v2.0.0.0`, exit 0, measured 2026-08-07); v1.0.31
    // rejected it with `Error: file or directory not found: --version` and a non-zero exit,
    // which is why this probe used to be `--help`. Probing with `--version` therefore answers
    // two questions at once: is the binary runnable, and is it the version this adapter speaks?
    // That second question is not cosmetic — this adapter sends v2-only argv
    // (`--isolation test`, `--test`, `--package-cache`, positional bundle dirs) and reads v2's
    // timeout shape, so pointed at v1 it would produce wrong verdicts rather than an error.
    const res = await this.spawn([this.cfg.alRunnerPath, "--version"]).catch((e) => ({
      exitCode: -1,
      stdout: "",
      stderr: String(e),
    }));
    if (res.exitCode !== 0) {
      return { ok: false, details: `al-runner not runnable: ${res.stderr || res.stdout}` };
    }
    const reported = (res.stdout || res.stderr).trim();
    if (!AL_RUNNER_V2_VERSION.test(reported)) {
      return {
        ok: false,
        details: `al-runner at ${this.cfg.alRunnerPath} reports "${reported.slice(0, 200)}", which is not a v2 build. ${AL_RUNNER_V2_REQUIRED}`,
      };
    }
    return { ok: true, details: reported };
  }

  async deploy(instrumentedDir: string): Promise<CompiledArtifact | null> {
    // In-memory backends have no publish step, but they still need to know
    // which per-batch instrumented dir activate()/run() should target.
    //
    // Task 7 (parallel workers): the orchestrator calls deploy() with the
    // SAME shared per-batch instrumented dir on every worker's backend
    // instance — the batch's compiled source is identical for all of them
    // (see runSession's shard fan-out in orchestrator.ts, which passes one
    // `batchDir` to every worker). `activate()` below is a plain,
    // unsynchronized `writeFile` into whatever `activeDir()` resolves to; if
    // every worker's `deployedDir` pointed straight at that shared directory,
    // two workers running concurrently could overwrite each other's
    // MutationSelector.Codeunit.al mid-compile — al-runner recompiles from
    // this directory on every invocation — silently attributing a test
    // result to the wrong mutant. Copying the shared, read-only batch
    // content into a private subdirectory of this backend's own
    // `cfg.instrumentedDir` (unique per worker — see cli.ts's `buildBackend`)
    // means every subsequent activate()/run() call only ever touches a
    // directory this instance alone writes to. Harmless for the sequential
    // (workers=1) path too: one backend, one copy, same observable result.
    //
    // Deliberately a SUBDIRECTORY of `cfg.instrumentedDir`, not
    // `cfg.instrumentedDir` itself: some callers (e.g. `al-runner.itest.ts`)
    // construct this backend with `cfg.instrumentedDir` set to the SAME path
    // `SessionConfig.instrumentedDir` uses for the orchestrator's own batch
    // dirs, making the given `instrumentedDir` argument a CHILD of
    // `cfg.instrumentedDir` — `cp(child, parent)` landed the copy incomplete
    // (verified: broke the itest's baseline-green assertion). Copying into a
    // fixed, uniquely-named child (`active`) of `cfg.instrumentedDir` instead
    // is never an ancestor of whatever batch dir the argument names, however
    // the caller happened to lay out its scratch directories.
    // `cp` MERGES into an existing destination rather than replacing it —
    // stale files from a previous batch's deploy() would otherwise survive
    // into this one. Harmless today only because `prepareBatchProject`
    // copies the full project source set every batch, so the file-name set
    // happens to stay stable across batches — nothing enforces that, and if
    // it ever didn't, the symptom would be a wrong verdict (a stale mutant's
    // instrumentation silently still active), not a visible error. Clearing
    // first removes that dependency on an invariant this method has no way
    // to verify.
    const activeDir = join(this.cfg.instrumentedDir, "active");
    // maxRetries/retryDelay: fs.rm defaults to 0 retries. On Windows,
    // deleting a directory a warm al-runner process, an indexer, or an AV
    // scanner still holds open is a known EBUSY/EPERM flake — a few quick
    // retries ride out that window instead of failing the whole deploy.
    await rm(activeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    await cp(instrumentedDir, activeDir, { recursive: true });
    // al-runner uses the static selector and never talks to LethAL Control; the target's
    // control-registration codeunits reference `LC Control State` and would fail al-runner's
    // dependency-free compile. Drop them (design §D). Force: synthetic fixtures may lack them.
    for (const f of [CONTROL_REGISTER_FILENAME, CONTROL_UPGRADE_FILENAME]) {
      await rm(join(activeDir, f), { force: true });
    }
    this.deployedDir = activeDir;
    // Early, LOUD validation of the batch just deployed: a corrupt manifest must fail
    // deploy() itself, not surface only when a later activate() happens to read it. The
    // value is deliberately not cached — activate() re-reads from activeDir() so the
    // no-deploy path (activate()/run() driven straight against cfg.instrumentedDir) bakes
    // that directory's REAL artifact id instead of a stale empty default.
    await readArtifactId(activeDir);
    // In-memory backend: nothing is compiled or published, so there is no artifact to
    // describe — the orchestrator records provenance only for publishing backends.
    return null;
  }

  /**
   * al-runner has no separate publish step — `deploy()` is a local file copy, and the actual
   * `alc` invocation happens lazily inside `run()`, per test. So there is nothing bisection's
   * compile-only seam needs to withhold here: delegating to the existing `deploy()` is the
   * compile-only behaviour for this backend, not a stand-in for it.
   */
  async compileCheck(instrumentedDir: string): Promise<void> {
    await this.deploy(instrumentedDir);
  }

  private activeDir(): string {
    return this.deployedDir ?? this.cfg.instrumentedDir;
  }

  async activate(mutantId: string | null): Promise<void> {
    const dir = this.activeDir();
    // Belt-and-suspenders for the documented no-deploy path (deploy() never called, dir ===
    // cfg.instrumentedDir): deploy() already strips these when it runs, but a caller driving
    // activate()/run() straight against cfg.instrumentedDir would otherwise still have the
    // control-registration codeunits sitting there when run() lazily compiles. Idempotent and
    // force: harmless when deploy() already removed them, or when a fixture never had them.
    for (const f of [CONTROL_REGISTER_FILENAME, CONTROL_UPGRADE_FILENAME]) {
      await rm(join(dir, f), { force: true });
    }
    await writeFile(
      join(dir, "MutationSelector.Codeunit.al"),
      emitStaticSelector({
        objectId: this.cfg.selectorObjectId,
        activeId: mutantId ?? "",
        // Read lazily from the directory this activation actually rewrites (see deploy()):
        // a fixed instance field captured at deploy time baked "" over the real id whenever
        // activate() ran without a prior deploy() — the exact no-deploy path the class
        // comment above promises to support. Behavior change from that fixed-field version:
        // a corrupt/malformed manifest in the no-deploy path now makes activate() itself
        // throw (readArtifactId's loud-failure contract, see its doc comment) instead of
        // silently baking in "". That's an improvement — the earlier version's whole point
        // was never surfacing this — but it means activate() can now reject where it never
        // used to for this specific (no prior deploy(), bad manifest) combination.
        artifactId: await readArtifactId(dir),
        // Task 8 added TargetAppId() to the selector for parity with the dynamic emitter (both
        // MUST expose the identical procedure set — see emitStaticSelector's doc comment). This
        // backend's own Active() check never reads it — it's the self-contained, no-control-
        // dependency selector — so "" is harmless here. Nothing currently threads a real
        // targetAppId into AlRunnerConfig or the manifest this reads from; wire that up if a
        // future caller ever needs TargetAppId() to return a real value for this backend.
        targetAppId: "",
      }),
      "utf8",
    );
  }

  async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
    const started = Date.now();
    // ONE name for both the `--test` filter and the lookup below — see qualifiedTestName.
    const wanted = qualifiedTestName(ref.codeunitId, ref.method);
    const res = await this.transport.send({
      sourceDir: this.activeDir(),
      testDir: this.cfg.testDir,
      qualifiedTest: wanted,
      ...(this.cfg.packagesDir !== undefined ? { packagesDir: this.cfg.packagesDir } : {}),
      // Deliberately well below `deadlineMs`, never equal. The runner's own per-test budget
      // (v2: the AL_RUNNER_TEST_TIMEOUT_SEC env var the transport sets; v1: a `--test-timeout`
      // flag) bounds only the test body inside al-runner, while `deadlineMs` bounds the WHOLE
      // invocation (al-runner recompiles the project from scratch every call, which alone can
      // take several seconds). If the two were equal or close, our client AbortController
      // would always win the race, the runner-confirmed `outcome: "timeout"` path would be
      // unreachable, and every genuine hang would be misclassified as infrastructure noise
      // (`deadline-exceeded`) instead of a real mutant-induced timeout. Halving the budget
      // (min 1s) gives the runner's own timer real margin to fire first. The v2 move from a
      // flag to an env var changed how this value is delivered, not why it is halved.
      testTimeoutSeconds: Math.max(1, Math.floor(opts.timeoutMs / 2000)),
      deadlineMs: opts.timeoutMs,
    });
    const durationMs = Date.now() - started;
    if (res.kind === "deadline") return { ref, outcome: "deadline-exceeded", durationMs };
    if (res.kind === "error")
      return {
        ref,
        outcome: "error",
        durationMs,
        failureMessage: res.detail,
        operation: "pre-dispatch-rejected",
      };
    const t = res.tests.find((x) => x.name === wanted);
    if (!t)
      return {
        ref,
        outcome: "error",
        durationMs,
        // Naming both sides: a mismatch here means the runner ran something other than what
        // we asked for, and "missing the requested test" alone left nobody able to see which.
        failureMessage: `al-runner output has no test named "${wanted}" (it returned: ${
          res.tests.map((x) => x.name).join(", ") || "<no tests>"
        })`,
        operation: "pre-dispatch-rejected",
      };
    // How a non-pass becomes a verdict, and the rule is FAIL-CLOSED on purpose.
    //
    // `fail` is al-runner's word for "the test's own assertion went red", so it is a kill.
    // `error` is its word for several different things — a timeout it enforced, and (per its own
    // `RunnerOutOfScopeException`) a test that reached SMTP, outbound HTTP, printing, external file
    // I/O or web-service publishing, which v2 now raises on instead of faking a return value.
    //
    // Only ONE of those is a verdict about the mutant. So an `error` we can positively classify as
    // a timeout scores `timeout` (the orchestrator reads that as `timeout-killed`), and an `error`
    // we CANNOT classify scores `outcome: "error"` — not measured — rather than falling through to
    // `fail` and crediting the suite with a kill it did not earn.
    //
    // That asymmetry is the point, and it is what makes this survive the next release. al-runner
    // ships several times a day: within one session we measured the timeout wording as
    // `TIMEOUT after <n>s` on 2.0.0.0 and back to `Test exceeded <n>s timeout.` on 2.0.1.0, hours
    // apart. Under the old rule — anything not `pass` and not matching the regex is `fail` — that
    // single string change silently turned every hung mutant into a KILL. Under this one the same
    // change costs a mutant its verdict and says so out loud, which is the direction this project
    // is willing to be wrong in. R94, and R93's argument that a measured contract beats a
    // version-branched decode matrix.
    if (t.status === "pass") {
      return { ref, outcome: "pass", durationMs };
    }
    const outcome: TestOutcome =
      t.status === "fail"
        ? "fail"
        : t.message !== undefined && RUNNER_TIMEOUT_MESSAGE.test(t.message)
          ? "timeout"
          : "error";
    return {
      ref,
      outcome,
      // Wall-clock, NOT the runner's in-VM figure: the orchestrator derives each
      // mutant's timeout budget from this and must include round-trip cost.
      durationMs,
      ...(outcome === "error"
        ? {
            failureMessage: `${AL_RUNNER_UNCLASSIFIED_ERROR}: al-runner reported status ${JSON.stringify(
              t.status,
            )} for ${wanted} with message ${JSON.stringify(t.message ?? "<none>")}. That is not an assertion failure, so it is NOT scored as a kill; if this is a timeout whose wording changed again, add it to RUNNER_TIMEOUT_MESSAGE.`,
            // Nothing ran that could leave state behind — al-runner is a fresh process per call and
            // touches no live container — so this is retry-safe rather than a tier hazard.
            operation: "pre-dispatch-rejected" as const,
          }
        : t.message !== undefined
          ? { failureMessage: t.message }
          : {}),
    };
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}
