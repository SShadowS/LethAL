import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { emitStaticSelector } from "@lethal/schemata";
import { OneShotTransport, ServerTransport } from "./al-runner-transport";
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

/** al-runner's own per-test timeout message (verified against v1.0.31). */
const RUNNER_TIMEOUT_MESSAGE = /Test exceeded \d+s timeout/;

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
  readonly packagesDir?: string; // --packages symbol resolution
  readonly stubsDir?: string; // --stubs for target-app dependencies
  readonly selectorObjectId: number; // id used when rewriting MutationSelector.Codeunit.al
  // Opt-in: keep one al-runner process warm (server mode) instead of spawning one
  // per test. Off by default until proven verdict-equivalent against a real binary
  // (see the Task 4 live-gate note in the Layer 4.2 plan). Default false.
  readonly serverMode?: boolean;
}

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
    this.transport = cfg.serverMode
      ? new ServerTransport(cfg.alRunnerPath)
      : new OneShotTransport(cfg.alRunnerPath, spawn);
  }

  capabilities(): BackendCapabilities {
    return { coverage: "none", deploy: "none", isolation: "full-reset", authoritative: false };
  }

  async status(): Promise<BackendStatus> {
    // al-runner has no --version flag (it errors out); --help is the
    // verified reachability probe (exits 0).
    const res = await this.spawn([this.cfg.alRunnerPath, "--help"]).catch((e) => ({
      exitCode: -1,
      stdout: "",
      stderr: String(e),
    }));
    return res.exitCode === 0
      ? { ok: true, details: res.stdout.trim() }
      : { ok: false, details: `al-runner not runnable: ${res.stderr}` };
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

  private activeDir(): string {
    return this.deployedDir ?? this.cfg.instrumentedDir;
  }

  async activate(mutantId: string | null): Promise<void> {
    const dir = this.activeDir();
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
      }),
      "utf8",
    );
  }

  async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
    const started = Date.now();
    const res = await this.transport.send({
      sourceDir: this.activeDir(),
      testDir: this.cfg.testDir,
      method: ref.method,
      ...(this.cfg.packagesDir !== undefined ? { packagesDir: this.cfg.packagesDir } : {}),
      ...(this.cfg.stubsDir !== undefined ? { stubsDir: this.cfg.stubsDir } : {}),
      // Deliberately well below `deadlineMs`, never equal: `--test-timeout` bounds
      // only the test body inside al-runner, while `deadlineMs` bounds the WHOLE
      // invocation (al-runner recompiles the project from scratch every call, which
      // alone can take several seconds). If the two were equal or close, our client
      // AbortController would always win the race, the runner-confirmed
      // `outcome: "timeout"` path would be unreachable, and every genuine hang would
      // be misclassified as infrastructure noise (`deadline-exceeded`) instead of a
      // real mutant-induced timeout. Halving the budget (min 1s) gives the runner's
      // own timer real margin to fire first.
      testTimeoutSeconds: Math.max(1, Math.floor(opts.timeoutMs / 2000)),
      deadlineMs: opts.timeoutMs,
    });
    const durationMs = Date.now() - started;
    if (res.kind === "deadline") return { ref, outcome: "deadline-exceeded", durationMs };
    if (res.kind === "skip")
      return { ref, outcome: "skip", durationMs, failureMessage: res.detail };
    if (res.kind === "error")
      return { ref, outcome: "error", durationMs, failureMessage: res.detail };
    const t = res.tests.find((x) => x.name === ref.method);
    if (!t)
      return {
        ref,
        outcome: "error",
        durationMs,
        failureMessage: "al-runner output missing the requested test",
      };
    const runnerTimedOut =
      t.status === "fail" && t.message !== undefined && RUNNER_TIMEOUT_MESSAGE.test(t.message);
    const outcome: TestOutcome = t.status === "pass" ? "pass" : runnerTimedOut ? "timeout" : "fail";
    return {
      ref,
      outcome,
      // Wall-clock, NOT the runner's in-VM figure: the orchestrator derives each
      // mutant's timeout budget from this and must include round-trip cost.
      durationMs,
      ...(t.message !== undefined ? { failureMessage: t.message } : {}),
    };
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}
