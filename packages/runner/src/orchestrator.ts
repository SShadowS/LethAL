import { access, copyFile, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
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
  canCarryMutationSelectorVar,
  describeObjectKinds,
  writeInstrumentedProject,
} from "@lethal/schemata";
import { nextAbove, parseVersionConflict, reserveAppVersion } from "./app-version";
import { AlcCompileError, ArtifactPrepareError, DeploymentError } from "./artifact";
import type { CompiledArtifact } from "./artifact";
import type { ExecutionBackend, TestMethodRef, TestVerdict } from "./backend";
import { bisectFailingMutant } from "./bisect";
import { discoverTests } from "./discovery";
import { ActivationFailure } from "./failure-classes";
import { LeaseUnavailableError, MAX_ATTEMPT_ID_LENGTH, MAX_TTL_SECONDS } from "./lease";
import type { AcquireOutcome, Lease, LeaseApi } from "./lease";
import { isRetrySafe, requiresUnsafeLatch } from "./operation-outcome";
import {
  type PermissionCanaryResult,
  describeTestPermissionsRefusal,
  permissionCanaryWarnings,
} from "./permission-canary";
import { Semaphore, shardEvenly } from "./pool";
import { QuarantineStore } from "./quarantine-store";
import { buildReport } from "./report";
import type { NotInstrumentedFile, SessionOutcome, SessionReport } from "./report";
import { quarantineResourceKey } from "./resource-key";
import {
  buildCoverageIndex,
  coverageFilter,
  filterHistory,
  identityKeyOf,
  testKeyOf,
} from "./selection";
import { SessionSafety, SessionUnsafeError } from "./session-safety";
import type { ResultsStore } from "./store";
import type { MutantVerdict } from "./store";

const BASELINE_TIMEOUT_DEFAULT = 120_000;

/**
 * Floor for a mutant run's time budget.
 *
 * The budget is `2 x` the test's baseline duration, which is far too tight for a
 * fast test: measured live, the same test through the same fence took 1872ms on
 * its first (cold) call and ~95ms warm. A baseline measured warm yields a ~190ms
 * budget, so the first cold execution in the mutant loop aborts — and an abort is
 * not a retry here, it becomes an `in-flight-unknown`, a durable tier quarantine
 * and an aborted session.
 *
 * The budget's job is catching a runaway mutant, not enforcing performance, so a
 * floor that absorbs a cold start costs nothing real.
 */
export const MIN_MUTANT_BUDGET_MS = 30_000;

/**
 * Tier of every currently registered operator, keyed by name — the mapping
 * `writeInstrumentedProject` needs to resolve Tier-2 narrowings of a Tier-1
 * operator (`dedupeSpecs` in `@lethal/schemata`). Built once from the same
 * `tier1Operators` import `generateMutationSet` walks, so a mutant's identity
 * after dedup can never diverge between the two — see `manifestMutants` in
 * `orchestrator.test.ts` for a caller that leans on that parity.
 */
export const operatorTiers: ReadonlyMap<string, 1 | 2 | 3 | "custom"> = new Map(
  tier1Operators.map((op) => [op.name, op.tier]),
);

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
 *
 * Files whose object kind cannot carry the selector var are dropped here, with one warning per
 * run. A mutation guard is a bare `MutationSelector.Active(...)` call, which needs a
 * `var MutationSelector: Codeunit "Mutation Selector";` in scope, and only a codeunit or a table
 * can carry that declaration today (`canCarryMutationSelectorVar` / `injectMutationSelectorVar`
 * in @lethal/schemata). A real project routinely holds a page with `OnAction`/`OnOpenPage`
 * bodies, and the tier-1 operators target those bodies happily — so without this filter one such
 * page aborts the whole session at compile time. Dropping the specs costs only those mutants:
 * `prepareBatchProject` copies every project `.al` file the instrumented write did not produce
 * into the batch dir verbatim, so the page still reaches the server, byte-identical to source.
 *
 * R5: the console warning alone left no trace in the REPORT — a page-heavy project got a
 * confident-looking mutation score computed over whatever fraction of its code happened to be
 * codeunits/tables, with nothing in the output saying so. The skipped-file list and the total
 * `.al` file count scanned are now returned alongside `files` so `runSession` can thread them
 * into `SessionReport.notInstrumented` (report.ts) — present in both the console render and the
 * `--out` JSON, not just stderr.
 */
export interface MutationSetResult {
  readonly files: readonly InstrumentedFile[];
  /** Files with >=1 spec that no selector var could be injected into — see doc comment above. */
  readonly skipped: readonly NotInstrumentedFile[];
  /** Every `.al` source file scanned (excluding emitted `Mutation*` artifacts) — the denominator
   *  for judging how much of the project `skipped` represents. */
  readonly totalFiles: number;
}

export async function generateMutationSet(projectDir: string): Promise<MutationSetResult> {
  await initParser();
  const files: InstrumentedFile[] = [];
  /** Files with >=1 spec that no selector var can be injected into — reported once, below. */
  const skipped: NotInstrumentedFile[] = [];
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
    if (specs.length === 0) continue;
    if (!canCarryMutationSelectorVar(root)) {
      skipped.push({ file: rel, kinds: describeObjectKinds(root), sites: specs.length });
      continue;
    }
    files.push({ path: rel, source, root, specs });
  }
  if (skipped.length > 0) {
    const total = skipped.reduce((n, s) => n + s.sites, 0);
    const detail = skipped.map((s) => `${s.file} (${s.kinds}, ${s.sites} site(s))`).join(", ");
    const why =
      "only a codeunit or a table can carry the injected " +
      '`var MutationSelector: Codeunit "Mutation Selector";` declaration, so a guard in any ' +
      "other object kind cannot compile (AL0118). Not mutated; published unchanged";
    console.warn(
      `[lethal] skipped ${skipped.length} file(s) holding ${total} mutation site(s): ${why}: ${detail}.`,
    );
  }
  return { files, skipped, totalFiles: entries.length };
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
  // createRun placeholder only. For an authoritative (publishing) backend, a successful deploy
  // corrects the run row via store.recordArtifact with the version actually compiled
  // (reserveAppVersion) — this value never survives past that point. For a deploy:"none" backend
  // (al-runner), deploy() never returns a CompiledArtifact (see AlRunnerBackend.deploy's doc
  // comment), so recordArtifact never fires and THIS is what durably lands in the row;
  // runSession falls back to the project's own app.json version for that case when unset (see
  // readAppVersionBestEffort) rather than the meaningless "0.0.0.0" default.
  readonly appVersion?: string;
  readonly workers?: number; // default 1 — a pool of one IS the sequential path
  readonly compileConcurrency?: number; // default min(workers, 4)
  /** Required when workers > 1: each worker needs its own backend instance. */
  readonly backendFactory?: (workerIndex: number) => ExecutionBackend;
  /** Machine-local durable-quarantine base directory (spec §9). Defaults to
   *  `~/.lethal/quarantine` via `defaultQuarantineDir()` when omitted; tests inject a scratch dir
   *  so quarantine state never leaks across test runs or into the real user's home directory. */
  readonly quarantineDir?: string;
  /**
   * Physical BC service-tier identity for the quarantine consult (spec §9) — the server + server
   * instance the AUTHORITATIVE (bcdev) backend targets, sourced from the bcdev config section
   * (tenant deliberately excluded — see `quarantineResourceKey`, which scopes quarantine to the
   * shared tier, not any one tenant on it). The consult only runs when the backend reports
   * `capabilities().authoritative` AND both fields are present: al-runner (non-authoritative) has
   * no shared server-side tier to strand and legitimately omits them, and an authoritative caller
   * that omits them (e.g. a unit test exercising an in-memory stub) silently skips the consult
   * rather than crashing on an incomplete tier identity.
   */
  readonly resourceServer?: string;
  readonly resourceServerInstance?: string;
  /**
   * Layer 5C-B1 (design §6): the machine-global lease this session runs under. Present for an
   * authoritative (bcdev) session against a `LethAL Control` v2 harness; absent for al-runner and
   * for every in-memory-backend unit test, which then behave exactly as they did in 5C-A.
   *
   * When present, `runSession` acquires before deploying, fences the publish, heartbeats at
   * ttl/3, binds the tuple into the backend so every `RunMutant` is fenced, and releases
   * (op-gated) at session end.
   */
  readonly lease?: LeaseSessionConfig;
  /**
   * R26: the once-per-session permission canary (`permission-canary.ts`). Present only for an
   * authoritative (bcdev) session — `cli.ts`'s `permissionCanaryFor` wires it to the real
   * `LethALControl_PermissionCanary` OData action; absent for al-runner and for every in-memory
   * unit test, which have no fenced test path to characterise.
   *
   * Invoked EXACTLY ONCE, after the lease is acquired (it drives the platform test runner, which
   * is precisely what the lease serialises) and before any mutant runs — never per mutant. Its
   * verdict lands on `SessionReport.permissionCanary` and is printed twice (here, and again after
   * the score via `renderConsole`).
   *
   * The production implementation never throws; this call site treats a throw from ANY
   * implementation as `"inconclusive"` anyway, because a canary that could abort a session would
   * be a strictly worse failure than not measuring at all.
   */
  readonly permissionCanary?: () => Promise<PermissionCanaryResult>;
  /** Injectable ISO-timestamp source for durable quarantine records (Task 12). Production code
   *  freely uses `Date`/`Date.now()` (only workflow SCRIPTS forbid them — see design notes);
   *  this exists purely so tests can assert against a fixed, deterministic `recordedAtIso`
   *  instead of racing the real clock. Defaults to `() => new Date().toISOString()`. */
  readonly nowIso?: () => string;
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
/**
 * The target project's own app.json `id`, used as `targetAppId` — the first element of the
 * (targetAppId, artifactId, mutantId) tuple the LethAL Control extension keys state on (Layer
 * 5C-A). A target with no string `id` is structurally uncompilable and cannot register its
 * artifact, so this fails loudly rather than baking an empty first tuple element into every
 * guard (an empty-vs-empty match is this project's signature silent-wrong-verdict shape).
 */
function targetAppIdOf(projectManifest: Readonly<Record<string, unknown>>): string {
  const id = projectManifest.id;
  if (typeof id !== "string" || id === "") {
    throw new Error(
      `target app.json has no non-empty string "id" (got ${JSON.stringify(id)}) — required as targetAppId for the LethAL Control registry`,
    );
  }
  return id;
}

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
    targetAppId: targetAppIdOf(args.projectManifest),
    operatorTiers,
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

/** Production default for `SessionConfig.quarantineDir` (spec §9). Kept as a named helper (rather
 *  than inlined `?? ...`) so tests can assert against it and so there is exactly one place that
 *  decides what "no quarantineDir configured" means. Exported so `cli.ts`'s `clear-quarantine`
 *  command opens the SAME store `runSession` durably writes to — a second, drifting default here
 *  would silently target the wrong directory and never actually clear anything. */
export function defaultQuarantineDir(): string {
  return join(homedir(), ".lethal", "quarantine");
}

/**
 * Latch the session unsafe and durably quarantine the tier when a run's server-side fate is
 * unknown (spec §8/§12). Shared by every call site that inspects a `TestVerdict`/confirm
 * result's `.operation` — the baseline loop, the mutant-loop covering-test run, and the
 * kill-confirmation rerun — so the latch+record semantics live in exactly one place. Records
 * only when the store+key exist (al-runner has no tier, and an authoritative caller that
 * omitted `resourceServer`/`resourceServerInstance` is tolerated the same way — see
 * `runSession`'s `resourceKey`/`quarantineStore` doc comment); the latch itself always trips
 * regardless.
 */
async function quarantineInFlight(args: {
  readonly safety: SessionSafety;
  readonly quarantineStore: QuarantineStore | undefined;
  readonly resourceKey: string | undefined;
  readonly nowIso: () => string;
  readonly detail: string;
}): Promise<void> {
  args.safety.latchUnsafe(args.detail);
  if (args.quarantineStore !== undefined && args.resourceKey !== undefined) {
    await args.quarantineStore.record({
      resourceKey: args.resourceKey,
      opKind: "test-run",
      detail: args.detail,
      recordedAtIso: args.nowIso(),
    });
  }
}

/**
 * Best-effort app.json version lookup for `runSession`'s `createRun` call. Layer 5A already
 * derives the version a PUBLISHING run's row ends up recording from the project's own app.json
 * (via `readProjectManifest`/`reserveAppVersion` in the batch loop below, corrected into the run
 * row by step 3d's `recordArtifact` call) — but a `deploy: "none"` backend's `deploy()` always
 * returns `null` (nothing compiled, see `AlRunnerBackend.deploy`'s doc comment), so that
 * correction never fires for it, and `createRun`'s placeholder is whatever durably lands in the
 * row. Read the SAME source (the project's raw app.json `version` field — not
 * `reserveAppVersion`'s clock-derived reservation, since al-runner never publishes and so has
 * nothing to keep monotonic) so a deploy:none run's row records real metadata instead of a
 * meaningless "0.0.0.0".
 *
 * Deliberately tolerant of a missing/malformed app.json (returns `undefined`, letting the caller
 * fall back to the old placeholder) rather than `readProjectManifest`'s loud-throw contract: this
 * runs BEFORE `generateMutationSet`/`planArtifacts` decide whether the session has any mutable
 * sites at all, and a project with none is documented to reach no app.json requirement whatsoever
 * (see `planArtifacts`'s doc comment) — this lookup must not turn that into a hard requirement.
 */
