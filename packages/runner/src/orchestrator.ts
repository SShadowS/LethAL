import { access, copyFile, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
import { nextAbove, parseVersionConflict, reserveAppVersion } from "./app-version";
import { AlcCompileError } from "./artifact";
import type { CompiledArtifact } from "./artifact";
import type { ExecutionBackend, TestMethodRef, TestVerdict } from "./backend";
import { bisectFailingMutant } from "./bisect";
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
  // createRun placeholder only (default "0.0.0.0") — after a successful deploy the run row is
  // corrected via store.recordArtifact with the version actually compiled (reserveAppVersion).
  readonly appVersion?: string;
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
 * size-budget split has exactly one place to change, and so `cli.ts`'s
 * dry-run batch count can never drift from what `runSession` actually
 * deploys.
 *
 * Compile-failure bisection (Task 6, design spec §6) did NOT end up needing
 * this to return more than one artifact: a bad spec is narrowed down WITHIN
 * a single artifact's deploy-failure handler (see `narrowFilesToSubset` and
 * the `bisectFailingMutant` call in `runSession`'s deploy catch), by
 * re-instrumenting a scratch directory holding a subset of that artifact's
 * specs, not by asking `planArtifacts` to pre-split anything.
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

/**
 * Rebuilds an artifact's `InstrumentedFile[]` restricted to a subset of
 * manifest entries. `planArtifacts` only ever splits at FILE granularity —
 * every mutant in an artifact shares one `InstrumentedFile[]` — but a compile
 * failure is usually one bad spec in one file, so `bisectFailingMutant`
 * (halving `MutantManifestEntry[]`) needs to halve a single file's *specs*,
 * not whole files. This is that regrouping: it does not derive from
 * `assignMutantIds` (which would renumber ids for a narrower set and drift
 * from the ids `subset` actually names), it matches each entry back to its
 * originating `MutationSpec` structurally, via (file, before span, operator)
 * — the same triple `writeInstrumentedProject` used to produce `subset`'s
 * entries in the first place, so a match is unambiguous within one artifact.
 *
 * A file whose specs all fall outside `subset` is dropped from the result
 * entirely (matching `writeInstrumentedProject`'s own "only write files with
 * >=1 spec" behavior) — `prepareBatchProject` still copies it into the
 * artifact dir verbatim, uninstrumented, same as any other no-mutant file.
 *
 * The (file, span, operator) key has no STRUCTURAL uniqueness guarantee — it
 * holds today only because every Tier 1 operator emits at most one spec per
 * node. If an operator ever emits two variants for the same node, the two
 * specs collide on this key and a subset entry meant to name ONE of them
 * silently matches both, coarsening bisection. Assert loudly instead.
 */
export function narrowFilesToSubset(
  files: readonly InstrumentedFile[],
  subset: readonly MutantManifestEntry[],
): InstrumentedFile[] {
  const specKey = (file: string, spec: MutationSpec) =>
    `${file}\0${spec.before.startIndex}\0${spec.before.endIndex}\0${spec.operatorName}`;
  const wanted = new Set(
    subset.map((m) => `${m.file}\0${m.startIndex}\0${m.endIndex}\0${m.operatorName}`),
  );
  const seen = new Set<string>();
  const out: InstrumentedFile[] = [];
  for (const f of files) {
    for (const spec of f.specs) {
      const key = specKey(f.path, spec);
      if (seen.has(key)) {
        throw new Error(
          `narrowFilesToSubset: duplicate spec key — two specs collide on (${f.path}, ${spec.before.startIndex}..${spec.before.endIndex}, ${spec.operatorName}); the (file, span, operator) triple can no longer identify a single mutant, so bisection narrowing would silently include both`,
        );
      }
      seen.add(key);
    }
    const specs = f.specs.filter((spec) => wanted.has(specKey(f.path, spec)));
    if (specs.length > 0) out.push({ ...f, specs });
  }
  return out;
}

/**
 * 128 cryptographically random bits as 32 lowercase hex characters — the ONLY id shape
 * `DeploymentVerifier.verify` accepts (it throws on anything else, by design). Generated fresh
 * per artifact write, never derived from `runId` or any other session state, never reused: two
 * artifacts sharing an id would make identity verification unable to tell them apart, which is
 * the entire failure mode Layer 5A exists to close.
 */
function newArtifactId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Uniform error-message extraction: `parseVersionConflict` must see BC's text whether the
 *  backend threw a `DeploymentError` (whose message embeds the publish error verbatim), a
 *  plain `Error`, or a bare string. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Writes one instrumented artifact into `targetDir`. Shared by the initial
 * per-artifact write (step 1 below) and by every bisection attempt
 * (sequential and per-shard) — one artifact-preparation sequence, not
 * several that can drift apart.
 *
 * Always `rm`s `targetDir` first: bisection reuses the SAME scratch
 * directory across many candidate subsets, and a file that dropped out of a
 * narrower subset would otherwise leave its previous, more-instrumented
 * write behind — a stale compile input the next `compiles()` check never
 * actually asked for. Harmless for the initial write too, since `targetDir`
 * there is always a fresh `run-<runId>-batch-<batchIdx>` path.
 *
 * `subset` omitted means "every spec in `files`" (the artifact's initial,
 * unnarrowed write); given, `files` is regrouped down to just those specs
 * via `narrowFilesToSubset` before writing.
 */
async function prepareArtifactDir(args: {
  readonly targetDir: string;
  readonly files: readonly InstrumentedFile[];
  readonly subset?: readonly MutantManifestEntry[];
  readonly selectorIds: SelectorConfig;
  readonly projectDir: string;
  readonly projectManifest: Readonly<Record<string, unknown>>;
  readonly appVersion: string;
  readonly artifactId: string;
}): Promise<void> {
  await rm(args.targetDir, { recursive: true, force: true });
  const files =
    args.subset === undefined ? args.files : narrowFilesToSubset(args.files, args.subset);
  await writeInstrumentedProject({
    targetDir: args.targetDir,
    files,
    selectorIds: args.selectorIds,
    artifactId: args.artifactId,
  });
  await prepareBatchProject(args.projectDir, args.targetDir, args.projectManifest, args.appVersion);
}

/**
 * Distinguishes "preparing the candidate artifact failed" (a filesystem/
 * instrumentation problem on OUR side) from "the candidate artifact failed
 * to compile" — only the latter may steer the bisection search. Without
 * this, an fs error inside `prepareArtifactDir` is indistinguishable from
 * a compile failure and silently corrupts the narrowing.
 */
class BisectPrepareError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "BisectPrepareError";
  }
}

