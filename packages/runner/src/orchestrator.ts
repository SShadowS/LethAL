import { access, copyFile, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tier1Operators } from "@lethal/builtin-tier1";
import {
  type MutationSpec,
  buildSemanticContext,
  buildSpanIndex,
  initParser,
  parseAL,
  validateSpec,
  visit,
  wrapRoot,
} from "@lethal/engine";
import {
  type InstrumentedFile,
  type MutantManifest,
  type MutantManifestEntry,
  type SelectorConfig,
  writeInstrumentedProject,
} from "@lethal/schemata";
import type { ExecutionBackend, TestMethodRef, TestVerdict } from "./backend";
import { discoverTests } from "./discovery";
import { Semaphore, shardEvenly } from "./pool";
import { buildReport } from "./report";
import type { SessionOutcome, SessionReport } from "./report";
import {
  buildCoverageIndex,
  coverageFilter,
  filterHistory,
  identityKeyOf,
  testKeyOf,
} from "./selection";
import type { ResultsStore } from "./store";
import type { MutantVerdict } from "./store";

const BASELINE_TIMEOUT_DEFAULT = 120_000;

/**
 * Parse every `.al` file under `projectDir` (skipping emitted `Mutation*`
 * artifacts) and run the Tier 1 operator set over each. Mirrors the
 * ops -> compile -> write pipeline exercised by
 * `packages/builtin-tier1/tests/end-to-end.test.ts`: build a per-file
 * semantic context, walk the tree, and collect every spec each operator
 * targets. Overlap resolution isn't needed here (or anywhere downstream
 * post-Layer-4.3): overlapping mutants coalesce into one flat dispatch chain
 * at compile time (`compileSchemataForFile`), so every spec this returns runs
 * behind its own guard in the same single instrumented artifact.
 */
export async function generateMutationSet(projectDir: string): Promise<InstrumentedFile[]> {
  await initParser();
  const files: InstrumentedFile[] = [];
  const entries = (await readdir(projectDir, { recursive: true }))
    .filter((e) => e.toLowerCase().endsWith(".al"))
    .filter((e) => !basename(e).startsWith("Mutation"));
  for (const rel of entries.sort()) {
    const source = await readFile(join(projectDir, rel), "utf8");
    const root = wrapRoot(parseAL(source));
    const ctx = buildSemanticContext([{ path: rel, root }]);
    // Built once per file (not per spec): a per-spec tree walk here would be
    // O(specs x nodes) on a file with many mutation sites. See
    // `buildSpanIndex`'s doc comment in @lethal/engine.
    const spanIndex = buildSpanIndex(root);
    const specs: MutationSpec[] = [];
    visit(root, (node) => {
      for (const op of tier1Operators) {
        if (op.targets(node, ctx)) {
          for (const spec of op.generate(node, ctx)) {
            // Reject specs whose `before` isn't a real node in this file's
            // tree — coalescing (Layer 4.3) relies on mutation sites being
            // laminar, which a synthetic multi-node span could violate.
            const validation = validateSpec(spec, root, spanIndex);
            if (validation.ok) {
              specs.push(spec);
            } else {
              console.warn(
                `[lethal] rejected mutation spec from operator "${spec.operatorName}" ` +
                  `(before span ${spec.before.startIndex}..${spec.before.endIndex}): ${validation.error}`,
              );
            }
          }
        }
      }
    });
    if (specs.length > 0) files.push({ path: rel, source, root, specs });
  }
  return files;
}

export interface SessionConfig {
  readonly backend: ExecutionBackend;
  readonly store: ResultsStore;
  readonly projectDir: string; // target AL project (source of truth)
  readonly testDir: string;
  readonly instrumentedDir: string; // scratch output dir for schemata writes
  readonly selectorIds: SelectorConfig;
  readonly baselineTimeoutMs?: number; // default 120000
  readonly skipKnownSurvivors?: boolean;
  readonly appVersion?: string; // stamped into runs; default "0.0.0.0"
  readonly workers?: number; // default 1 — a pool of one IS the sequential path
  readonly compileConcurrency?: number; // default min(workers, 4)
  /** Required when workers > 1: each worker needs its own backend instance. */
  readonly backendFactory?: (workerIndex: number) => ExecutionBackend;
}