async function readAppVersionBestEffort(projectDir: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(projectDir, "app.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

// ————————————————————————————————————————————————————————————————————————
// Layer 5C-B1 (design §4/§5/§6/§8): the machine-global lease session.
//
// A session acquires the lease before it deploys, fences its publish behind the server's
// operation marker, heartbeats the lease at ttl/3, carries the lease tuple into every
// `RunMutant`, and releases (op-gated) at the end. Losing the lease mid-session means this
// session can no longer PROVE the container it is measuring is still its own — so it latches
// `SessionSafety`, stops scheduling, and discards the current batch's verdicts.
// ————————————————————————————————————————————————————————————————————————

/**
 * The renew heartbeat's timer seam. Production passes the real `setInterval`/`clearInterval`;
 * tests inject a fake and fire ticks deterministically, so heartbeat behaviour (single-flight,
 * stop-on-loss, no dangling timer) is asserted with call counters instead of wall-clock delays.
 */
export interface LeaseTimers {
  readonly setInterval: (fn: () => unknown, ms: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
}

const REAL_TIMERS: LeaseTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** Bounded acquire retry budget (design §6 step 1: backoff-with-jitter is the default, not optional). */
const LEASE_ACQUIRE_ATTEMPTS_DEFAULT = 6;
const LEASE_BACKOFF_BASE_MS = 500;
const LEASE_BACKOFF_CAP_MS = 8_000;
/** How long an `op-in-flight` (this caller's OWN still-active attempt) may be polled before it is
 *  treated as stranded — design §5: poll/wait, and only quarantine if it never clears. */
const OP_POLL_ATTEMPTS = 8;
const OP_POLL_DELAY_MS = 1_000;
/** `QuarantineRecord.opKind` for the durable, tier-keyed record design §6/§8 calls
 *  `container-needs-recycle`. Cleared only by the §8 recovery sequence (restart + ForceResetLease
 *  + probe + `lethal clear-quarantine`), never by a session. */
const CONTAINER_RECYCLE_OP_KIND = "container-needs-recycle";
/** The server's `LC Lease."Op Kind"` Option formats to its member name (`OptionMembers =
 *  none,publish,run` — Lease.Table.al), so an idle marker reads back as exactly this. Anything
 *  else — including an unexpected value — is treated as an UNRESOLVED op: fail safe, never
 *  release a lease (or trust a container) whose marker we cannot read as idle. */
const OP_KIND_IDLE = "none";

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Lease wiring for one session. Optional: only an authoritative (bcdev) session against a real
 * `LethAL Control` v2 harness has a lease to take. When absent, `runSession` behaves exactly as
 * it did in 5C-A — which is what every in-memory-backend unit test relies on.
 */
export interface LeaseSessionConfig {
  readonly client: LeaseApi;
  /**
   * Reads the container's live `serverGeneration` (HarnessInfo v2). Required because
   * `AcquireLease` refuses ANY `expectedGeneration` that is not the current one
   * (`generation-changed`, design §4 step 1), and `HarnessInfo` is the only endpoint that
   * reports it without an already-granted lease. Production wires this to
   * `HarnessVerifier.verify()`, which also performs design §7's protocol-v2 + tenant checks
   * BEFORE this session can acquire, let alone publish.
   */
  readonly serverGeneration: () => Promise<string>;
  /** Default (and maximum) `MAX_TTL_SECONDS` = 15s — see lease.ts: the server's `RenewPeriodMs()`
   *  is 5000ms and `local`, and design §6's ttl/3 heartbeat on a longer ttl would renew less
   *  often than that period requires. */
  readonly ttlSeconds?: number;
  readonly acquireAttempts?: number;
  readonly backoffBaseMs?: number;
  /** Defaults to `host:pid:runId`. */
  readonly owner?: string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly timers?: LeaseTimers;
}

/** Exponential backoff with jitter — two sessions refused at the same instant must not re-collide
 *  on an identical schedule (design §6 step 1, fable7). */
function backoffWithJitter(attempt: number, baseMs: number): number {
  const capped = Math.min(baseMs * 2 ** attempt, LEASE_BACKOFF_CAP_MS);
  return Math.max(1, Math.round(capped * (0.5 + Math.random() / 2)));
}

function describeRefusal(outcome: Extract<AcquireOutcome, { granted: false }>): string {
  const parts = [`reason ${outcome.reason}`];
  if (outcome.holder !== undefined) parts.push(`holder ${outcome.holder}`);
  if (outcome.expiresAt !== undefined) parts.push(`expiresAt ${outcome.expiresAt}`);
  if (outcome.opAttemptId !== undefined) parts.push(`opAttemptId ${outcome.opAttemptId}`);
  if (outcome.opStartedAt !== undefined) parts.push(`opStartedAt ${outcome.opStartedAt}`);
  return parts.join(", ");
}

/** 64 random bits as 16 hex chars, prefixed — an `Op Attempt Id` the server stores in a Text[64]
 *  (lease.ts `MAX_ATTEMPT_ID_LENGTH`); a longer id would be silently truncated on write and could
 *  never match its own retry, so this fails loudly instead of shipping one. */
function newAttemptId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const id = `${prefix}-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
  if (id.length > MAX_ATTEMPT_ID_LENGTH) {
    throw new Error(
      `lease attemptId "${id}" is ${id.length} chars, above the server's Text[64] limit (design §4)`,
    );
  }
  return id;
}

/**
 * Writes the durable, tier-keyed `container-needs-recycle` record (design §6/§8). Silently a
 * no-op for a session with no tier identity — the same backends `runSession`'s quarantine consult
 * already tolerates (al-runner; an authoritative caller that omitted `resourceServer`/
 * `resourceServerInstance`, which warns at session start).
 *
 * First-reason-wins (design §8): an existing record names the ORIGINAL strand, and a later
 * downstream symptom must never overwrite it.
 */
async function recordContainerRecycle(args: {
  readonly quarantineStore: QuarantineStore | undefined;
  readonly resourceKey: string | undefined;
  readonly nowIso: () => string;
  readonly detail: string;
}): Promise<void> {
  const { quarantineStore, resourceKey } = args;
  if (quarantineStore === undefined || resourceKey === undefined) return;
  if ((await quarantineStore.read(resourceKey)) !== null) return;
  await quarantineStore.record({
    resourceKey,
    opKind: CONTAINER_RECYCLE_OP_KIND,
    detail: args.detail,
    recordedAtIso: args.nowIso(),
  });
}

/**
 * Design §6 step 1: acquire before `deploy()`, with a bounded backoff-with-jitter over
 * `held`/`operation-busy`, and the §6 quarantine taxonomy for everything else.
 *
 * ONE client nonce is used for every attempt in the loop, deliberately: the server replays a
 * matching nonce on a HELD row as the SAME `{epoch, token, serverGeneration}` grant
 * (`ControlState.TryAcquire` step 3), so a retry after a lost ack recovers the caller's own lease
 * instead of minting a second one or being refused as a competitor.
 *
 * `operation-orphaned` is NOT a backoff case: it means a previous session's op marker outlived
 * its grace window. Design §6 requires a re-check ONCE and a durable `container-needs-recycle`
 * record ONLY if the marker is unchanged (same `opAttemptId`/`opStartedAt`) across both looks — a
 * marker that MOVED is a live container making progress, not a stranded one, so it is left to the
 * ordinary backoff.
 */
async function acquireSessionLease(args: {
  readonly cfg: LeaseSessionConfig;
  readonly owner: string;
  readonly ttlSeconds: number;
  readonly quarantineStore: QuarantineStore | undefined;
  readonly resourceKey: string | undefined;
  readonly nowIso: () => string;
}): Promise<Lease> {
  const { cfg } = args;
  const attempts = Math.max(1, Math.floor(cfg.acquireAttempts ?? LEASE_ACQUIRE_ATTEMPTS_DEFAULT));
  const baseMs = cfg.backoffBaseMs ?? LEASE_BACKOFF_BASE_MS;
  const sleep = cfg.sleep ?? defaultSleep;
  const expectedGeneration = await cfg.serverGeneration();
  if (expectedGeneration === "") {
    throw new LeaseUnavailableError(
      "cannot acquire the lease: the harness reported an empty serverGeneration — AcquireLease compares it against the stored generation, so an empty value could only ever match an equally-empty one (design §4)",
    );
  }
  const clientNonce = newArtifactId();
  let orphanMarker: string | undefined;
  let lastRefusal = "none";
  for (let attempt = 0; attempt < attempts; attempt++) {
    const outcome = await cfg.client.acquire(
      args.owner,
      args.ttlSeconds,
      clientNonce,
      expectedGeneration,
    );
    if (outcome.granted) return outcome.lease;
    lastRefusal = describeRefusal(outcome);
    if (outcome.reason === "operation-orphaned") {
      // A marker is COMPARABLE only when the server actually named the stranded op. Without a
      // non-empty `opAttemptId` both looks would synthesise the same `"|"` placeholder, compare
      // equal, and write a durable, operator-only-recoverable `container-needs-recycle` having
      // compared NOTHING — this project's signature empty-vs-empty bug, guarding its most
      // expensive action. Not reachable against today's server (`ControlState.TryAcquire` always
      // populates `opAttemptId` on this refusal), so an unnamed marker means the contract broke:
      // keep backing off rather than recording something we cannot substantiate.
      const marker =
        outcome.opAttemptId !== undefined && outcome.opAttemptId !== ""
          ? `${outcome.opAttemptId}|${outcome.opStartedAt ?? ""}`
          : undefined;
      if (marker !== undefined && orphanMarker === marker) {
        const detail = `container-needs-recycle: AcquireLease reported operation-orphaned twice with an UNCHANGED marker (opAttemptId ${outcome.opAttemptId ?? "<none>"}, opStartedAt ${outcome.opStartedAt ?? "<none>"}, serverGeneration ${expectedGeneration}) — a prior session's operation is stranded on this tier. Recovery (design §8): restart the NST/container, ForceResetLease, re-probe, then 'lethal clear-quarantine'.`;
        await recordContainerRecycle({
          quarantineStore: args.quarantineStore,
          resourceKey: args.resourceKey,
          nowIso: args.nowIso,
          detail,
        });
        throw new LeaseUnavailableError(detail);
      }
      // First sighting of a nameable marker — re-check exactly once, after a backoff. An
      // unnameable one is not remembered, so it can never become a later look's "unchanged".
      if (marker !== undefined) orphanMarker = marker;
    } else if (outcome.reason !== "held" && outcome.reason !== "operation-busy") {
      // `generation-changed` (the container was recycled/reset under us) or a reason this client
      // does not know: neither is something waiting can fix. Fail loudly instead of burning the
      // whole backoff budget on a refusal that will never change.
      throw new LeaseUnavailableError(
        `AcquireLease refused and backoff cannot help: ${lastRefusal}`,
      );
    }
    if (attempt < attempts - 1) await sleep(backoffWithJitter(attempt, baseMs));
  }
  throw new LeaseUnavailableError(
    `AcquireLease was never granted after ${attempts} attempt(s) (last refusal: ${lastRefusal})`,
  );
}

/**
 * Does this backend carry a fence at all? The same `setLease` duck-type `leaseBindableOrThrow`
 * uses (below), asked as a question rather than an assertion — it is the only honest predicate for
 * "this backend's `RunMutant` calls are fenced", since `ExecutionBackend` deliberately does not
 * declare `setLease`. Used at session start to refuse a fenceable authoritative backend that was
 * given no lease.
 */
function isLeaseBindable(backend: ExecutionBackend): boolean {
  return typeof (backend as { setLease?: unknown }).setLease === "function";
}

/**
 * Binds the session's lease into the backend so every `RunMutant` carries the fence tuple
 * (design §5). Duck-typed for the same reason `closeIfSupported` is: `ExecutionBackend` does not
 * declare `setLease` (al-runner has no lease, and neither do the in-memory test backends).
 *
 * Fails LOUDLY when a lease is configured but the backend cannot take it: the alternative is a
 * session that publishes under a lease and then runs every mutant unfenced — exactly the
 * false-verdict window this layer exists to close.
 */
function leaseBindableOrThrow(backend: ExecutionBackend): (lease: Lease) => void {
  const bindable = backend as { setLease?: (lease: Lease) => void };
  if (typeof bindable.setLease !== "function") {
    throw new Error(
      "runSession: a lease is configured but this backend exposes no setLease(lease) — every fenced RunMutant must carry the session's (epoch, token, serverGeneration, opSeq) tuple (design §5/§6); refusing to run unfenced",
    );
  }
  return bindable.setLease.bind(backend);
}