/**
 * Bisects `subsetMutants` against a `deploy`-shaped compile check, reusing
 * `scratchDir` for every candidate via `prepareArtifactDir`. Shared by the
 * sequential deploy-failure path (step 3) and every worker shard's own
 * deploy-failure path (`workers > 1`, step 6) — same algorithm and the same
 * artifact-preparation helper, just a different mutant subset and a
 * different backend/compile-limit to deploy through.
 *
 * `scratchDir` is removed once bisection finishes, win or lose — a failed
 * batch must not leave a scratch artifact behind on disk indefinitely.
 */
async function bisectAndNote(args: {
  readonly subsetMutants: readonly MutantManifestEntry[];
  readonly scratchDir: string;
  readonly batchFiles: readonly InstrumentedFile[];
  readonly selectorIds: SelectorConfig;
  readonly projectDir: string;
  readonly projectManifest: Readonly<Record<string, unknown>>;
  readonly appVersion: string;
  readonly artifactId: string;
  // Compile-only (Task 7b, spec §8): bisection's only question is whether alc accepts a
  // source subset. Must never publish — candidates share one appVersion/artifactId across a
  // whole search (see prepareArtifactDir's `args.artifactId`/`args.appVersion` above), so a
  // publishing backend would reject every candidate after the first as a version conflict, and
  // publishing a narrowed candidate to a live server violates spec §8 regardless.
  readonly compileCheck: (dir: string) => Promise<void>;
  readonly originalErr: unknown;
}): Promise<string> {
  try {
    const outcome = await bisectFailingMutant(args.subsetMutants, async (subset) => {
      try {
        await prepareArtifactDir({
          targetDir: args.scratchDir,
          files: args.batchFiles,
          subset,
          selectorIds: args.selectorIds,
          projectDir: args.projectDir,
          projectManifest: args.projectManifest,
          appVersion: args.appVersion,
          artifactId: args.artifactId,
        });
      } catch (err) {
        // NOT a compile answer — abort the search rather than feeding it a
        // false "this subset doesn't compile".
        throw new BisectPrepareError(err);
      }
      try {
        await args.compileCheck(args.scratchDir);
        return true;
      } catch (err) {
        // Only a deterministic alc rejection may be read as "this subset does not compile".
        // A publish/verification failure (DeploymentError), an fs/spawn problem
        // (ArtifactPrepareError), or anything else propagating out of `compileCheck` here is NOT
        // a compile answer — resolving `false` for it would send the search halving the mutant
        // set chasing a problem that has nothing to do with any mutant, and could converge on
        // (and name) an innocent one. Let it abort the search instead.
        if (!(err instanceof AlcCompileError)) throw err;
        return false;
      }
    });
    switch (outcome.kind) {
      case "no-repro":
        return String(args.originalErr);
      case "environmental":
        return `deploy failed for a reason that is not attributable to any mutant (${outcome.detail}) — likely environmental (e.g. app-version monotonicity, transport, licence): ${String(args.originalErr)}`;
      case "culprit":
        return `compile failed; bisected to mutant ${outcome.culprit.mutantId} (${outcome.culprit.file}:${outcome.culprit.startLine} ${outcome.culprit.operatorName}), confirmed: fails alone, complement compiles`;
    }
  } catch (err) {
    if (err instanceof BisectPrepareError) {
      return `${String(args.originalErr)} (bisection aborted: preparing a candidate artifact failed — ${err.message})`;
    }
    throw err;
  } finally {
    await rm(args.scratchDir, { recursive: true, force: true }).catch(() => {});
  }
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
  // Session-scoped: threads each reserved app version into the next reservation so versions
  // stay strictly increasing within one session even when the clock doesn't advance (or a
  // conflict retry re-stamped above something newer than the clock would produce).
  let lastIssuedVersion: string | undefined;

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
      // always every file `generateMutationSet` found (single artifact).
      // `batchIdx` MUST come from `.entries()`, not a hoisted constant:
      // `batchDir`'s naming, `app.json`'s version stamp, and every
      // `MutantOutcome.batchIndex` all key off it, and a hoisted `0` would
      // silently collide/mis-attribute the moment `artifacts` ever holds
      // more than one element (e.g. a future size-budget split).
      const batchDir = join(cfg.instrumentedDir, `run-${runId}-batch-${batchIdx}`);
      // 1a. reserve this artifact's app version. Major/minor come from the target project's
      // OWN app.json (never hardcoded — a 2.x project must not be forced under a 1.0
      // ceiling); build/revision are clock-derived (see app-version.ts). The reservation is
      // wrapped so an out-of-range or malformed app.json version aborts the session with an
      // error naming the actual input, before anything is written or compiled.
      const projectManifest = await readProjectManifest(cfg.projectDir, batchIdx);
      const sourceVersion = projectManifest.version;
      if (typeof sourceVersion !== "string") {
        throw new Error(
          `cannot deploy batch ${batchIdx}: app.json version must be a string, got ` +
            `${JSON.stringify(sourceVersion)}`,
        );
      }
      let appVersion: string;
      try {
        appVersion = reserveAppVersion({
          sourceVersion,
          nowMs: Date.now(),
          ...(lastIssuedVersion !== undefined ? { lastIssued: lastIssuedVersion } : {}),
        });
      } catch (err) {
        throw new Error(
          `cannot deploy batch ${batchIdx}: app.json version "${sourceVersion}" cannot seed a ` +
            `valid BC app version — ${messageOf(err)}`,
        );
      }
      lastIssuedVersion = appVersion;
      // Per ARTIFACT, not per session: planArtifacts retains the ability to split, and two
      // artifacts must never share an identity (see newArtifactId).
      const artifactId = newArtifactId();
      // 1b (app.json + full source set) is folded into `prepareArtifactDir`:
      // even in-memory backends may need a project manifest, and
      // `writeInstrumentedProject` only writes files that have >=1 mutant
      // spec in THIS artifact (see packages/schemata/src/project.ts), so alc
      // would fail to compile the batch dir without the rest of the
      // project's `.al` files.
      await prepareArtifactDir({
        targetDir: batchDir,
        files: batchFiles,
        selectorIds: cfg.selectorIds,
        projectDir: cfg.projectDir,
        projectManifest,
        appVersion,
        artifactId,
      });
      const manifest = JSON.parse(
        await readFile(join(batchDir, "mutant-manifest.json"), "utf8"),
      ) as MutantManifest;

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
      let compiled: CompiledArtifact | null = null;
      let deployed = false;
      let deployErr: unknown;
      try {
        compiled = await cfg.backend.deploy(batchDir);
        deployed = true;
      } catch (err) {
        deployErr = err;
      }
      if (!deployed) {
        // 3a. version conflict: BC's downgrade rejection is machine-parseable and names the
        // installed version verbatim. Re-stamp strictly above it, recompile, and retry
        // EXACTLY once — a second conflict means the server's installed version is moving
        // underneath us, and that must fail the session loudly, not loop.
        const installed = parseVersionConflict(messageOf(deployErr));
        if (installed !== null) {
          const bumped = nextAbove(installed);
          lastIssuedVersion = bumped;
          appVersion = bumped;
          await writeStampedAppJson(batchDir, projectManifest, bumped);
          try {
            compiled = await cfg.backend.deploy(batchDir);
            deployed = true;
          } catch (retryErr) {
            const stillInstalled = parseVersionConflict(messageOf(retryErr));
            if (stillInstalled !== null) {
              throw new Error(
                `version conflict persisted after retry: re-stamped to ${bumped} above BC's ` +
                  `reported ${installed}, but publish was rejected again naming ` +
                  `${stillInstalled} — ${messageOf(retryErr)}`,
              );
            }
            deployErr = retryErr;
          }
        }
      }
      if (!deployed) {
        // 3b. A publish/verification failure is environmental: catalog conflict, schema sync,
        // dependency mismatch, license, transport, NST limits. Attributing it to a mutant would
        // be unsound, and republishing subset artifacts to diagnose it can leave a narrowed
        // candidate installed. Only a deterministic alc rejection (AlcCompileError) is
        // bisectable — everything else (DeploymentError, ArtifactPrepareError, a bare
        // string/Error from some other failure) aborts the session instead of being fed into
        // bisection (design §5; §6 restricts bisection to compile verdicts specifically).
        // `DeploymentError` and `ArtifactPrepareError` both extend `Error` directly, not
        // `AlcCompileError` — `instanceof` cannot cross-match them, so this guard alone is
        // sufficient to exclude both.
        if (!(deployErr instanceof AlcCompileError)) throw deployErr;
        // 3c. Layer 4.3 put every mutant in one artifact (design spec §6): one
        // malformed spec now fails this ONE compile and would otherwise turn
        // every mutant `execute` holds into an equally uninformative "error"
        // with nothing pointing at the actual cause. Bisect before giving
        // up, via the same `prepareArtifactDir`/`bisectAndNote` helpers the
        // per-worker shard catch below reuses: `bisectFailingMutant` halves
        // `manifest.mutants` — the FULL set this batch's artifact was
        // compiled from, not `execute` — against re-instrumented,
        // re-deployed scratch subsets until a single offending mutant is
        // isolated, or the narrowing stops reproducing the failure, in
        // which case there's nothing more specific to report than the
        // original error. `execute` (post-history-filter) would be wrong
        // here: known survivors are excluded from `execute` but are STILL
        // compiled into the artifact, so a malformed known-survivor mutant
        // would break this compile while being provably unfindable by a
        // search restricted to `execute`. History filtering is an
        // execution decision, not a compilation decision.
        const note = await bisectAndNote({
          subsetMutants: manifest.mutants,
          scratchDir: join(cfg.instrumentedDir, `run-${runId}-batch-${batchIdx}-bisect`),
          batchFiles,
          selectorIds: cfg.selectorIds,
          projectDir: cfg.projectDir,
          projectManifest,
          appVersion,
          artifactId: newArtifactId(),
          compileCheck: (dir) => cfg.backend.compileCheck(dir),
          originalErr: deployErr,
        });
        for (const m of execute)
          record(cfg.store, runId, m, "error", outcomes, batchIdx, undefined, note);
        continue; // batch aborted, next batch still attempted
      }
      // 3d. provenance: correct the run row with what was ACTUALLY compiled and deployed —
      // createRun could only write a placeholder. Backends with no compiled artifact
      // (deploy: "none") have no artifact provenance to record; their run row keeps the
      // caller-supplied appVersion.
      if (compiled !== null) {
        cfg.store.recordArtifact(runId, {
          appVersion: compiled.appVersion,
          appId: compiled.appId,
          artifactId: compiled.artifactId,
          sha256: compiled.sha256,
        });
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
              // Same session-abort rule as the sequential path (3b): only a deterministic alc
              // rejection (AlcCompileError) is bisectable. A DeploymentError, an
              // ArtifactPrepareError, or anything else is never a compile verdict, so it must
              // not be bisected or downgraded to per-mutant errors here either — it aborts the
              // whole session.
              if (!(err instanceof AlcCompileError)) throw err;
              // Same "one bad mutant, uninformative errors" problem as the
              // sequential path above applies here identically — bisect
              // this worker's own deploy failure the same way. Searches the
              // FULL manifest, not just `shard`: every worker deploys the
              // SAME `batchDir` (the whole artifact, every mutant, not a
              // shard-scoped subset — sharding only decides which worker
              // EXECUTES which mutant's tests), so a compile failure any
              // worker observes here is a property of the whole artifact,
              // and the true culprit need not be one of THIS worker's own
              // shard's mutants. Recording below still stays scoped to
              // `shard` (this worker's own mutants) — only the SEARCH scope
              // widened, not which mutants get marked "error". Each worker
              // gets its own scratch dir (suffixed by `i`) so concurrently
              // bisecting shards never race on the same directory.
              const note = await bisectAndNote({
                subsetMutants: manifest.mutants,
                scratchDir: join(
                  cfg.instrumentedDir,
                  `run-${runId}-batch-${batchIdx}-bisect-worker-${i}`,
                ),
                batchFiles,
                selectorIds: cfg.selectorIds,
                projectDir: cfg.projectDir,
                projectManifest,
                appVersion,
                artifactId: newArtifactId(),
                // Keep the compileLimit wrapper: it bounds concurrent alc processes, which is
                // exactly what bisection candidates are — compileCheck doesn't change that.
                compileCheck: (dir) => compileLimit.run(() => backend.compileCheck(dir)),
                originalErr: err,
              });
              for (const m of shard) {
                if (perMutantTests.get(m.mutantId) === undefined) continue; // already recorded no-coverage
                record(cfg.store, runId, m, "error", outcomes, batchIdx, undefined, note);
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
 * Reads and parses the target project's `app.json`. Throws (aborting the
 * whole session, uncaught by the per-batch deploy try/catch) if it is
 * missing or malformed — there's no sane per-batch fallback for a
 * structurally uncompilable target.
 */
async function readProjectManifest(
  projectDir: string,
  batchIdx: number,
): Promise<Record<string, unknown>> {
  const appJsonPath = join(projectDir, "app.json");
  let raw: string;
  try {
    raw = await readFile(appJsonPath, "utf8");
  } catch (err) {
    throw new Error(
      `cannot deploy batch ${batchIdx}: target project has no app.json at ${appJsonPath} ` +
        `(required for alc to compile the instrumented app) — ${messageOf(err)}`,
    );
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `cannot deploy batch ${batchIdx}: ${appJsonPath} is not valid JSON — ${messageOf(err)}`,
    );
  }
}

/**
 * Stamps the batch dir's `app.json` as the target manifest with `version` replaced. Shared by
 * `prepareBatchProject` (initial stamp with the reserved version) and the version-conflict
 * retry in `runSession` (re-stamp above the installed version BC named) so the two writes
 * can never drift in shape.
 */
async function writeStampedAppJson(
  batchDir: string,
  projectManifest: Readonly<Record<string, unknown>>,
  version: string,
): Promise<void> {
  const manifest = { ...projectManifest, version };
  await writeFile(join(batchDir, "app.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/**
 * Spec §5: the instrumented app must keep the target app's id, carry the
 * per-artifact version reserved via `reserveAppVersion` (app-version.ts —
 * clock-derived, monotonic across runs with no stored counter; the old
 * `1.0.<runId>.<batchIdx>` scheme died with its dependence on a persistent
 * results DB), and must contain every project source file so `alc` can
 * actually compile it — not just the files `writeInstrumentedProject` wrote
 * for this batch's mutants.
 */
async function prepareBatchProject(
  projectDir: string,
  batchDir: string,
  projectManifest: Readonly<Record<string, unknown>>,
  appVersion: string,
): Promise<void> {
  await writeStampedAppJson(batchDir, projectManifest, appVersion);

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
    ...(failureNote !== undefined ? { failureNote } : {}),
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