/** Alias kept for readability at call sites within this module. */
type SessionVerdict = MutantVerdict;

/**
 * Splits the full set of instrumented files into compile artifacts. Layer
 * 4.3 collapsed overlap batching, so today this is trivial — one artifact
 * holding everything, since overlapping mutants coalesce into flat dispatch
 * chains at compile time instead of needing separate compiles. Kept as a
 * single named seam (rather than inlined at each call site) so a future
 * size-budget / compile-failure-bisection split (Task 6, design spec §6) has
 * exactly one place to change, and so `cli.ts`'s dry-run batch count can
 * never drift from what `runSession` actually deploys.
 *
 * Zero files (no mutable sites anywhere in the project) yields zero
 * artifacts, not one empty artifact — there is nothing to compile or deploy,
 * so `runSession`'s artifact loop must never execute in that case (no
 * pointless deploy, no baseline run, no app.json requirement).
 */
export function planArtifacts(
  files: readonly InstrumentedFile[],
): readonly (readonly InstrumentedFile[])[] {
  return files.length === 0 ? [] : [files];
}

export async function runSession(cfg: SessionConfig): Promise<SessionReport> {
  const caps = cfg.backend.capabilities();
  const status = await cfg.backend.status();
  if (!status.ok) throw new Error(`backend not ready: ${status.details}`);

  // NOTE: a prior preflight here scanned [Test] codeunit sources for
  // `TestIsolation = Function;` and aborted session-isolation backends when
  // it was missing. That was factually wrong: `TestIsolation` is a
  // TestRunner-codeunit property in real BC (AL0223 if set on a
  // `Subtype = Test` codeunit) and cannot be verified by scanning test
  // sources — it's chosen by whichever TestRunner codeunit invokes the
  // tests. Removed; isolation is a TestRunner-side concern verified out of
  // band, not something Layer 4 checks.

  const tests = await discoverTests(cfg.testDir);
  if (tests.length === 0) throw new Error("no tests discovered");

  const runId = cfg.store.createRun({
    projectPath: cfg.projectDir,
    backend: caps.authoritative ? "bcdev" : "al-runner",
    appVersion: cfg.appVersion ?? "0.0.0.0",
  });

  const allFiles = await generateMutationSet(cfg.projectDir);
  const artifacts = planArtifacts(allFiles);

  const outcomes: SessionOutcome[] = []; // internal accumulation for the report
  let baselineGreenOverall = true;
  // Math.floor: a fractional workers value (e.g. 2.5) would otherwise reach
  // shardEvenly's `Array.from({ length: n }, ...)`, which silently truncates
  // to a shorter array than `i % n` can index into — mutants landing on the
  // missing fractional index are dropped with no error (shardEvenly's own
  // `if (target !== undefined)` guard swallows them).
  const workers = Math.max(1, Math.floor(cfg.workers ?? 1));
  // Bounds compile-heavy deploy() calls independently of worker count: alc is
  // CPU-bound, so worker count (mutant concurrency) must not silently become
  // compile concurrency.
  const compileLimit = new Semaphore(cfg.compileConcurrency ?? Math.min(workers, 4));
  // Built ONCE for the whole session, never per batch: each worker owns one
  // backend instance (its own instrumented dir and, for al-runner, its own
  // server process) that is reused across every batch and disposed exactly
  // once in the `finally` below. Constructing a fresh set per batch would
  // leak batches × workers instances/processes instead of `workers`.
  //
  // Pushed one at a time rather than built via `Array.from` in one
  // expression: a real factory (Task 7's) does directory/process setup that
  // can throw partway through — e.g. factory(2) fails after factory(0) and
  // factory(1) already spun up. Array.from would discard everything built so
  // far along with the throw, leaking those already-constructed instances
  // since the `finally` below only ever sees whatever `workerBackends` was
  // last assigned. Pushing into a pre-declared array means the ones built
  // before the failure are still visible to (and disposed by) the `finally`.
  const workerBackends: ExecutionBackend[] = [];

  try {
    if (workers > 1) {
      const factory = cfg.backendFactory;
      if (factory === undefined) {
        throw new Error("runSession: workers > 1 requires backendFactory");
      }
      for (let i = 0; i < workers; i++) {
        workerBackends.push(factory(i));
      }
    }
    for (const [batchIdx, batchFiles] of artifacts.entries()) {
      // 1. write the instrumented project for this artifact — currently
      // always every file `generateMutationSet` found (single artifact); a
      // future bisection split (Task 6) would make `artifacts` hold more
      // than one element here. `batchIdx` MUST come from `.entries()`, not a
      // hoisted constant: `batchDir`'s naming, `app.json`'s version stamp,
      // and every `MutantOutcome.batchIndex` all key off it, and a hoisted
      // `0` would silently collide/mis-attribute the moment `artifacts` ever
      // holds more than one element.
      const batchDir = join(cfg.instrumentedDir, `run-${runId}-batch-${batchIdx}`);
      await writeInstrumentedProject({
        targetDir: batchDir,
        files: batchFiles,
        selectorIds: cfg.selectorIds,
      });
      const manifest = JSON.parse(
        await readFile(join(batchDir, "mutant-manifest.json"), "utf8"),
      ) as MutantManifest;

      // 1b. app.json + full source set — unconditionally, since even
      // in-memory backends may need a project manifest. writeInstrumentedProject
      // only wrote files that had >=1 mutant spec in THIS batch (see
      // packages/schemata/src/project.ts), so alc would fail to compile the
      // batch dir without the rest of the project's `.al` files.
      await prepareBatchProject(cfg.projectDir, batchDir, batchIdx, runId);

      // 2. history filter
      const prior = cfg.store.priorSurvivorKeys(cfg.projectDir);
      const { execute, knownSurvivors } = filterHistory([...manifest.mutants], prior, {
        skipKnownSurvivors: cfg.skipKnownSurvivors ?? false,
      });
      for (const m of knownSurvivors)
        record(cfg.store, runId, m, "known-survivor", outcomes, batchIdx);

      // 3. deploy — always, even for in-memory backends: they need the
      // per-batch instrumented dir just as much as a publishing backend
      // needs the compiled app. `capabilities().deploy` still describes
      // publish cost for callers, it just no longer gates this call.
      try {
        await cfg.backend.deploy(batchDir);
      } catch (err) {
        for (const m of execute)
          record(cfg.store, runId, m, "error", outcomes, batchIdx, undefined, String(err));
        continue; // batch aborted, next batch still attempted
      }

      // 4. baseline
      await activateWithRetry(cfg.backend, null);
      const baseline: Array<{ ref: TestMethodRef; verdict: TestVerdict }> = [];
      for (const ref of tests) {
        const v = await runWithRetry(cfg.backend, ref, {
          coverage: caps.coverage,
          timeoutMs: cfg.baselineTimeoutMs ?? BASELINE_TIMEOUT_DEFAULT,
        });
        // Baseline test results are not tied to any mutant: mutant_row_id stays NULL.
        cfg.store.recordTestResult(
          runId,
          null,
          null,
          ref,
          v.outcome,
          v.durationMs,
          v.failureMessage,
        );
        baseline.push({ ref, verdict: v });
      }
      const greenTests = baseline.filter((b) => b.verdict.outcome === "pass");
      if (greenTests.length < baseline.length) baselineGreenOverall = false;
      if (greenTests.length === 0) {
        for (const m of execute) {
          record(
            cfg.store,
            runId,
            m,
            "error",
            outcomes,
            batchIdx,
            undefined,
            "no green baseline tests",
          );
        }
        continue;
      }
      const baselineDuration = new Map(
        greenTests.map((b) => [testKeyOf(b.ref), b.verdict.durationMs]),
      );

      // 5. coverage filter (capability-gated)
      let perMutantTests: ReadonlyMap<string, readonly TestMethodRef[]>;
      let uncovered: readonly MutantManifestEntry[] = [];
      if (caps.coverage === "none") {
        perMutantTests = new Map(execute.map((m) => [m.mutantId, greenTests.map((b) => b.ref)]));
      } else {
        const index = buildCoverageIndex(
          greenTests.map((b) => ({
            ref: b.ref,
            ...(b.verdict.coverage !== undefined ? { coverage: b.verdict.coverage } : {}),
          })),
        );
        const split = coverageFilter(
          execute,
          index,
          greenTests.map((b) => b.ref),
        );
        perMutantTests = split.covered;
        uncovered = split.uncovered;
      }
      for (const m of uncovered) record(cfg.store, runId, m, "no-coverage", outcomes, batchIdx);

      // 6. per-mutant loop — sharded across workers when workers > 1. The
      // baseline/coverage discovery above always runs once against
      // cfg.backend; only the kill-detection phase below fans out, since
      // that's the part that's actually per-mutant work.
      const fallbackTimeoutMs = cfg.baselineTimeoutMs ?? BASELINE_TIMEOUT_DEFAULT;
      if (workers === 1) {
        // Sequential IS the parallel path with a pool of one: this is the
        // exact same runMutantsOnBackend call the fan-out branch below makes
        // per shard, just with all of `execute` as a single "shard" on the
        // one backend already deployed in step 3.
        await runMutantsOnBackend({
          backend: cfg.backend,
          mutants: execute,
          perMutantTests,
          baselineDuration,
          fallbackTimeoutMs,
          store: cfg.store,
          runId,
          batchIndex: batchIdx,
          outcomes,
        });
      } else {
        const shards = shardEvenly(execute, workers);
        // allSettled, not all: if one shard throws (e.g. the I7 two-
        // consecutive-transport-errors abort), `Promise.all` would reject
        // immediately and return control to the caller WHILE sibling shards
        // are still mid-flight — they'd keep calling record()/
        // recordTestResult() on a store the caller may already have closed.
        // Waiting for every shard to settle first means the store is
        // quiescent before the failure is ever rethrown below.
        const settled = await Promise.allSettled(
          shards.map(async (shard, i) => {
            if (shard.length === 0) return;
            const backend = workerBackends[i];
            if (backend === undefined) return; // defensive: shards.length === workerBackends.length
            // Mirror the sequential deploy try/catch above (step 3), but NOT
            // verbatim: step 3 runs BEFORE step 5's coverage filter, so
            // iterating all of `execute` there is correct — nothing has been
            // recorded yet. This catch runs AFTER step 5, and `shard` (a
            // slice of `execute`) still includes mutants step 5 already
            // recorded as `no-coverage`. Skipping those here (same
            // `perMutantTests.get(...) === undefined` guard
            // `runMutantsOnBackend` uses) avoids double-recording an
            // uncovered mutant as `error` too — `mutants` has no unique
            // constraint on (run_id, mutant_code), so a duplicate INSERT
            // would corrupt the report silently rather than fail loudly.
            try {
              await compileLimit.run(() => backend.deploy(batchDir));
            } catch (err) {
              for (const m of shard) {
                if (perMutantTests.get(m.mutantId) === undefined) continue; // already recorded no-coverage
                record(cfg.store, runId, m, "error", outcomes, batchIdx, undefined, String(err));
              }
              return;
            }
            await runMutantsOnBackend({
              backend,
              mutants: shard,
              perMutantTests,
              baselineDuration,
              fallbackTimeoutMs,
              store: cfg.store,
              runId,
              batchIndex: batchIdx,
              outcomes,
            });
          }),
        );
        const firstRejection = settled.find(
          (r): r is PromiseRejectedResult => r.status === "rejected",
        );
        if (firstRejection !== undefined) throw firstRejection.reason;
      }
    }
  } finally {
    // Best-effort cleanup: deliberately swallow errors here (unlike the
    // retrying activation calls above) since this only runs to leave every
    // backend deactivated on exit, and a failure here must not mask/replace
    // whatever real error is already propagating.
    await cfg.backend.activate(null).catch(() => {});
    for (const backend of workerBackends) {
      await backend.activate(null).catch(() => {});
      await closeIfSupported(backend).catch(() => {});
    }
  }

  cfg.store.finishRun(runId, {
    batchCount: artifacts.length,
    baselineGreen: baselineGreenOverall,
  });
  // Sort accumulated outcomes so report ordering never depends on which
  // worker finished first — determinism must not hinge on scheduling.
  // Compare (file, startIndex) as (string, number), not a colon-joined
  // string: localeCompare on "file:1000" vs "file:99" sorted ":1000" before
  // ":99" (lexical compare of the numeric suffix), scrambling report order
  // for any file with 100+ mutable start offsets.
  outcomes.sort(
    (a, b) =>
      a.mutant.file.localeCompare(b.mutant.file) || a.mutant.startIndex - b.mutant.startIndex,
  );
  return buildReport({
    caps,
    baselineGreen: baselineGreenOverall,
    batches: artifacts.length,
    outcomes,
  });
}