function bindLeaseToBackend(backend: ExecutionBackend, lease: Lease): void {
  leaseBindableOrThrow(backend)(lease);
}

/**
 * A `TestVerdict`'s lease classification (design §5/§8). `operation: "lease-lost"` covers TWO
 * server answers that must NOT be treated alike:
 *   - `"op-in-flight"` — THIS caller's own `(opSeq, attemptId)` is still executing server-side (a
 *     duplicate claim). Poll/wait; never re-dispatch, never `RecoverOp`, and never latch: doing so
 *     would discard a batch that is perfectly fine.
 *   - anything else, INCLUDING an absent reason (the phase-3 verify-and-clear refusal carries
 *     none) — a genuinely lost lease.
 */
type LeaseVerdictKind = "none" | "op-in-flight" | "lost";

function classifyLeaseVerdict(v: Pick<TestVerdict, "operation" | "leaseInvalidReason">) {
  if (v.operation !== "lease-lost") return "none" as LeaseVerdictKind;
  return (v.leaseInvalidReason === "op-in-flight" ? "op-in-flight" : "lost") as LeaseVerdictKind;
}

/**
 * Layer 5C-B2 (design §5): what a lost `RunMutant` ack could be established to be.
 *   - `"completed"` — the server-side fence provably finished (the op is tombstoned, or it cleared
 *     while we polled). Only the RESULT was lost; the container is clean.
 *   - `"unresolved"` — anything we could not establish, including a failed status read and a marker
 *     that is not ours. The conservative durable quarantine applies.
 */
type LostAckOutcome = "completed" | "unresolved";

/**
 * The lost-ack reconciliation as the two `in-flight-unknown` call sites see it (design §5).
 *
 * `"unresolved"` for a verdict carrying no `fencedOp`, deliberately: al-runner, the bc-dev hub's
 * coverage runs, and any verdict from a session holding no lease name no operation at all, so
 * there is nothing to ask the server about and the pre-5C-B2 quarantine remains exactly right. An
 * absent field must never read as "nothing was stranded".
 */
async function reconcileFencedLostAck(
  leaseSession: LeaseSession | undefined,
  verdict: Pick<TestVerdict, "fencedOp">,
): Promise<LostAckOutcome> {
  const { fencedOp } = verdict;
  if (leaseSession === undefined || fencedOp === undefined) return "unresolved";
  return leaseSession.reconcileLostAck(fencedOp);
}

/** What one fenced run resolved to, after design §5's lost-ack handling (see `runFenced`). */
interface FencedRunOutcome {
  /** The verdict the caller must act on — the RETRY's, whenever a proven-clean retry was made. */
  readonly verdict: TestVerdict;
  /**
   * The reconciliation result for `verdict`'s OWN lost ack, when `verdict` is still ambiguous;
   * `"none"` when the run resolved to anything else. `"unresolved"` is the caller's cue to
   * quarantine.
   */
  readonly lostAck: LostAckOutcome | "none";
  /** Whether a proven-clean retry was dispatched — diagnostics only. */
  readonly retried: boolean;
}

/**
 * One fenced test run, with design §5's lost-ack handling folded in so the mutant loop sees a
 * single verdict — the same shape `runOnce` already uses for its `pre-dispatch-rejected` retry.
 *
 * The sequence, and why each step is where it is:
 *   1. `runOnce`. Anything but an ambiguous answer is returned untouched.
 *   2. An ambiguous answer is reconciled. `"unresolved"` returns immediately — nothing was
 *      established, so the caller quarantines and NOTHING is re-dispatched. This is the design's
 *      hard rule: an attempt that may still be executing AL must never be re-issued.
 *   3. `"completed"` means the fence provably finished: phase 3 tombstoned the op AND cleared the
 *      active tuple, so the container is in a known-clean state and a fresh attempt is a NEW op,
 *      not a re-dispatch of a live one. Exactly ONE such attempt is made.
 *   4. The retry's answer is taken as-is; if it too is ambiguous it is reconciled ONCE MORE (a
 *      container that IS stranded must still be caught) but never retried again. The budget is on
 *      RETRIES, not on reconciliations.
 *
 * The op-seq resync before the retry is a value no-op in the expected case — the backend's counter
 * already sits at `lastCompletedOpSeq + 1` because the lost call consumed exactly the seq the
 * server then tombstoned. It is made anyway, through the existing mechanism: `completed` is
 * `opSeq <= lastCompletedOpSeq`, so the server may legitimately be further ahead, and a
 * counter that disagrees produces a `lease-invalid` refusal indistinguishable from a real lease
 * loss. One cheap read on a rare path buys that away.
 *
 * The fresh `attemptId` needs nothing here: the backend mints one per call (`bcdev-backend.ts`).
 */
async function runFenced(
  backend: ExecutionBackend,
  safety: SessionSafety,
  ref: TestMethodRef,
  opts: { coverage: "none" | "procedure" | "line"; timeoutMs: number },
  leaseSession: LeaseSession | undefined,
  resyncOpSeq?: () => Promise<void>,
): Promise<FencedRunOutcome> {
  const first = await runOnce(backend, safety, ref, opts, resyncOpSeq);
  if (!isLostAck(first)) return { verdict: first, lostAck: "none", retried: false };
  // Announce it. A lost ack is rare, it means a result really was thrown away, and a silent
  // recovery is indistinguishable from the fault never happening — which is exactly the ambiguity
  // that made this intermittent expensive to diagnose in the first place.
  console.warn(
    `[lethal] ${ref.method}: unreadable answer from RunMutant (${first.failureMessage ?? "no detail"}) — reconciling against the operation marker before deciding anything`,
  );
  if ((await reconcileFencedLostAck(leaseSession, first)) === "unresolved") {
    return { verdict: first, lostAck: "unresolved", retried: false };
  }
  console.warn(
    `[lethal] ${ref.method}: the operation was confirmed COMPLETE server-side, so the container is clean and only the result was lost — retrying once as a fresh attempt`,
  );
  if (resyncOpSeq !== undefined) await resyncOpSeq();
  const retry = await runOnce(backend, safety, ref, opts, resyncOpSeq);
  if (!isLostAck(retry)) return { verdict: retry, lostAck: "none", retried: true };
  return {
    verdict: retry,
    lostAck: await reconcileFencedLostAck(leaseSession, retry),
    retried: true,
  };
}

/**
 * Is this verdict an UNREADABLE ANSWER — the only thing design §5's lost-ack handling applies to?
 *
 * Deliberately `=== "in-flight-unknown"` rather than `requiresUnsafeLatch`, which the two mutant-loop
 * branches use: those run AFTER `classifyLeaseVerdict` has already broken out on a `lease-lost`
 * answer, so the coarser predicate is exact there. `runFenced` runs BEFORE that classification, and
 * a `lease-lost` is a CONFIRMED server refusal — reconciling or retrying it would re-dispatch under
 * a lease this session cannot prove it holds, which is the opposite of what §6 requires.
 */
function isLostAck(v: TestVerdict): boolean {
  return v.operation === "in-flight-unknown";
}

/**
 * Records a GENUINE lease loss (design §6) — and refuses to proceed without a lease session.
 *
 * `SessionSafety.latchUnsafe` alone is NOT a safe fallback here, however plausible it looks: it
 * stops scheduling but leaves `lostBatchIndex` unset, so the current batch's already-recorded
 * verdicts — measured under a lease this session cannot prove it held — would ship untouched.
 * That silent skip is exactly the false verdict this layer exists to close, so a `lease-lost`
 * answer arriving with no lease session is treated as the caller-contract violation it is.
 * Unreachable in production: `runSession` refuses at session start when a lease-bindable
 * authoritative backend is configured without a lease.
 */
function noteLeaseLostOrThrow(leaseSession: LeaseSession | undefined, detail: string): void {
  if (leaseSession === undefined) {
    throw new Error(
      `runSession: a RunMutant answered lease-lost but this session holds no lease (${detail}) — refusing to latch without invalidating the batch whose verdicts were measured under it (design §6)`,
    );
  }
  leaseSession.noteLeaseLost(detail);
}

/**
 * The lease a session holds, plus everything the session does WITH it: the renew heartbeat, the
 * publish fence, op-seq reconciliation, lease-loss bookkeeping, and the op-gated release.
 *
 * Lease-loss is recorded here (not just on `SessionSafety`) because design §6 scopes verdict
 * invalidation to the batch that was in flight when the lease was lost: earlier batches stand,
 * since every `RunMutant` in them was individually phase-1/phase-3 fence-validated.
 */
class LeaseSession {
  #handle: unknown;
  #ticking = false;
  #stopped = false;
  #lostBatchIndex: number | undefined;
  /** The op seq of this batch's publish, used to re-seed the backend's RunMutant counter. */
  #lastPublishOpSeq: number | undefined;
  /** Updated by `runSession` at the top of every batch — the scope of a lease-lost invalidation. */
  currentBatchIndex = 0;

  constructor(
    private readonly d: {
      readonly client: LeaseApi;
      readonly lease: Lease;
      readonly safety: SessionSafety;
      readonly ttlSeconds: number;
      readonly timers: LeaseTimers;
      readonly sleep: (ms: number) => Promise<void>;
      readonly quarantineStore: QuarantineStore | undefined;
      readonly resourceKey: string | undefined;
      readonly nowIso: () => string;
      readonly runId: number;
    },
  ) {}

  /** The batch that was in flight when the lease was lost — `undefined` while the lease is held. */
  get lostBatchIndex(): number | undefined {
    return this.#lostBatchIndex;
  }

  /** design §6 step 3: a single-flight renew at ttl/3. */
  start(): void {
    const periodMs = Math.max(1, Math.floor((this.d.ttlSeconds * 1000) / 3));
    this.#handle = this.d.timers.setInterval(() => this.pulse(), periodMs);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#handle !== undefined) {
      this.d.timers.clearInterval(this.#handle);
      this.#handle = undefined;
    }
  }

  /**
   * One heartbeat tick. SINGLE-FLIGHT: a tick that arrives while the previous renew is still in
   * flight is dropped, never queued — a slow round trip must not pile up renewals that then
   * arrive out of order.
   *
   * A THROWN renew is a lost ack, not a loss: design §6 is explicit that only `renewed:false` is
   * loss. It earns exactly one retry within the tick; if that also fails, the tick gives up and
   * the next one tries again (and if the lease really has gone, the very next `RunMutant` is
   * refused by the phase-1 fence, which IS a confirmed loss).
   */
  async pulse(): Promise<void> {
    if (this.#ticking || this.#stopped) return;
    this.#ticking = true;
    try {
      let outcome: Awaited<ReturnType<LeaseApi["renew"]>>;
      try {
        outcome = await this.d.client.renew(this.d.lease, this.d.ttlSeconds);
      } catch (first) {
        try {
          outcome = await this.d.client.renew(this.d.lease, this.d.ttlSeconds);
        } catch (second) {
          console.warn(
            `[lethal] lease renew could not be answered twice in a row (${messageOf(first)}; ${messageOf(second)}) — not treated as lease loss (design §6: only renewed:false is loss); the next tick retries`,
          );
          return;
        }
      }
      if (!outcome.renewed) {
        this.noteLeaseLost("RenewLease answered renewed:false — the lease is no longer ours");
      }
    } finally {
      this.#ticking = false;
    }
  }

  /**
   * design §6: latch `SessionSafety` (reason `lease-lost`), stop renewing, and remember WHICH
   * batch was in flight so `runSession` can invalidate exactly that batch's verdicts at session
   * end. Idempotent — the FIRST loss wins, like the latch itself.
   */
  noteLeaseLost(detail: string): void {
    if (this.#lostBatchIndex === undefined) this.#lostBatchIndex = this.currentBatchIndex;
    this.stop(); // no renew after a loss, and no dangling timer
    this.d.safety.latchUnsafe(`lease-lost: ${detail}`);
  }

  /** The server accepts only `lastCompletedOpSeq + 1` (design §5), and this client's publish ops
   *  and the backend's run ops share ONE server-side sequence — so the authoritative value is
   *  read back, never guessed from the acquire grant alone. */
  private async nextOpSeq(): Promise<number> {
    const status = await this.d.client.getOperationStatus(this.d.lease, "", 0);
    return status.lastCompletedOpSeq + 1;
  }

  /**
   * Re-seeds the backend's RunMutant op-seq counter from the server's own `lastCompletedOpSeq`.
   *
   * Needed because the backend increments its counter per RunMutant call ISSUED (bcdev-backend.ts),
   * while the server advances `Last Completed Op Seq` only when an op actually completes. The one
   * in-session path that can desynchronise them is `runOnce`'s retry of a `pre-dispatch-rejected`
   * run: the first attempt consumed a counter value the server never saw, so the retry would send
   * a too-high `opSeq` and be refused as `lease-invalid` — indistinguishable, at the client, from
   * a genuinely lost lease. Reconciling here keeps that false lease-loss impossible.
   */
  async resyncOpSeq(backend: ExecutionBackend): Promise<void> {
    const status = await this.d.client.getOperationStatus(this.d.lease, "", 0);
    bindLeaseToBackend(backend, {
      ...this.d.lease,
      lastCompletedOpSeq: status.lastCompletedOpSeq,
    });
  }

  /** Re-binds the backend so its first RunMutant of this batch follows THIS batch's publish op. */
  rebindBackend(backend: ExecutionBackend): void {
    const publishOpSeq = this.#lastPublishOpSeq;
    if (publishOpSeq === undefined) return;
    bindLeaseToBackend(backend, { ...this.d.lease, lastCompletedOpSeq: publishOpSeq });
  }

  /**
   * design §6 step 2 — the publication fence. `BeginPublish` claims the operation marker so no
   * other session can acquire the lease across our publish; `EndPublish` tombstones it on every
   * CONFIRMED terminal outcome, success or deterministic failure.
   *
   * A publish whose result is genuinely UNKNOWN (`DeploymentError` with outcome `indeterminate`
   * or `anomalous` — the publish may have landed, or may still be landing) deliberately leaves
   * the marker set and records a durable `container-needs-recycle`: leaving the marker is what
   * stops the next session from publishing over a half-applied one.
   */
  async publish<T>(run: () => Promise<T>): Promise<T> {
    const opSeq = await this.nextOpSeq();
    const attemptId = newAttemptId(`pub-${this.d.runId}-b${this.currentBatchIndex}`);
    const begun = await this.d.client.beginPublish(this.d.lease, attemptId, opSeq);
    if (!begun.begun) {
      this.noteLeaseLost(
        `BeginPublish refused (opSeq ${opSeq}, attemptId ${attemptId}, alreadyCompleted ${String(begun.alreadyCompleted)})`,
      );
      throw new LeaseUnavailableError(
        `BeginPublish refused for opSeq ${opSeq} — the lease or the operation marker is no longer ours (design §4)`,
      );
    }
    let result: T;
    try {
      result = await run();
    } catch (err) {
      if (isConfirmedTerminalPublishFailure(err)) {
        await this.endPublish(attemptId, opSeq, "failed");
      } else {
        await this.recordRecycle(
          `publish operation ${opSeq} (attemptId ${attemptId}) ended with an UNKNOWN result — the marker is deliberately left set so no other session publishes across it: ${messageOf(err)}`,
        );
      }
      throw err;
    }
    await this.endPublish(attemptId, opSeq, "succeeded");
    this.#lastPublishOpSeq = opSeq;
    return result;
  }

  /**
   * `EndPublish` on a confirmed-terminal publish. A refusal means our tuple no longer matches —
   * lease loss. A THROWN call is a lost ack over an op we already know terminated, which is the
   * one situation design §5 permits `RecoverOp` in: see `reconcileStrandedPublish`.
   */
  private async endPublish(attemptId: string, opSeq: number, outcome: string): Promise<void> {
    let ended: Awaited<ReturnType<LeaseApi["endPublish"]>>;
    try {
      ended = await this.d.client.endPublish(this.d.lease, attemptId, opSeq, outcome);
    } catch (err) {
      await this.reconcileStrandedPublish(attemptId, opSeq, err);
      return;
    }
    if (ended.ended || ended.alreadyCompleted === true) return;
    this.noteLeaseLost(`EndPublish refused for publish op ${opSeq} (attemptId ${attemptId})`);
  }

  /**
   * Reconciles a publish op whose `EndPublish` ack was lost — design §5's marker-recovery rules,
   * applied at the ONLY call site in this session that can satisfy them.
   *
   * The precondition `RecoverOp` demands is a PARSED application-level terminal response proving
   * the invocation unwound — never a bare HTTP status, connection error, or client timeout. Two
   * facts are required here and both are checked before the flag `true` is even constructible:
   *   1. the publish itself already returned a terminal result (this method is only reached from
   *      `endPublish`, which is only called on a confirmed-terminal publish), and the AL side of a
   *      publish op runs nothing — `BeginPublish` returned and set a marker, that is all; and
   *   2. a parsed `GetOperationStatus` body says the CURRENT marker is exactly our own publish op.
   * If the status read itself fails, or the marker belongs to some other op (or to a `run`, which
   * genuinely could still be executing AL), nothing is recovered: the marker stays and the tier is
   * durably quarantined instead.
   */
  private async reconcileStrandedPublish(
    attemptId: string,
    opSeq: number,
    cause: unknown,
  ): Promise<void> {
    let status: Awaited<ReturnType<LeaseApi["getOperationStatus"]>>;
    try {
      status = await this.d.client.getOperationStatus(this.d.lease, attemptId, opSeq);
    } catch (err) {
      await this.recordRecycle(
        `EndPublish for op ${opSeq} (attemptId ${attemptId}) was not acknowledged (${messageOf(cause)}) and the reconciling GetOperationStatus also failed (${messageOf(err)}) — marker left set`,
      );
      return;
    }
    if (status.completed) return; // the lost ack had landed after all — already tombstoned
    if (
      status.opKind === "publish" &&
      status.opAttemptId === attemptId &&
      status.opSeq === opSeq &&
      attemptId !== ""
    ) {
      const recovered = await this.d.client.recoverOp(this.d.lease, attemptId, opSeq, true);
      if (recovered.recovered || recovered.alreadyCompleted === true) return;
    }
    await this.recordRecycle(
      `publish op ${opSeq} (attemptId ${attemptId}) could not be reconciled after a lost EndPublish ack (${messageOf(cause)}); server marker: opKind ${status.opKind}, opAttemptId ${status.opAttemptId}, opSeq ${status.opSeq}`,
    );
  }

  /**
   * Layer 5C-B2 (design §5): reconcile a FENCED `RunMutant` whose answer we could not read.
   *
   * The live defect this closes: BC answered `RunMutant` with HTTP 200 and a zero-byte body on 3
   * of 8 bcdev gate runs. The transport can only call that `in-flight-unknown`, and the
   * orchestrator went straight to a durable `container-needs-recycle` that blocks every later
   * session on the tier until an operator deletes it by hand. The lease row read moments after one
   * such failure said `{"opKind":"none","opAttemptId":"a10","opSeq":304,
   * "lastCompletedOpSeq":304,"completed":true}` — phase 3 HAD run and tombstoned the op. Nothing
   * was ever stranded; only the HTTP response body was lost.
   *
   * design §5's three rules, in order:
   *   - the attempt is **completed/tombstoned** → the whole fence ran; discard the lost result
   *     client-side, no recycle;
   *   - the attempt is **still active AND ours** → it may still be executing AL → poll (via the one
   *     `pollUntilOpClears` helper); only if it never clears is the tier condemned;
   *   - anything else — the status read failed, or the marker names an op that is not ours — is
   *     unresolved, and the conservative quarantine stands. Establishing nothing is NOT evidence of
   *     health (the empty-vs-empty match this codebase keeps getting bitten by, here guarding the
   *     verdict that a container is safe to keep using).
   *
   * `RecoverOp` is NEVER called from here, at any branch: an unreadable body is not a parsed
   * application-level terminal response, and clearing a marker over a still-running AL op is the
   * exact overlap→false-verdict sequence design §5 exists to close.
   */
  async reconcileLostAck(op: {
    readonly attemptId: string;
    readonly opSeq: number;
  }): Promise<LostAckOutcome> {
    let status: Awaited<ReturnType<LeaseApi["getOperationStatus"]>>;
    try {
      status = await this.d.client.getOperationStatus(this.d.lease, op.attemptId, op.opSeq);
    } catch (err) {
      console.warn(
        `[lethal] could not reconcile the lost RunMutant ack for op ${op.opSeq} (attemptId ${op.attemptId}): ${messageOf(err)} — treating the operation as unresolved`,
      );
      return "unresolved";
    }
    // `completed` is the server's own `opSeq <= Last Completed Op Seq`; the second term repeats it
    // from the raw fields so a server that ever omitted/mis-set the boolean cannot silently turn a
    // tombstoned op into an unresolved one.
    if (status.completed || op.opSeq <= status.lastCompletedOpSeq) return "completed";
    // Ours means ALL THREE of kind/attempt/seq name this exact attempt. An empty `attemptId` is
    // refused outright rather than allowed to match an equally-empty marker.
    const ours =
      op.attemptId !== "" &&
      status.opKind === "run" &&
      status.opAttemptId === op.attemptId &&
      status.opSeq === op.opSeq;
    if (!ours) return "unresolved";
    return (await this.pollUntilOpClears()) ? "completed" : "unresolved";
  }

  /**
   * design §5: an `op-in-flight` refusal means our OWN attempt is still executing server-side.
   * Poll the marker — never re-dispatch, never `RecoverOp` (the op may still be running AL, which
   * is precisely what that rule forbids clearing). Returns whether it cleared within the budget.
   */
  async pollUntilOpClears(): Promise<boolean> {
    for (let attempt = 0; attempt < OP_POLL_ATTEMPTS; attempt++) {
      let status: Awaited<ReturnType<LeaseApi["getOperationStatus"]>>;
      try {
        status = await this.d.client.getOperationStatus(this.d.lease, "", 0);
      } catch (err) {
        console.warn(`[lethal] polling the in-flight operation failed: ${messageOf(err)}`);
        return false;
      }
      if (status.opKind === OP_KIND_IDLE) return true;
      if (attempt < OP_POLL_ATTEMPTS - 1) await this.d.sleep(OP_POLL_DELAY_MS);
    }
    return false;
  }

  /**
   * Can we PROVE the lease row has moved on without us? Only one answer proves it: a `RenewLease`
   * that came back `renewed:false`, which means the server compared our `(epoch, token,
   * generation)` against the live row and they no longer match.
   *
   * Everything else returns `false` — deliberately. A renew that could not be answered at all
   * (unreachable, non-2xx, malformed) proves nothing, and design §6 already says only
   * `renewed:false` is loss; treating "I could not ask" as "not ours" would be exactly the
   * empty-vs-empty match this codebase keeps getting bitten by, in the direction that SUPPRESSES a
   * quarantine the tier may genuinely need. Unknown therefore keeps the conservative behaviour.
   */
  private async leaseProvablyNotOurs(): Promise<boolean> {
    try {
      const outcome = await this.d.client.renew(this.d.lease, this.d.ttlSeconds);
      return !outcome.renewed;
    } catch (err) {
      console.warn(
        `[lethal] could not confirm lease ownership at session end (${messageOf(err)}) — treating the marker as possibly ours`,
      );
      return false;
    }
  }

  async recordRecycle(detail: string): Promise<void> {
    await recordContainerRecycle({
      quarantineStore: this.d.quarantineStore,
      resourceKey: this.d.resourceKey,
      nowIso: this.d.nowIso,
      detail,
    });
  }

  /**
   * design §6 step 5 — stop the heartbeat and release, but ONLY when no operation is in flight.
   * A normal session's last `RunMutant` cleared its own marker in phase 3, so the gate passes and
   * the lease is freed immediately for the next session. A marker that is still set means
   * something may still be executing on the tier: releasing there would let another session in on
   * top of it, so the lease is left to expire and the tier is durably quarantined instead — but
   * ONLY once the marker is shown to be ours (`leaseProvablyNotOurs`), because a marker belonging
   * to the session that took the lease over is a healthy container, not a stranded one.
   *
   * After a lease LOSS there is nothing to release — our credentials are already invalid, and the
   * lease now belongs to whoever holds it.
   */
  async finish(): Promise<void> {
    this.stop();
    if (this.#lostBatchIndex !== undefined) return;
    let status: Awaited<ReturnType<LeaseApi["getOperationStatus"]>>;
    try {
      status = await this.d.client.getOperationStatus(this.d.lease, "", 0);
    } catch (err) {
      console.warn(
        `[lethal] could not read the operation marker at session end (${messageOf(err)}) — leaving the lease to expire rather than releasing over a possibly-live operation`,
      );
      return;
    }
    if (status.opKind !== OP_KIND_IDLE) {
      // The marker is non-idle — but is it OURS? If our lease lapsed (a renew that could not be
      // answered is deliberately NOT loss, so the heartbeat may not have noticed yet) another
      // session can have acquired and begun its own op inside that window. Quarantining THEIR
      // marker would durably block a perfectly healthy container, and design §6 is explicit that
      // a clean lease loss must NOT write a durable tier quarantine. `RenewLease` is the cheapest
      // proof of ownership there is: it re-validates the same (epoch, token, generation) tuple the
      // op marker was claimed under. `renewed:false` proves the row moved on without us.
      if (await this.leaseProvablyNotOurs()) {
        console.warn(
          `[lethal] session ended with a non-idle operation marker (opKind ${status.opKind}, opAttemptId ${status.opAttemptId}, opSeq ${status.opSeq}) that belongs to ANOTHER session — RenewLease answered renewed:false, so our lease had already been taken over and this marker is not ours to quarantine. No durable container-needs-recycle recorded; the container is healthy and the other session owns it.`,
        );
        return;
      }
      await this.recordRecycle(
        `session ended with an unresolved operation marker (opKind ${status.opKind}, opAttemptId ${status.opAttemptId}, opSeq ${status.opSeq}) — the lease was NOT released; recover per design §8 (restart, ForceResetLease, probe, clear-quarantine)`,
      );
      return;
    }
    try {
      const released = await this.d.client.release(this.d.lease);
      if (!released.released) {
        console.warn(
          `[lethal] ReleaseLease refused (${released.reason}) — the lease will expire on its own`,
        );
      }
    } catch (err) {
      console.warn(`[lethal] ReleaseLease failed: ${messageOf(err)} — the lease will expire`);
    }
  }
}

/**
 * Is this deploy failure a CONFIRMED terminal publish outcome (design §6 step 2)?
 *
 * Only these are: `AlcCompileError` (alc rejected the source — nothing was ever published),
 * `ArtifactPrepareError` (an fs/spawn/manifest problem on our side, likewise pre-publish), a
 * `DeploymentError` whose own `outcome` field is `"failed"` (BC rejected the publish AND identity
 * verification agrees the server does not run our artifact), and a version conflict (BC named the
 * installed version verbatim — a deterministic rejection).
 *
 * Everything else — notably `DeploymentError` with `indeterminate`/`anomalous` — is a publish
 * whose result we cannot state, and must NOT be tombstoned with `EndPublish`.
 */
function isConfirmedTerminalPublishFailure(err: unknown): boolean {
  if (err instanceof AlcCompileError || err instanceof ArtifactPrepareError) return true;
  if (err instanceof DeploymentError) return err.outcome === "failed";
  return parseVersionConflict(messageOf(err)) !== null;
}

/**
 * One deploy dispatch: latch-guarded (design §6: `deploy`, `activate` AND `run` are all guarded)
 * and, when a lease is held, wrapped in the BeginPublish/EndPublish fence.
 */
async function deployOnce(
  backend: ExecutionBackend,
  safety: SessionSafety,
  leaseSession: LeaseSession | undefined,
  dir: string,
): Promise<CompiledArtifact | null> {
  safety.assertSafe(`deploy(${dir})`);
  if (leaseSession === undefined) return backend.deploy(dir);
  return leaseSession.publish(() => backend.deploy(dir));
}

export async function runSession(cfg: SessionConfig): Promise<SessionReport> {
  // Constructed once for the whole session and threaded to every activateOnce call site
  // (baseline activation below, and the per-mutant loop in runMutantsOnBackend) — the latch is
  // per-SESSION (spec §8), not per-call, so every activation attempt must consult and be able
  // to trip the same one. The quarantine consult immediately below runs BEFORE status() so an
  // already-stranded tier refuses even a readiness probe; the `finally` teardown at the bottom of
  // this function is latch-gated so no mutating ClearActive ever runs once unsafe.
  const safety = new SessionSafety();
  const caps = cfg.backend.capabilities();
  const nowIso = cfg.nowIso ?? (() => new Date().toISOString());
  // Layer 5C-B1 (design §6): an authoritative backend that CAN be fenced — it exposes `setLease`,
  // as bcdev does — MUST be given a lease. Without one every RunMutant runs unfenced, and a
  // `lease-lost` answer could then only be latched, never scoped: the current batch's
  // already-recorded verdicts would ship as measured under a lease this session cannot prove it
  // held. Fail loudly on the caller contract instead of degrading to a plausible default (this
  // project's signature bug), and do it before ANY backend call — not even a readiness probe runs
  // unfenced. Scoped by `isLeaseBindable` rather than `caps.authoritative` alone because the
  // in-memory authoritative stubs the unit suite drives carry no fence at all and legitimately
  // have no lease to take; a real bcdev session always does.
  if (caps.authoritative && cfg.lease === undefined && isLeaseBindable(cfg.backend)) {
    throw new Error(
      "runSession: this authoritative backend is lease-bindable (it exposes setLease) but no lease is configured — every RunMutant would run unfenced, and a lost lease could not be scoped to the batch whose verdicts it invalidates (design §6). Set SessionConfig.lease.",
    );
  }
  // Quarantine consult (spec §8/§9): a tier a PRIOR session marked stranded must refuse this
  // session outright, before even a non-mutating status() probe. Only meaningful for an
  // authoritative backend with a known tier identity — see SessionConfig.resourceServer's doc
  // comment for why an authoritative caller missing the identity fields is tolerated (skip, not
  // throw) rather than treated as a configuration error here.
  //
  // `resourceKey`/`quarantineStore` are declared at this outer scope (not just inside the `if`
  // below) so the mutant loop (Task 12) can also record a NEW quarantine when a test run comes
  // back in-flight-unknown mid-session — they stay `undefined` for exactly the backends that
  // legitimately have no shared tier to strand (al-runner) or omit identity fields, and the
  // mutant loop treats "no store" as "latch only, nothing durable to record" (see
  // `runMutantsOnBackend`'s deadline branch).
  let resourceKey: string | undefined;
  let quarantineStore: QuarantineStore | undefined;
  if (
    caps.authoritative &&
    cfg.resourceServer !== undefined &&
    cfg.resourceServerInstance !== undefined
  ) {
    resourceKey = quarantineResourceKey({
      server: cfg.resourceServer,
      serverInstance: cfg.resourceServerInstance,
    });
    quarantineStore = new QuarantineStore(cfg.quarantineDir ?? defaultQuarantineDir());
    const existing = await quarantineStore.read(resourceKey);
    if (existing !== null) {
      throw new Error(
        `tier ${resourceKey} is quarantined (${existing.opKind}: ${existing.detail}, recorded ${existing.recordedAtIso}, generation ${existing.generation}). Recycle the tier and run 'lethal clear-quarantine' to clear it.`,
      );
    }
  } else if (caps.authoritative) {
    // Safety net (Task 13 folded fix): an authoritative backend with NO tier identity means the
    // quarantine consult above is silently skipped — no prior strand is detected, and no NEW
    // strand can be durably recorded (see `quarantineInFlight`'s "no store" note). That is
    // TOLERATED (not thrown — ~30 pre-existing authoritative-backend unit tests exercise an
    // in-memory stub and never set these fields), but it must never be SILENT: a regression in
    // whatever wires `resourceServer`/`resourceServerInstance` from config (cli.ts sources them
    // from the bcdev config section's `server`/`serverInstance`) would otherwise leave quarantine
    // permanently inert against a real BC server without any signal.
    console.warn(
      "runSession: authoritative backend but SessionConfig.resourceServer/resourceServerInstance " +
        "are not set — the quarantine consult is DISABLED for this session (a prior strand on this " +
        "tier will not be detected, and this session cannot durably record a new one).",
    );
  }
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
    // Authoritative backends: whatever lands here is corrected below (3d) once the real
    // compiled version is known, so there's no need to read app.json twice — "0.0.0.0" is a
    // harmless placeholder there. Non-authoritative (deploy:"none") backends never get that
    // correction (see readAppVersionBestEffort's doc comment), so fall back to the project's
    // own app.json version instead of the placeholder when the caller didn't already supply one.
    appVersion:
      cfg.appVersion ??
      (caps.authoritative ? undefined : await readAppVersionBestEffort(cfg.projectDir)) ??
      "0.0.0.0",
  });

  const {
    files: allFiles,
    skipped: notInstrumentedFiles,
    totalFiles: totalAlFiles,
  } = await generateMutationSet(cfg.projectDir);
  const artifacts = planArtifacts(allFiles);

  const outcomes: SessionOutcome[] = []; // internal accumulation for the report
  let baselineGreenOverall = true;
  // Task 6 (spec §9): qualified names of baseline tests that did not pass
  // (fail/error) across all batches — surfaced in the report so an unsupported
  // test type (or a broken test) is named, never silently dropped.
  const unsupportedTestNames = new Set<string>();
  // Math.floor: a fractional workers value (e.g. 2.5) would otherwise reach
  // shardEvenly's `Array.from({ length: n }, ...)`, which silently truncates
  // to a shorter array than `i % n` can index into — mutants landing on the
  // missing fractional index are dropped with no error (shardEvenly's own
  // `if (target !== undefined)` guard swallows them).
  const workers = Math.max(1, Math.floor(cfg.workers ?? 1));
  // Layer 5C-A Task 8, Task 10 (design §G, preconditions): bcdev (authoritative) is single-flight
  // in 5C-A — the single `LC Mutation Active` row is not lease-protected against concurrent
  // RunMutant calls, so two workers racing activate()/run() against the same container could
  // silently cross-attribute a verdict to the wrong mutant. Cross-process safety (a real lease)
  // is 5C-B; for now this must fail loudly rather than let it happen. al-runner (non-
  // authoritative) has its own per-worker process/backend and is unaffected.
  if (caps.authoritative && workers > 1) {
    throw new Error(
      `runSession: workers=${workers} > 1 is rejected for an authoritative (bcdev) backend in Layer 5C-A — the single LC Mutation Active row is not lease-protected against parallel RunMutant calls (cross-process safety is 5C-B).`,
    );
  }
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

  // Layer 5C-B1 (design §6 step 1): acquire the machine-global lease BEFORE the first deploy —
  // outside the try/finally below, since a failed acquire has nothing to release. Everything from
  // here on (publish fence, heartbeat, fenced RunMutant, release) hangs off this one lease.
  let leaseSession: LeaseSession | undefined;
  /**
   * Layer 5C-B1 (design §5): re-seeds the backend's op-seq counter before the ONE retry a
   * `pre-dispatch-rejected` run earns — see `LeaseSession.resyncOpSeq`. Built here, once, so
   * BOTH `runOnce` call sites that dispatch against `cfg.backend` (the baseline loop and, via
   * `runMutantsOnBackend`, the per-mutant loop) carry it. A call site without it is safe only
   * while the backend reports `coverage: "procedure"` (the baseline then never takes the fenced
   * RunMutant path); the day an authoritative backend reports `coverage: "none"`, a baseline
   * retry would send a stale-high `opSeq`, be refused `reason:"lease-invalid"`, and be
   * indistinguishable at the client from genuine lease loss — falsely quarantining a healthy
   * session. Nothing at the call site would record that dependency, so it is simply passed.
   */
  let resyncSessionOpSeq: (() => Promise<void>) | undefined;
  if (cfg.lease !== undefined) {
    const leaseCfg = cfg.lease;
    const ttlSeconds = leaseCfg.ttlSeconds ?? MAX_TTL_SECONDS;
    // Checked BEFORE acquiring: a backend that cannot take the lease would otherwise leave a
    // just-acquired lease held (with no heartbeat and no release) until it lapsed, locking out
    // every other session on this container for the full ttl.
    leaseBindableOrThrow(cfg.backend);
    const lease = await acquireSessionLease({
      cfg: leaseCfg,
      // design §6: owner id = host:pid:runId — enough for a human reading a `held` refusal to
      // find the other session, and unique per run without a registry.
      owner: leaseCfg.owner ?? `${hostname()}:${process.pid}:${runId}`,
      ttlSeconds,
      quarantineStore,
      resourceKey,
      nowIso,
    });
    const session = new LeaseSession({
      client: leaseCfg.client,
      lease,
      safety,
      ttlSeconds,
      timers: leaseCfg.timers ?? REAL_TIMERS,
      sleep: leaseCfg.sleep ?? defaultSleep,
      quarantineStore,
      resourceKey,
      nowIso,
      runId,
    });
    leaseSession = session;
    resyncSessionOpSeq = () => session.resyncOpSeq(cfg.backend);
    // Bind before anything can run: the backend fails loudly on a RunMutant with no lease bound,
    // and this is also the fail-loud point for a backend that cannot take one at all.
    bindLeaseToBackend(cfg.backend, lease);
    session.start();
  }

  // R26: the permission canary's measured verdict for THIS session, or `undefined` when no canary
  // was configured (al-runner; every in-memory-backend unit test). Declared out here so it reaches
  // `buildReport` at the very end — the whole point is that it survives into `--out` JSON and gets
  // repeated after the score, not that it flashes past once in stderr.
  let permissionCanary: PermissionCanaryResult | undefined;

  try {
    // R26: run it EXACTLY ONCE, here — after the lease is acquired above (the canary drives the
    // platform test runner through the same `Test Suite Mgt.RunAllTests` path `RunMutant` uses,
    // which is exactly what the lease serialises) and before the first deploy, let alone the first
    // mutant. Inside the `try` rather than before it, so its lease is still released by the
    // `finally` below whatever happens here.
    if (cfg.permissionCanary !== undefined) {
      permissionCanary = await runPermissionCanaryQuietly(cfg.permissionCanary);
      for (const line of permissionCanaryWarnings(permissionCanary)) console.warn(line);
    }
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
      // Layer 5C-B1 (design §6): a lease lost during THIS batch invalidates exactly THIS batch's
      // verdicts at session end — earlier batches stand, every RunMutant in them having been
      // individually fence-validated. The heartbeat runs on a timer and can observe the loss at
      // any moment, so it needs the current batch index, not the one the mutant loop last saw.
      if (leaseSession !== undefined) leaseSession.currentBatchIndex = batchIdx;
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
        compiled = await deployOnce(cfg.backend, safety, leaseSession, batchDir);
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
            // A fresh publish op (design §4/§6): the first attempt's marker was already
            // tombstoned by its `EndPublish("failed")` — a version conflict is BC naming the
            // installed version verbatim, i.e. a confirmed deterministic rejection.
            compiled = await deployOnce(cfg.backend, safety, leaseSession, batchDir);
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
      // Layer 5C-B1 (design §5): this batch's publish consumed an op seq from the SAME
      // server-side sequence every RunMutant claims against, so the backend's counter must
      // continue after it — not from the acquire grant's now-stale `lastCompletedOpSeq`.
      if (leaseSession !== undefined) leaseSession.rebindBackend(cfg.backend);

      // 4. baseline
      await activateOnce(cfg.backend, safety, null);
      const baseline: Array<{ ref: TestMethodRef; verdict: TestVerdict }> = [];
      for (const ref of tests) {
        const v = await runOnce(
          cfg.backend,
          safety,
          ref,
          {
            coverage: caps.coverage,
            timeoutMs: cfg.baselineTimeoutMs ?? BASELINE_TIMEOUT_DEFAULT,
          },
          resyncSessionOpSeq,
        );
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
        // Layer 5C-B1 (design §5/§6/§8): a lease answer must be classified BEFORE the generic
        // `requiresUnsafeLatch` quarantine below, which would otherwise record a durable tier
        // quarantine for a lease loss that leaves the container perfectly healthy — and would
        // treat a same-attempt duplicate claim as a loss.
        const baselineLease = classifyLeaseVerdict(v);
        if (baselineLease !== "none") {
          await handleBaselineLeaseOutcome({
            kind: baselineLease,
            safety,
            leaseSession,
            ref,
            verdict: v,
          });
          break;
        }
        if (v.operation !== undefined && requiresUnsafeLatch(v.operation)) {
          // The server may still be executing this baseline test. Latch unsafe, record a
          // durable tier quarantine, and stop collecting baseline results — no further
          // work-plane call (spec §8, §12). A stranded baseline test leaves nothing safe to
          // do with `greenTests`/mutant scheduling either way, so there's nothing left but to
          // stop (checked via `safety.isUnsafe` right below, same as the post-batch guard).
          await quarantineInFlight({
            safety,
            quarantineStore,
            resourceKey,
            nowIso,
            detail: `baseline test in-flight-unknown running ${ref.method}`,
          });
          break;
        }
        baseline.push({ ref, verdict: v });
      }
      if (safety.isUnsafe) break; // stop the whole session — no mutant scheduling, no next batch
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

      // Task 6 (spec §9): baseline tests that did not pass (fail/error — NOT
      // deadline-exceeded/timeout, which are infra/timing) can't run in the
      // web-service session; a TestPage/unsupported test type surfaces exactly
      // this way. They still return coverage at baseline (the bc-dev hub
      // collects it regardless of outcome), so a mutant may be covered ONLY by
      // one of them. Name every such test in the report; below, distinguish a
      // mutant covered only by one from a genuinely uncovered mutant.
      const unsupportedBaseline = baseline.filter((b) => didNotPassAtBaseline(b.verdict.outcome));
      for (const b of unsupportedBaseline) unsupportedTestNames.add(qualifiedTestName(b.ref));

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
      // A mutant uncovered by any GREEN test but covered by a non-passing
      // baseline test is `error` (score-excluded) with a named note — never a
      // silent `no-coverage` false-negative (a real test DOES cover it; it just
      // couldn't run). `unsupportedCoverage` reuses coverageFilter against the
      // second index; empty for coverage:"none" (uncovered is empty there too).
      const unsupportedCoverage =
        uncovered.length === 0
          ? new Map<string, readonly TestMethodRef[]>()
          : coverageFilter(
              uncovered,
              buildCoverageIndex(
                unsupportedBaseline.map((b) => ({
                  ref: b.ref,
                  ...(b.verdict.coverage !== undefined ? { coverage: b.verdict.coverage } : {}),
                })),
              ),
              unsupportedBaseline.map((b) => b.ref),
            ).covered;
      for (const m of uncovered) {
        const covering = unsupportedCoverage.get(m.mutantId);
        if (covering !== undefined && covering.length > 0) {
          const names = [...new Set(covering.map(qualifiedTestName))].sort().join(", ");
          record(
            cfg.store,
            runId,
            m,
            "error",
            outcomes,
            batchIdx,
            undefined,
            `unsupported test type: mutant covered only by test(s) that did not pass at baseline (${names})`,
          );
        } else {
          record(cfg.store, runId, m, "no-coverage", outcomes, batchIdx);
        }
      }

      // 6. per-mutant loop — sharded across workers when workers > 1. The
      // baseline/coverage discovery above always runs once against
      // cfg.backend; only the kill-detection phase below fans out, since
      // that's the part that's actually per-mutant work.
      const fallbackTimeoutMs = cfg.baselineTimeoutMs ?? BASELINE_TIMEOUT_DEFAULT;
      // Layer 5C-A Task 8, Task 10 (design §G): per-ARTIFACT clean-attestation ledger. Declared
      // fresh for each batch (each batch republishes its own artifactId) — `clean` flips true the
      // first time ANY covered run (across every worker/shard sharing this one artifact) reports
      // `attestation.observedAny === true && identityMismatch !== true`. Checked against
      // `contributed` right after the mutant work below finishes, before the next batch (or the
      // final `buildReport`) ever sees this batch's verdicts.
      const attestation = { clean: false };
      if (workers === 1) {
        // Sequential IS the parallel path with a pool of one: this is the
        // exact same runMutantsOnBackend call the fan-out branch below makes
        // per shard, just with all of `execute` as a single "shard" on the
        // one backend already deployed in step 3.
        await runMutantsOnBackend({
          backend: cfg.backend,
          safety,
          ...(leaseSession !== undefined ? { leaseSession } : {}),
          mutants: execute,
          perMutantTests,
          baselineDuration,
          fallbackTimeoutMs,
          store: cfg.store,
          runId,
          batchIndex: batchIdx,
          outcomes,
          quarantineStore,
          resourceKey,
          nowIso,
          attestation,
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
              // Latch-guarded like every other work-plane dispatch (design §6). No publish fence
              // here: `workers > 1` is rejected outright for an authoritative backend (above), so
              // a worker shard never publishes under a lease.
              await compileLimit.run(() => {
                safety.assertSafe(`deploy(${batchDir}) worker ${i}`);
                return backend.deploy(batchDir);
              });
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
              safety,
              mutants: shard,
              perMutantTests,
              baselineDuration,
              fallbackTimeoutMs,
              store: cfg.store,
              runId,
              batchIndex: batchIdx,
              outcomes,
              quarantineStore,
              resourceKey,
              nowIso,
              attestation,
            });
          }),
        );
        const firstRejection = settled.find(
          (r): r is PromiseRejectedResult => r.status === "rejected",
        );
        if (firstRejection !== undefined) throw firstRejection.reason;
      }
      // Layer 5C-A Task 8, Task 10 (design §G): per-artifact fail-closed attestation gate. A
      // batch "contributed verdicts" if any mutant it scheduled had >=1 covering test (a batch
      // with nothing but no-coverage/unsupported mutants has nothing a wrong binary could fake).
      // For an authoritative backend, a contributing batch that never earned a single clean
      // attestation means no covered run ever confirmed the deployed binary is actually running
      // — a wrong/stale container legitimately returns observedAny=false on every run (coverage
      // over-approximates) and every test would pass, silently accumulating false "survived"
      // verdicts. Invalidate this batch's verdicts and quarantine BEFORE any of them can leave
      // the orchestrator (`buildReport` only runs once, at `runSession`'s return, below).
      // al-runner (non-authoritative) carries no attestation at all — `attestation.clean` would
      // always be false there, so this gate is scoped to `caps.authoritative` to avoid misfiring
      // on every al-runner session.
      //
      // MUST run even when this batch already latched `safety` unsafe for a DIFFERENT, more
      // specific reason (e.g. mutant M2 hit an in-flight-unknown mid-batch): an earlier mutant M1
      // in the SAME batch may already have been recorded a (false) "survived" — from the SAME
      // unattested binary — before M2 ever ran, and skipping the gate here would let that false
      // survivor ship in `report.mutants`/`counts` untouched. `invalidateBatchVerdicts` (below)
      // is what protects M2's own specific diagnostic from being clobbered by this gate's generic
      // note, not a guard here.
      const contributed = execute.some((m) => (perMutantTests.get(m.mutantId)?.length ?? 0) > 0);
      if (caps.authoritative && contributed && !attestation.clean) {
        const note = `unattested artifact: no covered run observed the deployed binary's selector (artifactId ${compiled?.artifactId ?? "unknown"}) — verdicts discarded, container quarantined (design §G)`;
        invalidateBatchVerdicts(outcomes, batchIdx, note);
        safety.latchUnsafe(note);
      }
      // Task 12 (spec §8/§12): an in-flight-unknown deadline anywhere in this batch's mutant
      // loop latches `safety` and records a durable quarantine — no further batch may schedule
      // any work-plane call (deploy/activate/run) against a tier that may still be stranded.
      if (safety.isUnsafe) break;
    }
  } catch (err) {
    // Layer 5C-B1 (design §6): every work-plane dispatch — deploy, activate AND run — is guarded
    // by the latch, and the latch can now be set ASYNCHRONOUSLY (the renew heartbeat fires on a
    // timer, mid-mutant). A guard that refuses a dispatch is the system working as designed, not
    // a session failure: the latch already recorded WHY, this batch's verdicts are invalidated
    // below, and the report carries `quarantined`. Rejecting here instead would throw all of that
    // away. Every other error still propagates untouched.
    if (!(err instanceof SessionUnsafeError)) throw err;
  } finally {
    // Best-effort cleanup: deliberately swallow errors here (unlike the
    // retrying activation calls above) since this only runs to leave every
    // backend deactivated on exit, and a failure here must not mask/replace
    // whatever real error is already propagating.
    //
    // After an unsafe latch, NO work-plane call — not even the deactivating ClearActive, which is
    // itself a mutating op on the stranded tier (spec §8). Only local teardown runs.
    if (!safety.isUnsafe) {
      await cfg.backend.activate(null).catch(() => {});
      for (const backend of workerBackends) {
        await backend.activate(null).catch(() => {});
        await closeIfSupported(backend).catch(() => {});
      }
    } else {
      // local teardown only: close transports/children, never activate.
      await closeIfSupported(cfg.backend).catch(() => {});
      for (const backend of workerBackends) {
        await closeIfSupported(backend).catch(() => {});
      }
    }
    // Layer 5C-B1 (design §6 step 5): stop the heartbeat and release the lease — op-gated, so a
    // tier with an unresolved operation marker is left held (and durably quarantined) rather than
    // handed to the next session. Last in the teardown so the backend's own deactivating
    // ClearActive (above) still runs under the lease it was taken with.
    if (leaseSession !== undefined) await leaseSession.finish();
  }

  // Layer 5C-B1 (design §6, verbatim): "at session end — after the batch loop breaks, before
  // buildReport — invalidate the CURRENT batch's verdicts". The artifact those verdicts came from
  // was deployed under a lease this session can no longer prove it held, so nothing measured
  // against it is trustworthy. EARLIER batches stand: every RunMutant in them was individually
  // phase-1/phase-3 fence-validated, so invalidating them would be over-invalidation.
  //
  // Deliberately NOT delegated to design §G's attestation gate — that gate skips a batch that
  // already earned a clean attestation, which a batch can do moments before the lease is lost.
  const lostBatchIndex = leaseSession?.lostBatchIndex;
  if (lostBatchIndex !== undefined) {
    invalidateBatchVerdicts(
      outcomes,
      lostBatchIndex,
      `lease-lost: this batch's artifact was deployed under a lease this session could no longer prove it held (${safety.reason ?? "unknown"}) — verdicts discarded (design §6)`,
    );
  }

  // Layer 5C-A Task 8, Task 10 (design §G): a quarantined run must NEVER be marked finished.
  // `priorSurvivorKeys` (store.ts) selects the most recent run with `finished_at IS NOT NULL` and
  // treats its "survived"/"known-survivor" mutant rows as a future session's skip-list
  // (skipKnownSurvivors). `invalidateBatchVerdicts` only corrects the in-memory `outcomes[]` — the
  // `mutants` rows this session already wrote to `store` keep whatever verdict they had at
  // `record()` time (no store-row-update API exists). Leaving `finished_at` NULL for a quarantined
  // run excludes it from `priorSurvivorKeys` entirely, so those uncorrected on-disk rows (which
  // may include a false "survived" from an unproven binary) can never seed a future skip-list.
  // Verified no other consumer reads `finished_at`/`batch_count`/`baseline_green` (grepped
  // `finishRun`/`finished_at` across src/cli/itest): the only reader is `priorSurvivorKeys`'s
  // `WHERE finished_at IS NOT NULL` filter. `runs.app_version`/`app_id`/`artifact_id` provenance
  // is written by `createRun`/`recordArtifact`, never by `finishRun` — so app-version reservation
  // (clock-derived via `reserveAppVersion`, Layer 5A) has no dependency on this run ever finishing.
  if (!safety.isUnsafe) {
    cfg.store.finishRun(runId, {
      batchCount: artifacts.length,
      baselineGreen: baselineGreenOverall,
    });
  }
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
    unsupportedTests: [...unsupportedTestNames].sort(),
    notInstrumented: { totalFiles: totalAlFiles, files: notInstrumentedFiles },
    ...(safety.isUnsafe ? { quarantined: { reason: safety.reason ?? "unknown" } } : {}),
    ...(permissionCanary !== undefined ? { permissionCanary } : {}),
  });
}