/**
 * Worker backends are constructed by `backendFactory` inside `runSession`
 * (unlike `cfg.backend`, which the CALLER constructs and is responsible for
 * — see `cli.ts`'s `instanceof BcDevMcpBackend`/`AlRunnerBackend` close
 * calls), so `runSession` itself owns disposing them. `ExecutionBackend`
 * doesn't declare a `close()` method (not every backend needs one — the
 * in-memory ones don't), so this duck-types rather than importing concrete
 * backend classes, keeping the orchestrator decoupled from any specific
 * backend implementation.
 */
async function closeIfSupported(backend: ExecutionBackend): Promise<void> {
  const maybeCloseable = backend as { close?: () => Promise<void> };
  if (typeof maybeCloseable.close === "function") {
    await maybeCloseable.close();
  }
}

/**
 * The per-mutant kill-detection loop, extracted so that `workers = 1` (one
 * shard containing every mutant, run on `cfg.backend`) and `workers > 1`
 * (N shards, each on its own backend from `backendFactory`) are the exact
 * same code path — there is one session implementation, not two that can
 * drift out of sync with each other.
 *
 * `outcomes` and `store` are shared across concurrent invocations when
 * `workers > 1`; that's safe because `Array.push` and the `bun:sqlite` calls
 * inside `record`/`recordTestResult` are all synchronous within this single
 * process, so interleaving different mutants' async awaits never races on
 * them.
 */
async function runMutantsOnBackend(args: {
  readonly backend: ExecutionBackend;
  readonly mutants: readonly MutantManifestEntry[];
  readonly perMutantTests: ReadonlyMap<string, readonly TestMethodRef[]>;
  readonly baselineDuration: ReadonlyMap<string, number>;
  readonly fallbackTimeoutMs: number;
  readonly store: ResultsStore;
  readonly runId: number;
  readonly batchIndex: number;
  readonly outcomes: SessionOutcome[];
}): Promise<void> {
  for (const m of args.mutants) {
    const covering = args.perMutantTests.get(m.mutantId);
    if (covering === undefined) continue; // uncovered, already recorded above
    if (covering.length === 0) {
      // Defensive: the covering-test list resolved to zero refs (e.g. a
      // coverage index key whose tests no longer exist in `greenTests`).
      // Treat it the same as "no coverage" rather than silently
      // reporting "survived" for a mutant nothing actually ran against.
      record(args.store, args.runId, m, "no-coverage", args.outcomes, args.batchIndex);
      continue;
    }
    await activateWithRetry(args.backend, m.mutantId);
    let verdict: SessionVerdict = "survived";
    let killingTest: string | undefined;
    let failureNote: string | undefined;
    let cause: "deadline-exceeded" | "unstable" | undefined;
    let spent = 0;
    // mutant_row_id isn't known until recordMutant() runs below (the
    // verdict — and thus the recordMutant call — only lands AFTER this
    // loop finishes), so buffer this mutant's test-result rows here and
    // flush them once record() returns the row id.
    const testResultBuffer: Array<{
      mutantCode: string | null;
      ref: TestMethodRef;
      outcome: TestVerdict["outcome"];
      durationMs: number;
      failureMessage: string | undefined;
    }> = [];
    let transportErrorRef: TestMethodRef | undefined;
    for (const ref of covering) {
      const budget = 2 * (args.baselineDuration.get(testKeyOf(ref)) ?? args.fallbackTimeoutMs);
      const v = await runWithRetry(args.backend, ref, { coverage: "none", timeoutMs: budget });
      testResultBuffer.push({
        mutantCode: m.mutantId,
        ref,
        outcome: v.outcome,
        durationMs: v.durationMs,
        failureMessage: v.failureMessage,
      });
      spent += v.durationMs;
      if (v.outcome === "deadline-exceeded") {
        // Our timer, not the runner's: says nothing about the mutant.
        verdict = "error";
        failureNote = `deadline exceeded running ${ref.method} (infrastructure, not a kill)`;
        cause = "deadline-exceeded";
        break;
      }
      if (v.outcome === "timeout") {
        verdict = "timeout-killed";
        killingTest = ref.method;
        break;
      }
      if (v.outcome === "error") {
        // runWithRetry already retried once internally — reaching "error"
        // here means the backend failed transport for this test TWICE in
        // a row. Spec §11: that aborts the whole session, not just this
        // mutant (unlike the "unstable test" error path below, which is a
        // legitimate flakiness finding, not a transport failure).
        verdict = "error";
        failureNote = v.failureMessage;
        transportErrorRef = ref;
        break;
      }
      if (v.outcome === "fail") {
        await activateWithRetry(args.backend, null);
        const confirm = await runWithRetry(args.backend, ref, {
          coverage: "none",
          timeoutMs: budget,
        });
        testResultBuffer.push({
          mutantCode: null,
          ref,
          outcome: confirm.outcome,
          durationMs: confirm.durationMs,
          failureMessage: confirm.failureMessage,
        });
        if (confirm.outcome === "pass") {
          verdict = "killed";
          killingTest = ref.method;
        } else if (confirm.outcome === "deadline-exceeded") {
          // Our timer, not the runner's, fired during confirmation — infrastructure,
          // not evidence the test is flaky. Must not inflate counts.unstable.
          verdict = "error";
          failureNote = `deadline exceeded confirming ${ref.method} (infrastructure, not a kill)`;
          cause = "deadline-exceeded";
        } else {
          verdict = "error";
          failureNote = `unstable test ${ref.method}: fails at baseline confirmation`;
          cause = "unstable";
        }
        break;
      }
    }
    const mutantRowId = record(
      args.store,
      args.runId,
      m,
      verdict,
      args.outcomes,
      args.batchIndex,
      killingTest,
      failureNote,
      cause,
      spent,
    );
    for (const t of testResultBuffer) {
      args.store.recordTestResult(
        args.runId,
        mutantRowId,
        t.mutantCode,
        t.ref,
        t.outcome,
        t.durationMs,
        t.failureMessage,
      );
    }
    if (transportErrorRef !== undefined) {
      throw new Error(
        `backend transport error: two consecutive run() failures for mutant ${m.mutantId} ` +
          `(test ${transportErrorRef.method}) — aborting session per spec §11: ${failureNote ?? ""}`,
      );
    }
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Spec §5: the instrumented app must keep the target app's id and
 * version-bump per batch (`1.0.<runId>.<batchIdx>`), and must contain every
 * project source file so `alc` can actually compile it — not just the
 * files `writeInstrumentedProject` wrote for this batch's mutants.
 *
 * Version ordering is `run` THEN `batch`, and that order is load-bearing:
 * BC refuses to publish an app version lower than the one already installed
 * ("Cannot install the extension ... because a newer version N was already
 * installed" — verified live). The original spec scheme `1.0.<batch>.<run>`
 * is non-monotonic ACROSS runs: run 5's batch 0 (1.0.0.5) is lower than run
 * 4's batch 2 (1.0.2.4), so every run after the first failed to deploy any
 * batch below the previous run's highest batch index. `runId` comes from the
 * results DB and strictly increases, so `1.0.<runId>.<batchIdx>` increases
 * both within a run and across runs.
 *
 * Throws (aborting the whole session, uncaught by the per-batch deploy
 * try/catch below) if the target project has no `app.json` — there's no
 * sane per-batch fallback for a structurally uncompilable target.
 */
async function prepareBatchProject(
  projectDir: string,
  batchDir: string,
  batchIdx: number,
  runId: number,
): Promise<void> {
  const appJsonPath = join(projectDir, "app.json");
  let raw: string;
  try {
    raw = await readFile(appJsonPath, "utf8");
  } catch (err) {
    throw new Error(
      `cannot deploy batch ${batchIdx}: target project has no app.json at ${appJsonPath} ` +
        `(required for alc to compile the instrumented app) — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `cannot deploy batch ${batchIdx}: ${appJsonPath} is not valid JSON — ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  manifest.version = `1.0.${runId}.${batchIdx}`;
  await writeFile(join(batchDir, "app.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  // writeInstrumentedProject only wrote files with >=1 mutant spec in this
  // batch; copy every other project source file verbatim (files whose sites
  // landed in a different batch, or that have no mutable sites at all) so
  // the batch dir holds the FULL project alc needs to compile.
  const entries = (await readdir(projectDir, { recursive: true })).filter((e) =>
    e.toLowerCase().endsWith(".al"),
  );
  for (const rel of entries) {
    const dest = join(batchDir, basename(rel));
    if (await pathExists(dest)) continue;
    await copyFile(join(projectDir, rel), dest);
  }
}

/**
 * One retry on activation failure; if the retry also fails, the error
 * propagates and aborts the session (the `finally` in `runSession` still
 * attempts a best-effort deactivation, and results recorded so far remain
 * persisted in the store since they're written incrementally).
 */
async function activateWithRetry(
  backend: ExecutionBackend,
  mutantId: string | null,
): Promise<void> {
  try {
    await backend.activate(mutantId);
  } catch {
    await backend.activate(mutantId);
  }
}

async function runWithRetry(
  backend: ExecutionBackend,
  ref: TestMethodRef,
  opts: { coverage: "none" | "procedure" | "line"; timeoutMs: number },
): Promise<TestVerdict> {
  const first = await backend.run(ref, opts);
  if (first.outcome !== "error") return first;
  return backend.run(ref, opts); // one retry on transport error, then the error stands
}

/**
 * Records a mutant's verdict and returns the `mutants.id` row id SQLite
 * assigned it. `mutant_code` (e.g. "M0007") is only unique WITHIN a batch —
 * `assignMutantIds` restarts numbering per batch — so `mutant_row_id` is the
 * only unambiguous way to tie a `test_results` row back to a specific mutant
 * across a whole run (see I5).
 */
function record(
  store: ResultsStore,
  runId: number,
  m: MutantManifestEntry,
  verdict: MutantVerdict,
  outcomes: SessionOutcome[],
  batchIndex: number,
  killingTest?: string,
  failureNote?: string,
  cause?: "deadline-exceeded" | "unstable",
  durationMs = 0,
): number {
  const key = identityKeyOf(m);
  const mutantRowId = store.recordMutant(runId, {
    mutantCode: m.mutantId,
    astHash: key.astHash,
    codeunitName: key.codeunitName,
    operatorName: key.operatorName,
    operatorMajor: key.operatorMajor,
    file: m.file,
    line: m.startLine,
    verdict,
    durationMs,
    ...(killingTest !== undefined ? { killingTest } : {}),
  });
  outcomes.push({
    mutant: m,
    verdict,
    batchIndex,
    ...(killingTest !== undefined ? { killingTest } : {}),
    ...(failureNote !== undefined ? { failureNote } : {}),
    ...(cause !== undefined ? { cause } : {}),
  });
  return mutantRowId;
}