/**
 * R26: runs the configured permission canary and guarantees it cannot end the session.
 *
 * The production implementation (`runPermissionCanary`, permission-canary.ts) already turns every
 * server-side and transport failure into an `"inconclusive"` result rather than throwing, so in
 * practice this catch never fires. It exists because the alternative failure mode is
 * catastrophically asymmetric: a canary that threw would abort a real mutation session BEFORE A
 * SINGLE MUTANT RAN, producing no `SessionReport` at all — the exact outcome the al-runner canary
 * (R7/R8) learned to guard against the hard way, and a far worse one than simply not knowing
 * whether the permission mock is active. The reason is preserved verbatim in `detail`, so a
 * genuinely broken canary is loud in the report rather than silently absent from it.
 */
async function runPermissionCanaryQuietly(
  canary: () => Promise<PermissionCanaryResult>,
): Promise<PermissionCanaryResult> {
  try {
    return await canary();
  } catch (err) {
    return {
      verdict: "inconclusive",
      detail: `the permission canary itself failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * A baseline test outcome that means the test did not pass and the failure is
 * evidence about the TEST, not the infrastructure (spec §9). `fail`/`error`
 * only: a web-service session cannot open TestPages, and an unsupported test
 * type surfaces as one of these. `deadline-exceeded`/`timeout` are our timer /
 * runner nontermination (infra/timing, not a test-type verdict), and `skip`/
 * `pass` are legitimate. Deliberately a single predicate so the two call sites
 * (report naming + the covered-only-by-unsupported exclusion) cannot drift.
 */
function didNotPassAtBaseline(o: TestVerdict["outcome"]): boolean {
  return o === "fail" || o === "error";
}

/** Human-readable `Codeunit.method` identity for report/notes — unambiguous across codeunits sharing a method name. */
function qualifiedTestName(ref: TestMethodRef): string {
  return `${ref.codeunitName}.${ref.method}`;
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
  readonly safety: SessionSafety;
  readonly mutants: readonly MutantManifestEntry[];
  readonly perMutantTests: ReadonlyMap<string, readonly TestMethodRef[]>;
  readonly baselineDuration: ReadonlyMap<string, number>;
  readonly fallbackTimeoutMs: number;
  readonly store: ResultsStore;
  readonly runId: number;
  readonly batchIndex: number;
  readonly outcomes: SessionOutcome[];
  /**
   * Durable-quarantine sink for an in-flight-unknown deadline (Task 12, spec §9). `undefined`
   * for exactly the sessions `runSession`'s own consult block already tolerates missing tier
   * identity for — al-runner (no shared server-side tier to strand) or an authoritative caller
   * that omitted `resourceServer`/`resourceServerInstance` — the latch still always trips in
   * that case, there's just nothing durable on disk to record.
   */
  readonly quarantineStore?: QuarantineStore | undefined;
  readonly resourceKey?: string | undefined;
  readonly nowIso: () => string;
  /**
   * Layer 5C-A Task 8, Task 10 (design §G): this batch's artifact-scoped clean-attestation
   * ledger — shared (by reference) across every worker/shard `runSession` fans this batch's
   * mutants out to, since they all exercise the SAME deployed artifact. Mutated in place: set
   * `clean = true` the first time any covered run attests cleanly, never reset.
   */
  readonly attestation: { clean: boolean };
  /**
   * Layer 5C-B1: the session's lease, when it holds one. Present only for an authoritative
   * session configured with `SessionConfig.lease` — the branch that classifies a `lease-lost`
   * verdict still latches without it (via `safety`), it just cannot poll or scope an
   * invalidation.
   */
  readonly leaseSession?: LeaseSession | undefined;
}): Promise<void> {
  const leaseSession = args.leaseSession;
  const resyncOpSeq =
    leaseSession !== undefined ? () => leaseSession.resyncOpSeq(args.backend) : undefined;
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
    await activateOnce(args.backend, args.safety, m.mutantId);
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
      const budget = Math.max(
        2 * (args.baselineDuration.get(testKeyOf(ref)) ?? args.fallbackTimeoutMs),
        MIN_MUTANT_BUDGET_MS,
      );
      // Layer 5C-B2: `runFenced`, not `runOnce` — a lost ack that reconciliation PROVES completed
      // earns one fresh attempt, and `v` is then that attempt's verdict. Only the final verdict is
      // buffered/attested/classified below, exactly as `runOnce`'s own pre-dispatch-rejected retry
      // already behaves.
      const {
        verdict: v,
        lostAck,
        retried,
      } = await runFenced(
        args.backend,
        args.safety,
        ref,
        { coverage: "none", timeoutMs: budget },
        leaseSession,
        resyncOpSeq,
      );
      testResultBuffer.push({
        mutantCode: m.mutantId,
        ref,
        outcome: v.outcome,
        durationMs: v.durationMs,
        failureMessage: v.failureMessage,
      });
      spent += v.durationMs;
      // Layer 5C-A Task 8, Task 10 (design §G): this covering run went through the coverage:
      // "none" transport path (the only path that ever attests) — feed the artifact's ledger.
      if (v.attestation?.observedAny === true && v.attestation.identityMismatch !== true) {
        args.attestation.clean = true;
      }
      // Layer 5C-B1 (design §5/§6/§8): classify a lease answer BEFORE the generic
      // `requiresUnsafeLatch` branch below. That branch is right for `in-flight-unknown` and
      // WRONG for both lease kinds: it would record a durable tier quarantine for a lease loss
      // that leaves the container healthy, and it would latch (and so invalidate the whole batch)
      // for a same-attempt duplicate claim that is not a loss at all.
      const leaseKind = classifyLeaseVerdict(v);
      if (leaseKind === "lost") {
        // Genuine loss: latch `lease-lost`, stop scheduling. The current batch's verdicts are
        // invalidated at session end (design §6) — NOT here, because earlier mutants of this same
        // batch were already recorded and only `runSession` can rewrite them. No durable tier
        // quarantine: a clean lease loss means the container itself is fine.
        const detail = `${ref.method} (mutant ${m.mutantId}): ${v.failureMessage ?? "RunMutant lease-invalid"}`;
        noteLeaseLostOrThrow(leaseSession, detail);
        verdict = "error";
        failureNote = `lease-lost while running ${ref.method}: this run's result was refused by the fence and never recorded server-side`;
        break;
      }
      if (leaseKind === "op-in-flight") {
        // OUR OWN (opSeq, attemptId) is still executing server-side. design §5: poll/wait — never
        // re-dispatch (the server would refuse the duplicate again, forever), never `RecoverOp`
        // (the op may still be running AL, which is exactly what that rule protects), and never
        // treat this as lease loss. This mutant's result is simply lost; the session continues.
        const cleared = (await leaseSession?.pollUntilOpClears()) ?? false;
        verdict = "error";
        if (cleared) {
          failureNote = `op-in-flight: RunMutant refused a duplicate claim on this attempt while it was still executing; the operation has since completed but its result was not returned, so ${ref.method}'s verdict for this mutant is discarded rather than re-dispatched (design §5)`;
        } else {
          failureNote =
            "op-in-flight: RunMutant refused a duplicate claim on this attempt and the operation never cleared — the container may still be executing it";
          cause = "deadline-exceeded";
          await quarantineInFlight({
            safety: args.safety,
            quarantineStore: args.quarantineStore,
            resourceKey: args.resourceKey,
            nowIso: args.nowIso,
            detail: `operation never cleared after an op-in-flight refusal running ${ref.method} (mutant ${m.mutantId})`,
          });
        }
        break;
      }
      if (v.operation !== undefined && requiresUnsafeLatch(v.operation)) {
        // Layer 5C-B2 (design §5): reaching here means `runFenced` could not turn this run into a
        // readable answer — it already reconciled, and (when the op was proven complete) already
        // spent its one fresh attempt on it. All that is left is which diagnosis to record.
        verdict = "error";
        if (lostAck === "completed") {
          // Phase 3 ran: the op is tombstoned and the container is clean. This mutant's RESULT is
          // genuinely lost (so `error`, never a verdict), but there is nothing to recycle, nothing
          // to latch, and the session runs on to the next mutant.
          failureNote = `lost ack running ${ref.method}: RunMutant's response was unreadable${v.failureMessage !== undefined ? ` (${v.failureMessage})` : ""}, but GetOperationStatus confirms the operation COMPLETED server-side — the run was retried once and that attempt was unreadable too, so this mutant's result is discarded; the container is not stranded (design §5)`;
          break;
        }
        // Unresolved: latch unsafe, record a durable tier quarantine, and stop — no further
        // work-plane call (spec §8, §12).
        await quarantineInFlight({
          safety: args.safety,
          quarantineStore: args.quarantineStore,
          resourceKey: args.resourceKey,
          nowIso: args.nowIso,
          // Carry the transport's own failure message into the record. Without it the operator
          // is told to recycle a tier and clear a quarantine with no statement of what actually
          // went wrong — and this record outlives the process that wrote it.
          detail: `test in-flight-unknown running ${ref.method} (mutant ${m.mutantId})${retried ? " — a first, proven-complete attempt had already been retried once" : ""}${v.failureMessage !== undefined ? `: ${v.failureMessage}` : ""}`,
        });
        failureNote = `quarantined: ${ref.method} returned no readable result and its operation could not be confirmed complete — container may be stranded`;
        break;
      }
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
        // runOnce already retried a pre-dispatch-rejected run internally — reaching "error"
        // here means either that retry also failed, or the first failure wasn't retry-safe
        // (e.g. in-flight-unknown) and was rethrown as-is without a second attempt. Spec §11:
        // that aborts the whole session, not just this mutant (unlike the "unstable test" error
        // path below, which is a legitimate flakiness finding, not a transport failure).
        verdict = "error";
        failureNote = v.failureMessage;
        transportErrorRef = ref;
        break;
      }
      if (v.outcome === "fail") {
        await activateOnce(args.backend, args.safety, null);
        // Layer 5C-B2: `runFenced` here too — the confirm rerun earns the same single fresh
        // attempt after a proven-complete lost ack, so an intermittent unreadable answer during
        // confirmation costs a kill verdict no more than it costs a covering run's.
        const {
          verdict: confirm,
          lostAck: confirmLostAck,
          retried: confirmRetried,
        } = await runFenced(
          args.backend,
          args.safety,
          ref,
          { coverage: "none", timeoutMs: budget },
          leaseSession,
          resyncOpSeq,
        );
        testResultBuffer.push({
          mutantCode: null,
          ref,
          outcome: confirm.outcome,
          durationMs: confirm.durationMs,
          failureMessage: confirm.failureMessage,
        });
        // Layer 5C-A Task 8, Task 10 (design §G): the kill-confirmation rerun is a
        // null-activation run that ALSO goes through the coverage:"none" transport path (see
        // the covering-run feed above) — it attests too, so it must feed the same ledger.
        if (
          confirm.attestation?.observedAny === true &&
          confirm.attestation.identityMismatch !== true
        ) {
          args.attestation.clean = true;
        }
        const confirmLease = classifyLeaseVerdict(confirm);
        if (confirmLease !== "none") {
          // Same design §5/§6 split as the covering run above, applied to the confirmation rerun:
          // a genuine loss latches `lease-lost` (no durable quarantine — the container is fine);
          // an op-in-flight duplicate is polled out, never re-dispatched, and never latched.
          const detail = `confirming ${ref.method} (mutant ${m.mutantId}): ${confirm.failureMessage ?? "RunMutant lease-invalid"}`;
          verdict = "error";
          if (confirmLease === "lost") {
            noteLeaseLostOrThrow(leaseSession, detail);
            failureNote = `lease-lost while ${detail} — the kill could not be confirmed under a provable lease`;
          } else {
            const cleared = (await leaseSession?.pollUntilOpClears()) ?? false;
            failureNote = `op-in-flight while ${detail} — polled instead of re-dispatched (design §5); the operation ${cleared ? "cleared, but its result was not returned" : "never cleared"}`;
            if (!cleared) {
              cause = "deadline-exceeded";
              await quarantineInFlight({
                safety: args.safety,
                quarantineStore: args.quarantineStore,
                resourceKey: args.resourceKey,
                nowIso: args.nowIso,
                detail: `operation never cleared after an op-in-flight refusal confirming ${ref.method} (mutant ${m.mutantId})`,
              });
            }
          }
        } else if (confirm.operation !== undefined && requiresUnsafeLatch(confirm.operation)) {
          // Layer 5C-B2 (design §5): `runFenced` already reconciled this answer and, when the op
          // was proven complete, already spent its one fresh attempt. The kill is unconfirmable
          // either way (`error`, never `killed`); what differs is whether the tier is condemned.
          // The post-loop `safety.isUnsafe` check (below) stops scheduling only if it is.
          verdict = "error";
          if (confirmLostAck === "completed") {
            failureNote = `lost ack confirming ${ref.method}: RunMutant's response was unreadable${confirm.failureMessage !== undefined ? ` (${confirm.failureMessage})` : ""}, but GetOperationStatus confirms the operation COMPLETED server-side — the confirmation was retried once and that attempt was unreadable too, so the kill could not be confirmed; the container is not stranded (design §5)`;
          } else {
            await quarantineInFlight({
              safety: args.safety,
              quarantineStore: args.quarantineStore,
              resourceKey: args.resourceKey,
              nowIso: args.nowIso,
              detail: `test in-flight-unknown confirming ${ref.method} (mutant ${m.mutantId})${confirmRetried ? " — a first, proven-complete attempt had already been retried once" : ""}${confirm.failureMessage !== undefined ? `: ${confirm.failureMessage}` : ""}`,
            });
            failureNote = `quarantined: ${ref.method} confirm returned no readable result and its operation could not be confirmed complete — container may be stranded`;
          }
        } else if (confirm.outcome === "pass") {
          verdict = "killed";
          killingTest = ref.method;
        } else if (confirm.outcome === "deadline-exceeded") {
          // Our timer, not the runner's, fired during confirmation — infrastructure,
          // not evidence the test is flaky. Must not inflate counts.unstable.
          verdict = "error";
          failureNote = `deadline exceeded confirming ${ref.method} (infrastructure, not a kill)`;
          cause = "deadline-exceeded";
        } else {
          // Fails under the mutant AND at baseline: by construction this says nothing about the
          // mutant, so it stays `error cause=unstable` (the verdict is NOT reconsidered below).
          // But "unstable" is a guess about flakiness, and one specific cause is deterministic and
          // fully explicable: a test codeunit that omits `TestPermissions = Disabled` is stripped
          // of write permission and refused on BOTH runs, every time (ROADMAP R26, measured A/B —
          // see `describeTestPermissionsRefusal`). When BC's own refusal text is in either run's
          // message, NAME it here rather than leave the user with "unstable" for a one-line fix.
          // Strictly additive: the diagnosis is appended to the note, never substituted for the
          // failure, and this branch is only reachable once the outcome is already decided.
          verdict = "error";
          const refusal =
            describeTestPermissionsRefusal(confirm.failureMessage) ??
            describeTestPermissionsRefusal(v.failureMessage);
          failureNote = `unstable test ${ref.method}: fails at baseline confirmation${
            refusal !== undefined ? ` — ${refusal}` : ""
          }`;
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
    // Task 12 (spec §8/§12): the in-flight-unknown branch above just latched `safety` — stop
    // scheduling further mutants in THIS shard rather than letting the next iteration's
    // `activateOnce` discover the latch by throwing `SessionUnsafeError`. Checked here (after
    // this mutant's own record/flush completed) rather than relying on that throw so the shard
    // returns normally and `runSession` can still assemble a `quarantined` report instead of
    // rejecting.
    if (args.safety.isUnsafe) break;
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
 * One activation attempt. Retries ONLY a `pre-dispatch-rejected` failure (provably never reached
 * the server). An `in-flight-unknown` failure latches the session unsafe and rethrows — retrying
 * an activation that may still be executing is the death-spiral trigger (spec §12). A
 * `completed-effect-unknown` failure is NOT retried either — it is rethrown for the mutant loop to
 * record the affected mutant as an untrustworthy `error` (reconciliation-by-read is deferred to 5C).
 */
export async function activateOnce(
  backend: ExecutionBackend,
  safety: SessionSafety,
  mutantId: string | null,
): Promise<void> {
  safety.assertSafe(`activate(${mutantId ?? "null"})`);
  try {
    await backend.activate(mutantId);
  } catch (err) {
    if (err instanceof ActivationFailure) {
      if (isRetrySafe(err.outcome)) {
        // Layer 5C-B1 (design §6): the retry is a SECOND work-plane dispatch, and the latch can be
        // set ASYNCHRONOUSLY while the first attempt is in flight (the renew heartbeat fires on a
        // timer). The entry guard above cannot speak for it — re-check, exactly as `runOnce` does
        // at its own retry site.
        safety.assertSafe(`activate(${mutantId ?? "null"}) retry`);
        try {
          await backend.activate(mutantId); // one retry: nothing was dispatched the first time
          return;
        } catch (retryErr) {
          // The retry itself is a fresh dispatch — if IT resolves in-flight-unknown, the latch
          // invariant must still trip here, not just on the first attempt's outcome. Without
          // this, a retry-safe-then-ambiguous sequence would rethrow without ever latching
          // `safety`, leaving later work-plane calls (finally's ClearActive included) unguarded.
          if (retryErr instanceof ActivationFailure && requiresUnsafeLatch(retryErr.outcome)) {
            safety.latchUnsafe(`activation retry in-flight-unknown: ${retryErr.message}`);
          }
          throw retryErr;
        }
      }
      if (requiresUnsafeLatch(err.outcome)) {
        safety.latchUnsafe(`activation in-flight-unknown: ${err.message}`);
      }
    }
    throw err;
  }
}

/**
 * One test run. Retries ONLY a `pre-dispatch-rejected` run (the connect never dispatched a test).
 * An `in-flight-unknown` run is never retried — the first run may still be executing server-side.
 *
 * Latch-guarded since Layer 5C-B1 (design §6: "Guard every work-plane dispatch — `deploy`,
 * `activate`, AND `run` — with the latch (today `runOnce` doesn't check it)"). This is not
 * belt-and-braces: the renew heartbeat can latch the session between two dispatches inside a
 * single mutant (covering run → kill-confirmation rerun), where no loop-level `isUnsafe` check
 * stands between them.
 *
 * `resyncOpSeq` runs before the ONE retry a pre-dispatch-rejected run earns: that first attempt
 * consumed a client-side op-seq the server never saw, so without reconciliation the retry would
 * send a too-high `opSeq` and be refused as `lease-invalid` — a FALSE lease loss (see
 * `LeaseSession.resyncOpSeq`).
 */
export async function runOnce(
  backend: ExecutionBackend,
  safety: SessionSafety,
  ref: TestMethodRef,
  opts: { coverage: "none" | "procedure" | "line"; timeoutMs: number },
  resyncOpSeq?: () => Promise<void>,
): Promise<TestVerdict> {
  safety.assertSafe(`run(${ref.codeunitName}.${ref.method})`);
  const first = await backend.run(ref, opts);
  if (first.outcome !== "error") return first;
  if (first.operation !== undefined && isRetrySafe(first.operation)) {
    safety.assertSafe(`run(${ref.codeunitName}.${ref.method}) retry`);
    if (resyncOpSeq !== undefined) await resyncOpSeq();
    return backend.run(ref, opts);
  }
  return first;
}

/**
 * Layer 5C-B1 (design §5/§6): a lease answer on a BASELINE run, which has no per-mutant verdict
 * to carry the diagnosis. Either way the session stops — a baseline that cannot produce a result
 * leaves nothing safe to schedule — but the two kinds stop for different reasons and must not be
 * conflated:
 *   - `lost`: latch `lease-lost` and scope this batch for invalidation. NO durable tier
 *     quarantine — a clean lease loss (epoch mismatch, no stranded op) leaves the container
 *     perfectly healthy (design §6's quarantine taxonomy).
 *   - `op-in-flight`: our OWN attempt is still executing. Poll it out (never re-dispatch, never
 *     `RecoverOp`), and only if it never clears is the tier durably quarantined.
 *
 * `op-in-flight` always latches unsafe below, even when `pollUntilOpClears()` reports the marker
 * cleared (t6, 5C-B2 review — checked whether `LeaseSession.reconcileLostAck`'s later
 * reconciliation, added for the fenced RunMutant lost-ack path, makes this unconditional latch
 * unnecessary here too). It does not: `reconcileLostAck` resolves `in-flight-unknown` — an
 * UNREADABLE answer, where the caller must first establish whose op the marker names and whether
 * it completed. This branch is reached from `classifyLeaseVerdict`'s `lease-lost` case instead — a
 * confirmed, LEGIBLE server refusal (`operation-outcome.ts`'s doc comment) that has already told
 * us the marker is our own and still active; there is nothing left to reconcile. And even a
 * cleared marker doesn't change the actual problem: the baseline RunMutant call for `ref` was
 * REFUSED, not executed, so this session has no pass/fail verdict for it — greenTests can never be
 * complete, and scheduling any mutant against an incomplete baseline is exactly the false-verdict
 * risk this layer exists to close. Recovering would require re-dispatching the baseline test as a
 * fresh attempt post-clear, which `runOnce`'s single `pre-dispatch-rejected` retry does not cover
 * and which is out of scope for this fix (see carried-minors.md t6).
 */
async function handleBaselineLeaseOutcome(args: {
  readonly kind: LeaseVerdictKind;
  readonly safety: SessionSafety;
  readonly leaseSession: LeaseSession | undefined;
  readonly ref: TestMethodRef;
  readonly verdict: TestVerdict;
}): Promise<void> {
  const detail = `baseline test ${args.ref.method}: ${args.verdict.failureMessage ?? "RunMutant lease-invalid"}`;
  if (args.kind === "lost") {
    noteLeaseLostOrThrow(args.leaseSession, detail);
    return;
  }
  const cleared = (await args.leaseSession?.pollUntilOpClears()) ?? false;
  if (!cleared) {
    await args.leaseSession?.recordRecycle(
      `op-in-flight never cleared after ${detail} — the server-side operation may still be executing`,
    );
  }
  args.safety.latchUnsafe(
    `lease op-in-flight at baseline (${detail}) — polled instead of re-dispatched (design §5); the operation ${cleared ? "cleared, but its result was never returned" : "never cleared"}, so no baseline result exists`,
  );
}

/**
 * Layer 5C-A Task 8, Task 10 (design §G): rewrites every UNPROTECTED `SessionOutcome` recorded so
 * far for `batchIndex` to verdict `"error"` with `note` — used by the per-artifact fail-closed
 * attestation gate in `runSession` when a batch's artifact ran verdict-contributing (covered)
 * mutants but earned zero clean attestations. `buildReport` (`runSession`'s only call, at its
 * very return) reads `outcomes` — the in-memory array this function mutates in place — so nothing
 * invalidated here can ever leave the orchestrator as a (false) "survived".
 *
 * Two kinds of entries are deliberately left UNTOUCHED, not swept into the generic "unattested"
 * error:
 *   - `o.cause !== undefined` — already a specifically-classified error (deadline-exceeded /
 *     unstable / an in-flight-unknown quarantine via `quarantineInFlight`) produced by a DIFFERENT
 *     code path that already knows exactly why this one mutant is untrustworthy. Overwriting it
 *     with this gate's generic note would destroy strictly more specific diagnostic information
 *     for no benefit — the mutant is already `"error"` either way.
 *   - `o.verdict === "known-survivor"` — a HISTORY verdict (Task 6, `filterHistory`/
 *     `skipKnownSurvivors`): it was never re-tested against THIS batch's binary at all, so this
 *     artifact's attestation failure says nothing about it.
 * Every other verdict this batch produced — survived, killed, timeout-killed, no-coverage, or a
 * plain (cause-less) error — came from actually exercising the unattested binary and must be
 * invalidated: this is the gate's whole point (a false "survived" is the failure mode being
 * closed).
 *
 * Accepted limitation: this does NOT rewrite the rows `record()` already wrote to `store` for
 * this batch (there is no store-row-update API — `ResultsStore` only ever inserts). `runSession`
 * always pairs this call with `safety.latchUnsafe(note)` immediately after, which marks the WHOLE
 * session `report.quarantined` (spec §8/§12); a quarantined run is never passed to
 * `store.finishRun` (see `runSession`'s return path), so `priorSurvivorKeys`'s
 * `finished_at IS NOT NULL` filter excludes it — its stale on-disk verdicts can never seed a
 * future `--skip-known-survivors` run. A direct SQL read of the raw `mutants` table (bypassing
 * `priorSurvivorKeys`) would still see the uncorrected rows; nothing in this codebase does that.
 */
export function invalidateBatchVerdicts(
  outcomes: SessionOutcome[],
  batchIndex: number,
  note: string,
): void {
  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i];
    if (o === undefined || o.batchIndex !== batchIndex) continue;
    if (o.cause !== undefined || o.verdict === "known-survivor") continue; // preserved, see above
    outcomes[i] = {
      mutant: o.mutant,
      verdict: "error",
      batchIndex: o.batchIndex,
      failureNote: note,
    };
  }
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
