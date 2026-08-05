import { access, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { tier1Operators } from "@lethal/builtin-tier1";
import { tier2Operators } from "@lethal/builtin-tier2";
import {
  type MutationOperator,
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
  type TierResolver,
  canCarryMutationSelectorVar,
  dedupeSpecs,
  describeObjectKinds,
  isMutableSite,
  writeInstrumentedProject,
} from "@lethal/schemata";
import { nextAbove, parseVersionConflict, reserveAppVersion } from "./app-version";
import { AlcCompileError, ArtifactPrepareError, DeploymentError } from "./artifact";
import type { CompiledArtifact } from "./artifact";
import type { CoverageMode, ExecutionBackend, TestMethodRef, TestVerdict } from "./backend";
import { NO_RESULT_FOR_METHOD } from "./bcdev-backend";
import { bisectFailingMutant } from "./bisect";
import { discoverTests } from "./discovery";
import {
  type BaselineClassification,
  type RunEmitter,
  STREAM_SCHEMA_VERSION,
  createEmitter,
} from "./events";
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
  CARRYABLE_VERDICTS,
  STRANDED_NOTE_PREFIX,
  buildResumeIndex,
  carriedVerdictFor,
  sessionFingerprint,
  wasStranded,
} from "./resume";
import type { ResumeIndex } from "./resume";
import { describeRunnerDisagreement } from "./runner-disagreement";
import {
  buildCoverageIndex,
  coverageFilter,
  filterHistory,
  identityKeyOf,
  testKeyOf,
} from "./selection";
import type { CoverageAttribution } from "./selection";
import { SessionSafety, SessionUnsafeError } from "./session-safety";
import type { ResultsStore } from "./store";
import type { MutantVerdict, RunnerKind } from "./store";
import { describeTestPageUnsupported } from "./testpage-unsupported";

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
 * R48: how many executable mutants a session may schedule before it refuses to start unasked.
 *
 * `lethal run --project <a real app>` used to be all-or-nothing, and the all was enormous: Continia
 * Document Output generates 19,832 mutant sites. At the per-mutant cost measured on that project
 * against a hosted environment (~19.5 s mean, p95 43 s, under an all-tests baseline) a whole-app
 * run is measured in DAYS, and the first thing it does is publish an artifact carrying every guard
 * — which the hosting proxy severs at 362 s (R44). So the unscoped run does not merely take a long
 * time; on a real project it usually cannot succeed at all, and it fails after burning an hour.
 *
 * 1,000 sits above every fixture and every plausible "try one area" invocation (one DO codeunit is
 * 163 mutants; `Al/Codeunit/**` is 6,572 and is correctly refused) and below anything whose cost is
 * measured in hours. It is a guardrail on a FIRST run, not a policy: `--allow-large-run`
 * (`SessionConfig.allowLargeRun`) turns it off in full, and the refusal names that flag.
 *
 * Refusal rather than a warning is deliberate. A warning scrolls past in the first second of a run
 * whose cost lands hours later, which is the same as no warning at all.
 */
export const LARGE_RUN_MUTANT_THRESHOLD = 1_000;

/**
 * Every currently registered operator across all tiers, in registration order. The single source
 * both `operatorTiers` (below) and `generateMutationSet`'s tree walk read, so a Tier-2 operator
 * registered in `@lethal/builtin-tier2` needs no second wiring edit here — appending to that
 * package's own `tier2Operators` array is the whole change. Tier 2 holds four operators today
 * (`RemoveTestField`, `RemoveSetRange`, `RemoveCalcFields`, `SwapModifyFlag`).
 */
const allOperators: readonly MutationOperator[] = [...tier1Operators, ...tier2Operators];

/**
 * Tier of every currently registered operator, keyed by name — the mapping
 * `writeInstrumentedProject` needs to resolve Tier-2 narrowings of a Tier-1
 * operator (`dedupeSpecs` in `@lethal/schemata`). `dedupeSpecs`'s `TierResolver`
 * throws on an unregistered operator by design (an unknown tier makes a
 * collision winner depend on registration order), so every operator whose specs
 * can reach dedup must have an entry here. Built once from the same
 * `allOperators` list `generateMutationSet` walks, so a mutant's identity after
 * dedup can never diverge between the two — see `manifestMutants` in
 * `orchestrator.test.ts` for a caller that leans on that parity.
 */
export const operatorTiers: ReadonlyMap<string, 1 | 2 | 3 | "custom"> = new Map(
  allOperators.map((op) => [op.name, op.tier]),
);

/** `TierResolver` bound to `operatorTiers` — the same lookup `writeInstrumentedProject` builds
 *  locally (project.ts) for the identical purpose, shared here so `runSession` can pre-compute a
 *  post-dedup mutant count (R92's `mutation-set-generated.deployedCount`) without redefining it. */
const tierOf: TierResolver = (name) => operatorTiers.get(name);

/**
 * Parse every `.al` file under `projectDir` (skipping emitted `Mutation*`
 * artifacts) and run every registered operator (all tiers) over each: parse the
 * whole project, build ONE semantic context across all of it, then walk each
 * file's tree collecting every spec each operator targets.
 *
 * The context is project-wide, not per-file, because that is the only shape in
 * which the Tier-2 shadowing guard can do its job. `claimsRecordMethod`
 * (`packages/builtin-tier2/src/receiver.ts`) refuses a call whose receiver's
 * table declares a procedure of that name "in the project" (design doc §4.1) —
 * with a per-file context and the normal one-object-per-file AL layout, the
 * table is never in the context, the guard never fires, and the site is claimed
 * as a builtin when it is really that table's own method. Measured both ways;
 * see `generateMutationSet: project-wide semantic context` in
 * `tests/orchestrator.test.ts`. Cost is nil: every root is retained afterwards
 * anyway (`InstrumentedFile.root`), and one table over N files is the same
 * total work as N tables over one file each.
 *
 * Mirrors the ops -> compile -> write pipeline exercised by
 * `packages/builtin-tier1/tests/end-to-end.test.ts`.
 * Overlap resolution isn't needed here (or anywhere downstream
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
  /**
   * R41: `.al` files a `--only` glob excluded from spec generation. 0 when no `only` was given.
   *
   * A FILE count, not a site count, and deliberately so: knowing how many mutation sites the
   * excluded files hold would mean generating their specs, which is the work `--only` exists to
   * avoid. The report says "N files were not considered", never a number it did not measure.
   */
  readonly excludedByOnly: number;
}

export interface MutationSetOptions {
  /**
   * R41: glob patterns naming which project files may contribute mutants. Absent (or empty) means
   * the whole project, the behaviour before `--only` existed.
   *
   * Matched against each file's project-relative path with FORWARD slashes, whatever the
   * platform's own separator is, so one pattern works from a config file or a CI script on any
   * host. A pattern matching no file throws (see `generateMutationSet`) rather than quietly
   * selecting nothing.
   */
  readonly only?: readonly string[];
  /**
   * When present, this function's four `console.warn` calls emit `{ type: "warning" }` events on
   * it instead — `runSession` always passes one (defaulting to a no-op emitter). Absent for the
   * other ~15 call sites across scripts/itests/`cli.ts --dry-run` that call `generateMutationSet`
   * with no event stream of their own: those keep printing to the console exactly as before, so
   * this task does not have to change their unrelated call sites to carry a real-or-no-op emitter
   * just to preserve their existing console output.
   */
  readonly emit?: RunEmitter;
}

/**
 * R41: which project-relative paths a `--only` pattern set admits, with the "matches nothing"
 * refusal. Separated from `generateMutationSet` so the decision is testable without parsing AL,
 * and so the refusal happens BEFORE any file is read.
 *
 * Refusing an unmatched pattern is not pedantry. A typo'd `--only` that silently matched zero
 * files would produce a run with 0 mutants, a null score and no failures — which reads as
 * "nothing to fix" rather than "you named a directory that does not exist". Empty-vs-empty
 * agreement is this project's signature silent-wrong-answer shape.
 */
function admittedByOnly(
  relPaths: readonly string[],
  only: readonly string[],
): ReadonlySet<string> | undefined {
  if (only.length === 0) return undefined;
  const admitted = new Set<string>();
  const unmatched: string[] = [];
  for (const pattern of only) {
    const glob = new Bun.Glob(pattern);
    let matchedAny = false;
    for (const rel of relPaths) {
      if (glob.match(rel.replaceAll("\\", "/"))) {
        admitted.add(rel);
        matchedAny = true;
      }
    }
    if (!matchedAny) unmatched.push(pattern);
  }
  if (unmatched.length > 0) {
    throw new Error(
      `--only matched no .al file for ${unmatched.length === 1 ? "pattern" : "patterns"} ${unmatched.map((p) => `"${p}"`).join(", ")}. Patterns are matched against project-relative paths using forward slashes (e.g. "Al/Codeunit/**"). Refusing rather than running with an empty mutant set, which would report a null score and read as "nothing to fix".`,
    );
  }
  return admitted;
}

export async function generateMutationSet(
  projectDir: string,
  options: MutationSetOptions = {},
): Promise<MutationSetResult> {
  await initParser();
  // See `MutationSetOptions.emit`'s doc comment: only the `runSession` call site ever passes a
  // real emitter here, so every OTHER caller (scripts, itests, `cli.ts --dry-run`) keeps printing
  // to the console exactly as before.
  const emitOpt = options.emit;
  const warn = (code: string, message: string): void => {
    if (emitOpt !== undefined) {
      emitOpt({ type: "warning", code, message });
    } else {
      console.warn(message);
    }
  };
  const files: InstrumentedFile[] = [];
  /** Files with >=1 spec that no selector var can be injected into — reported once, below. */
  const skipped: NotInstrumentedFile[] = [];
  const entries = (await readdir(projectDir, { recursive: true }))
    .filter((e) => e.toLowerCase().endsWith(".al"))
    .filter((e) => !basename(e).startsWith("Mutation"));
  // R41: resolved BEFORE any file is read, so a typo'd pattern fails immediately rather than
  // after a full parse. `undefined` means "no narrowing" — distinct from an empty set, which
  // `admittedByOnly` refuses outright.
  const admitted = admittedByOnly(entries, options.only ?? []);
  // Pass 1: parse every file — INCLUDING files `--only` excluded. Pass 2 (below) walks them
  // against ONE context built over all of them; see this function's doc comment for why the
  // context must be project-wide, and note that narrowing the PARSE set instead of the
  // spec-generation set would make `--only` change verdicts rather than just how many run.
  const parsed = await Promise.all(
    entries.sort().map(async (rel) => {
      const source = await readFile(join(projectDir, rel), "utf8");
      return { path: rel, source, root: wrapRoot(parseAL(source)) };
    }),
  );
  const ctx = buildSemanticContext(parsed.map(({ path, root }) => ({ path, root })));

  let excludedByOnly = 0;
  // Sites an operator claimed that are not inside executable AL — see the drop below.
  let nonExecutableSites = 0;
  for (const { path: rel, source, root } of parsed) {
    // R41: excluded from MUTATION, not from the context above and not from the published app —
    // `prepareBatchProject` still copies this file into the batch dir verbatim.
    if (admitted !== undefined && !admitted.has(rel)) {
      excludedByOnly++;
      continue;
    }
    // Built once per file (not per spec): a per-spec tree walk here would be
    // O(specs x nodes) on a file with many mutation sites. See
    // `buildSpanIndex`'s doc comment in @lethal/engine.
    const spanIndex = buildSpanIndex(root);
    const specs: MutationSpec[] = [];
    visit(root, (node) => {
      for (const op of allOperators) {
        if (op.targets(node, ctx)) {
          for (const spec of op.generate(node, ctx)) {
            // Reject specs whose `before` isn't a real node in this file's
            // tree — coalescing (Layer 4.3) relies on mutation sites being
            // laminar, which a synthetic multi-node span could violate.
            const validation = validateSpec(spec, root, spanIndex);
            if (validation.ok && !isMutableSite(spec.before)) {
              // The node matched an operator's pattern but is not inside executable AL — an AL
              // page/report property (`SubPageLink`, a filter) parses as a comparison expression
              // while being declarative. Nothing can wrap it, and before this guard one such site
              // aborted the entire session at `buildComponents`. Dropped, and tallied so a silent
              // shrink of the mutant set is impossible.
              nonExecutableSites++;
            } else if (validation.ok) {
              specs.push(spec);
            } else {
              warn(
                "mutation-spec-rejected",
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
    warn(
      "not-instrumentable-files-skipped",
      `[lethal] skipped ${skipped.length} file(s) holding ${total} mutation site(s): ${why}: ${detail}.`,
    );
  }
  if (nonExecutableSites > 0) {
    warn(
      "non-executable-sites-dropped",
      `[lethal] dropped ${nonExecutableSites} matched site(s) that are not inside executable AL (declarative page/report properties such as SubPageLink or a filter, which parse as comparison expressions). They cannot be wrapped and are not mutants.`,
    );
  }
  if (excludedByOnly > 0) {
    warn(
      "only-narrowed-run",
      `[lethal] --only narrowed this run to ${entries.length - excludedByOnly}/${entries.length} .al file(s); ${excludedByOnly} file(s) contributed no mutants. The score below covers the narrowed set ONLY — it is not a project score.`,
    );
  }
  return { files, skipped, totalFiles: entries.length, excludedByOnly };
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
  /**
   * R41: glob patterns naming which project files may contribute mutants (`--only`). Absent means
   * the whole project. See `MutationSetOptions.only` — the narrowing applies to spec generation
   * only; every file is still parsed into the semantic context, still compiled, still published.
   */
  readonly only?: readonly string[];
  /**
   * R45: glob patterns naming which TEST files may run (`--tests-only`). Absent means the whole
   * suite. Narrows the baseline — the phase `only` does not touch and where a real project's run
   * time goes. See `DiscoverOptions.only` for why this one can change verdicts and `only` cannot.
   */
  readonly testsOnly?: readonly string[];
  /**
   * R44: maximum injected guards per published artifact — see `PlanOptions.maxGuardsPerBatch`.
   * Absent means one artifact for everything, which is not publishable for a real app.
   */
  readonly maxGuardsPerBatch?: number;
  /**
   * R47: floor for a mutant run's time budget, in milliseconds. Absent means
   * `MIN_MUTANT_BUDGET_MS`.
   *
   * The effective budget stays `max(2 x that test's baseline duration, this value)` — this raises
   * the FLOOR, it does not cap anything. A test whose baseline is already slow keeps its generous
   * `2 x`; what this fixes is the fast-baseline/slow-mutant pair, where `2 x` is tiny and the
   * hardcoded 30 s floor was the only thing standing between a real suite and an aborted session.
   */
  readonly mutantTimeoutMs?: number;
  /**
   * R53 (`--stop-hung-sessions`), OPT-IN, default off.
   *
   * A mutant that makes a test never terminate cannot be scored today: the client aborts at its
   * budget, and an abort is ambiguous (BC may still be executing), so it quarantines the tier and
   * blocks every mutant behind it — 125 of 138 on Document Output.
   *
   * With this on, the request is held open at the budget and the server is asked to STOP THE
   * SESSION running that mutant; BC then answers the held request with a 408 naming the stop, and
   * that answer — not the stop call's own return value — is what makes the run scoreable
   * (`timeout-killed`).
   *
   * It is opt-in because it ENDS A SESSION ON THE USER'S BC SERVER. LethAL only ever targets a
   * session id its own run recorded for its own attempt, under the lease fence and behind a
   * server-side tombstone check — but the id cannot be independently verified (`Active Session` is
   * unusable from a web-service session, measured), so accepting that residual risk is the user's
   * call, not the tool's.
   */
  readonly stopHungSessions?: boolean;
  /**
   * R19: work that must happen AFTER the lease is held and before anything is measured.
   *
   * Today that is exactly one thing — publishing the target's test apps (`envTool.publishApps`).
   * Pre-lease, a concurrent LethAL session can republish one mid-run, and nothing detects it: the
   * attestation fence covers the TARGET artifact, not the test app, so the swap is invisible to
   * every verdict the run produces.
   *
   * Deliberately a HOOK rather than a `publishApps` field on this config: `runSession` has no
   * business knowing what an env tool is, and the env-tool session already owns the publisher, its
   * credentials and its serializer. This is the seam, not the implementation.
   *
   * Absent on every path that has no such work (bcdev without an env tool, al-runner, every unit
   * test), and absent is not the same as "nothing to publish" — the env-tool session always
   * supplies the callback, which is a no-op when no apps are configured.
   */
  readonly afterLeaseAcquired?: () => Promise<void>;
  /**
   * R48: opt out of the large-run pre-flight refusal — see `LARGE_RUN_MUTANT_THRESHOLD`.
   */
  readonly allowLargeRun?: boolean;
  /**
   * R47: resume an aborted prior run in this same database, skipping the EXECUTION of mutants it
   * already scored. `"last"` selects the most recent unfinished run matching this session's
   * configuration fingerprint; a number names one explicitly. Absent means a fresh run.
   *
   * Everything else still happens — parse, instrument, deploy, baseline — so coverage attribution
   * and covering-test lists come from THIS run, not from the database. See `resume.ts`.
   */
  readonly resume?: "last" | number;
  /**
   * R53: re-run mutants a prior run stranded the tier on, instead of skipping them.
   *
   * Off by default because the measured cause is a NON-TERMINATING mutant, which reproduces every
   * time and blocks every mutant behind it. Worth turning on when the strand is believed to have
   * been environmental (a network blip, a restarted container) rather than the mutant itself.
   */
  readonly retryStranded?: boolean;
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
  /**
   * The event stream's emitter (spec 2026-08-05 §A, events.ts). Optional at this level ONLY —
   * a caller that does not care about events (every test that predates this field, a one-off
   * script) pays nothing. Once inside `runSession`, `record()`'s own `emit` parameter is
   * REQUIRED: `runSession` defaults an absent `cfg.emit` to a no-op emitter
   * (`createEmitter([])`) exactly once, at the top of the function, so every internal call site
   * always has a real (if inert) emitter to pass — there is no second place in this file where
   * "no emitter configured" can be rediscovered and quietly skipped.
   */
  readonly emit?: RunEmitter;
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
export interface PlanOptions {
  /**
   * R44: maximum injected guards in one batch's artifact. Absent means no limit — every mutant in
   * one artifact, the behaviour before this existed and the one the frozen live gates run.
   *
   * Exists because publish cost scales with GUARD COUNT: BC recompiles the extension server-side
   * on a dev publish, so the guards are the cost. Measured against a hosted Continia BC 28
   * environment, same app and publish path, only the guard count differing — 163 guards published
   * in 28 s (HTTP 200); 11,777 guards were severed by the hosting proxy at 362 s (nginx 504). An
   * unbounded artifact is therefore not publishable for a real app at all.
   *
   * Costed against the OTHER phases before choosing a value: each batch pays its own deploy AND
   * its own baseline (the baseline sits inside the batch loop), so halving the budget doubles both.
   * On Document Output that is ~40 s deploy + 25 s baseline per batch once `--tests-only` (R45)
   * has narrowed the suite — tolerable at ~15 batches, ruinous at 15 x the unnarrowed 745 s.
   */
  readonly maxGuardsPerBatch?: number;
  /** Same rule as `MutationSetOptions.emit`: only the `runSession` call site passes a real one;
   *  every other caller (tests, `cli.ts --dry-run`) keeps its existing console output. */
  readonly emit?: RunEmitter;
}

/**
 * Groups instrumented files into batches, one compiled+published artifact each.
 *
 * Splits at FILE granularity, which is the long-standing contract `narrowFilesToSubset` and
 * bisection are written against. A single file whose own guard count exceeds the budget therefore
 * cannot be subdivided here: it becomes its own oversized batch and says so, because the only
 * alternative at this granularity is to drop it, and silently losing a file would remove its
 * mutants from the run with nothing in the report to explain the smaller total.
 *
 * Greedy first-fit in declaration order, deliberately not bin-packed for optimality: batch order
 * stays predictable across runs, which matters because a batch boundary is where mutant ids
 * restart (`assignMutantIds`) and where a `--out` report's `batchIndex` comes from.
 */
export function planArtifacts(
  files: readonly InstrumentedFile[],
  options: PlanOptions = {},
): readonly (readonly InstrumentedFile[])[] {
  if (files.length === 0) return [];
  const budget = options.maxGuardsPerBatch;
  if (budget === undefined || budget <= 0) return [files];

  const batches: InstrumentedFile[][] = [];
  let current: InstrumentedFile[] = [];
  let currentGuards = 0;
  const oversized: string[] = [];

  for (const f of files) {
    const guards = f.specs.length;
    if (guards > budget) {
      // Cannot be split further at this granularity. Flush what is open, ship it alone, and
      // report it rather than pretending the budget held.
      if (current.length > 0) {
        batches.push(current);
        current = [];
        currentGuards = 0;
      }
      batches.push([f]);
      oversized.push(`${f.path} (${guards} guards)`);
      continue;
    }
    if (currentGuards + guards > budget && current.length > 0) {
      batches.push(current);
      current = [];
      currentGuards = 0;
    }
    current.push(f);
    currentGuards += guards;
  }
  if (current.length > 0) batches.push(current);

  if (oversized.length > 0) {
    const message = `[lethal] ${oversized.length} file(s) exceed --max-guards-per-batch=${budget} on their own and were each published as a single oversized batch (batches split at file granularity): ${oversized.join(", ")}. If such a batch fails to publish, lower the budget for the rest or split the file.`;
    if (options.emit !== undefined) {
      options.emit({ type: "warning", code: "oversized-batch", message });
    } else {
      console.warn(message);
    }
  }
  return batches;
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
 *
 * Exported so `scripts/campaign/compile-only.ts` shares this exact check instead of its own
 * `String(appManifest.id)`, which would silently coerce a missing id into the literal string
 * "undefined" — precisely the plausible-empty-default shape this function exists to refuse.
 */
export function targetAppIdOf(projectManifest: Readonly<Record<string, unknown>>): string {
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
  opts: { coverage: CoverageMode; timeoutMs: number },
  leaseSession: LeaseSession | undefined,
  emit: RunEmitter,
  resyncOpSeq?: () => Promise<void>,
): Promise<FencedRunOutcome> {
  const first = await runOnce(backend, safety, ref, opts, resyncOpSeq);
  if (!isLostAck(first)) return { verdict: first, lostAck: "none", retried: false };
  // Announce it. A lost ack is rare, it means a result really was thrown away, and a silent
  // recovery is indistinguishable from the fault never happening — which is exactly the ambiguity
  // that made this intermittent expensive to diagnose in the first place.
  emit({
    type: "warning",
    code: "lost-ack-unreadable",
    message: `[lethal] ${ref.method}: unreadable answer from RunMutant (${first.failureMessage ?? "no detail"}) — reconciling against the operation marker before deciding anything`,
  });
  if ((await reconcileFencedLostAck(leaseSession, first)) === "unresolved") {
    return { verdict: first, lostAck: "unresolved", retried: false };
  }
  emit({
    type: "warning",
    code: "lost-ack-retry",
    message: `[lethal] ${ref.method}: the operation was confirmed COMPLETE server-side, so the container is clean and only the result was lost — retrying once as a fresh attempt`,
  });
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
      readonly emit: RunEmitter;
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
          this.d.emit({
            type: "warning",
            code: "lease-renew-unanswered",
            message: `[lethal] lease renew could not be answered twice in a row (${messageOf(first)}; ${messageOf(second)}) — not treated as lease loss (design §6: only renewed:false is loss); the next tick retries`,
          });
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
      this.d.emit({
        type: "warning",
        code: "lease-reconcile-failed",
        message: `[lethal] could not reconcile the lost RunMutant ack for op ${op.opSeq} (attemptId ${op.attemptId}): ${messageOf(err)} — treating the operation as unresolved`,
      });
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
        this.d.emit({
          type: "warning",
          code: "lease-poll-failed",
          message: `[lethal] polling the in-flight operation failed: ${messageOf(err)}`,
        });
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
      this.d.emit({
        type: "warning",
        code: "lease-ownership-unconfirmed",
        message: `[lethal] could not confirm lease ownership at session end (${messageOf(err)}) — treating the marker as possibly ours`,
      });
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
      this.d.emit({
        type: "warning",
        code: "lease-marker-read-failed",
        message: `[lethal] could not read the operation marker at session end (${messageOf(err)}) — leaving the lease to expire rather than releasing over a possibly-live operation`,
      });
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
        this.d.emit({
          type: "warning",
          code: "lease-marker-foreign",
          message: `[lethal] session ended with a non-idle operation marker (opKind ${status.opKind}, opAttemptId ${status.opAttemptId}, opSeq ${status.opSeq}) that belongs to ANOTHER session — RenewLease answered renewed:false, so our lease had already been taken over and this marker is not ours to quarantine. No durable container-needs-recycle recorded; the container is healthy and the other session owns it.`,
        });
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
        this.d.emit({
          type: "warning",
          code: "lease-release-refused",
          message: `[lethal] ReleaseLease refused (${released.reason}) — the lease will expire on its own`,
        });
      }
    } catch (err) {
      this.d.emit({
        type: "warning",
        code: "lease-release-failed",
        message: `[lethal] ReleaseLease failed: ${messageOf(err)} — the lease will expire`,
      });
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

/**
 * R48: refuses an unscoped run whose size makes it impractical, before anything is published.
 *
 * The message is the whole point — a bare "too many mutants" would send the reader to look for a
 * limit to raise, when what they need is the three narrowing levers and the measured reason each
 * exists. See `LARGE_RUN_MUTANT_THRESHOLD`.
 */
export function assertRunSizeAcceptable(input: {
  mutantCount: number;
  fileCount: number;
  narrowed: boolean;
  allowLargeRun: boolean;
}): void {
  if (input.allowLargeRun) return;
  if (input.mutantCount <= LARGE_RUN_MUTANT_THRESHOLD) return;
  const scoped = input.narrowed
    ? "Narrow --only further, or pass --allow-large-run to run it anyway."
    : 'Scope it with --only <glob> (e.g. --only "Al/Codeunit/**"), or pass --allow-large-run to run it anyway.';
  throw new Error(
    `this run would schedule ${input.mutantCount} mutation site(s) across ${input.fileCount} file(s), above the ${LARGE_RUN_MUTANT_THRESHOLD} pre-flight limit. ${scoped}\nWhy this refuses instead of warning: measured against a hosted BC environment, a real project costs ~19.5 s per mutant (p95 43 s), so this run is measured in hours to days — and the artifact carrying every guard is itself often unpublishable (a 11,777-guard publish was severed by the hosting proxy at 362 s). The failure would land long after the warning scrolled past.\nLevers: --only <glob> narrows which files contribute mutants (cannot change a verdict); --tests-only <glob> narrows the baseline, which dominates a first run (CAN change a verdict — an excluded killing test manufactures a survivor); --max-guards-per-batch <n> bounds each published artifact.`,
  );
}

/**
 * R47: resolves `SessionConfig.resume` into the prior verdicts this run may carry.
 *
 * Every refusal names what was searched for and what was found. A resume that silently found
 * nothing and ran everything would be indistinguishable from a resume that worked, which is the
 * worst outcome available here: the user believes twelve hours of prior work was reused.
 */
function resolveResume(
  cfg: SessionConfig,
  backendName: string,
  configFingerprint: string,
  emit: RunEmitter,
): { runId: number; index: ResumeIndex } | undefined {
  if (cfg.resume === undefined) return undefined;

  let priorRunId: number;
  if (cfg.resume === "last") {
    const found = cfg.store.findResumableRun({
      projectPath: cfg.projectDir,
      backend: backendName,
      configFingerprint,
      // R52: one source of truth for what "resumable" means — a run holding only errors, or nothing
      // at all, has nothing to carry and must not shadow an older run that does.
      carryableVerdicts: [...CARRYABLE_VERDICTS],
    });
    if (found === null) {
      throw new Error(
        `--resume found no unfinished run to resume in this database for this project (${cfg.projectDir}), backend ${backendName}, and configuration. A run that COMPLETED is not resumable (there is nothing left to score), and a run scoped by different --only/--tests-only patterns is deliberately not matched — carrying its verdicts would describe a different slice of the project. Drop --resume to run from scratch.`,
      );
    }
    priorRunId = found;
  } else {
    const row = cfg.store.getRun(cfg.resume);
    if (row === null) throw new Error(`--resume-run ${cfg.resume}: no such run in this database`);
    if (row.projectPath !== cfg.projectDir) {
      throw new Error(
        `--resume-run ${cfg.resume} recorded project ${row.projectPath}, but this session targets ${cfg.projectDir}`,
      );
    }
    if (row.backend !== backendName) {
      throw new Error(
        `--resume-run ${cfg.resume} ran on backend ${row.backend}, but this session uses ${backendName} — verdicts are not interchangeable across backends (al-runner is not authoritative)`,
      );
    }
    if (row.configFingerprint !== configFingerprint) {
      throw new Error(
        `--resume-run ${cfg.resume} was scoped differently from this session (--only/--tests-only/--skip-known-survivors/selector ids). Carrying its verdicts would report one scope's measurements as another's${
          row.configFingerprint === null
            ? " — that run predates configuration fingerprinting and cannot prove its scope at all"
            : ""
        }`,
      );
    }
    priorRunId = cfg.resume;
  }

  const index = buildResumeIndex(
    cfg.store.mutantVerdicts(priorRunId),
    cfg.stopHungSessions === true,
  );
  emit({
    type: "warning",
    code: "resume-reusing-run",
    message: `[lethal] --resume: reusing run ${priorRunId} — ${index.carryable.size} mutant verdict(s) may be carried without re-executing. Deploy and baseline still run; coverage attribution and covering-test lists come from THIS run.${
      index.nonCarryableRows > 0
        ? ` ${index.nonCarryableRows} prior 'error' verdict(s) will be re-executed.`
        : ""
    }${
      index.ambiguousKeys > 0
        ? ` ${index.ambiguousKeys} identity key(s) matched more than one prior mutant and will be re-executed (a colliding key cannot say which verdict was whose).`
        : ""
    }${
      // R53: stated here because the two counts above would otherwise contradict it — a stranding
      // mutant is an 'error' row, so it is included in `nonCarryableRows`'s "will be re-executed",
      // which is exactly what is NOT about to happen to it.
      index.strandedKeys.size > 0
        ? ` Of those, ${index.strandedKeys.size} stranded the tier on a prior run and will be SKIPPED rather than re-executed${(cfg.retryStranded ?? false) ? ", except --retry-stranded was given, so they will be attempted" : " (a mutant that never terminates reproduces this every time and blocks every mutant behind it; pass --retry-stranded to attempt them)"}.`
        : ""
    }`,
  });
  // resume-resolved: emitted before any mutant event (this function runs before the batch loop
  // starts). `carryable`/`strandedKeys` are the LEARNED half of `--resume` — see events.ts's doc
  // comment. Final `carriedMutants`/`skippedStranded` deliberately do NOT ride here; the fold
  // counts those 1:1 from `mutant-carried`/`mutant-skipped-stranded` events instead.
  emit({
    type: "resume-resolved",
    fromRunId: priorRunId,
    mode: cfg.resume,
    carryableCount: index.carryable.size,
    strandedKeyCount: index.strandedKeys.size,
    retryStranded: cfg.retryStranded ?? false,
  });
  return { runId: priorRunId, index };
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
  // `record()`'s own `emit` parameter is REQUIRED (see its doc comment) so no call site can write
  // a store row without emitting — this is the one place an absent `cfg.emit` is allowed to
  // become a real (if inert) emitter. `createEmitter([])` fans out to zero subscribers, so every
  // `emit(...)` call below is a genuine no-op when nobody is listening, not a special case.
  const emit: RunEmitter = cfg.emit ?? createEmitter([]);
  // run-configured (spec 2026-08-05 §A, AMENDED): the closed statics set `{ caps, only, testsOnly,
  // stopHungSessions }`, echoed once from the same values `buildReport` still reads directly from
  // `cfg` at the end of this function — one source, two carriages. No later event may repeat or
  // update any of these.
  emit({
    type: "run-configured",
    caps,
    ...(cfg.only !== undefined ? { only: { patterns: cfg.only } } : {}),
    ...(cfg.testsOnly !== undefined ? { testsOnly: cfg.testsOnly } : {}),
    ...(cfg.stopHungSessions === true ? { stopHungSessions: true } : {}),
  });
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
    emit({
      type: "warning",
      code: "quarantine-consult-disabled",
      message:
        "runSession: authoritative backend but SessionConfig.resourceServer/resourceServerInstance " +
        "are not set — the quarantine consult is DISABLED for this session (a prior strand on this " +
        "tier will not be detected, and this session cannot durably record a new one).",
    });
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

  const tests = await discoverTests(
    cfg.testDir,
    cfg.testsOnly !== undefined ? { only: cfg.testsOnly } : {},
  );
  // Discovery returns the whole list in one parse — 1,000+ per-item events at one instant would
  // be false granularity, not liveness (see events.ts's doc comment on `tests-discovered`).
  emit({ type: "tests-discovered", tests });
  if (cfg.testsOnly !== undefined && cfg.testsOnly.length > 0) {
    emit({
      type: "warning",
      code: "tests-only-narrowed-baseline",
      message: `[lethal] --tests-only narrowed the baseline to ${tests.length} test(s) from ${cfg.testsOnly.length} pattern(s). A mutant whose killing test was excluded is reported SURVIVED — narrowing tests trades accuracy for speed, unlike --only.`,
    });
  }
  if (tests.length === 0) throw new Error("no tests discovered");

  const backendName = caps.authoritative ? "bcdev" : "al-runner";
  // R47: computed for EVERY run, not just a resuming one — a run that does not record its own
  // fingerprint cannot be resumed later, and the run worth resuming is precisely the one nobody
  // knew would abort.
  const configFingerprint = sessionFingerprint({
    projectDir: cfg.projectDir,
    testDir: cfg.testDir,
    backend: backendName,
    skipKnownSurvivors: cfg.skipKnownSurvivors ?? false,
    selectorIds: cfg.selectorIds,
    ...(cfg.only !== undefined ? { only: cfg.only } : {}),
    ...(cfg.testsOnly !== undefined ? { testsOnly: cfg.testsOnly } : {}),
  });
  const resumeState = resolveResume(cfg, backendName, configFingerprint, emit);

  const runId = cfg.store.createRun({
    projectPath: cfg.projectDir,
    backend: backendName,
    configFingerprint,
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
  // stream-started: the header event, carrying the run's own id. Emitted HERE, immediately after
  // `createRun()`, because this is the only point in the function with both `runId` and
  // `STREAM_SCHEMA_VERSION` in scope — `runId` does not exist before this line.
  //
  // NOT literally `events[0]` in every session: `run-configured` and `tests-discovered` (and,
  // when `--resume` is given, `resolveResume`'s own warning/`resume-resolved`) are ALL emitted
  // earlier, deliberately — they are facts this session already has (the config it was given, the
  // tests it found) that do not depend on `runId`, and the `tests.length === 0` / a bad `--resume`
  // throw BEFORE `createRun()` runs at all, i.e. before a run row — and so before a real `runId` —
  // exists. Making `stream-started` truly first would mean creating the run row before those
  // checks, which would leave an orphaned, resumable-but-empty run row in the store for a session
  // that never got past "no tests discovered" — a real, if narrow, behavioural change with
  // `--resume` consequences, not a pure event-ordering one. Deferred to the team rather than made
  // unilaterally; see the test below for exactly what precedes it in the minimal case.
  emit({ type: "stream-started", streamSchemaVersion: STREAM_SCHEMA_VERSION, runId });

  // Phase clocks (see `SessionReport.timings`). `deploy` scales with project size, `mutants`
  // with mutant count, `baseline` is a per-batch toll — recorded separately because a single
  // total cannot be extrapolated from one run shape to another.
  const sessionStartedMs = Date.now();
  let deployMs = 0;
  let baselineMs = 0;
  emit({ type: "phase-entered", phase: "generate" });
  const generateStartedMs = Date.now();
  const {
    files: allFiles,
    skipped: notInstrumentedFiles,
    totalFiles: totalAlFiles,
    excludedByOnly,
  } = await generateMutationSet(cfg.projectDir, {
    ...(cfg.only !== undefined ? { only: cfg.only } : {}),
    emit,
  });
  const generateMutationSetMs = Date.now() - generateStartedMs;
  // R92: raw site count (every spec that made it into an instrumentable file) vs the DEPLOYED
  // count once per-file dedup (`dedupeSpecs`) collapses same-site operator collisions into one
  // winner — the same collapse `writeInstrumentedProject` runs at compile time, per file (identity
  // is per-file, never project-wide — see `dedupeSpecs`'s doc comment). Computed once, up front,
  // rather than summed from each batch's manifest as batches compile: batches are file-disjoint
  // (`planArtifacts` splits at file granularity), so a project-wide per-file dedup here yields the
  // exact same total dedup would produce per batch, and it is available at the moment this phase
  // ends rather than only after every artifact has compiled.
  const siteCount = allFiles.reduce((n, f) => n + f.specs.length, 0);
  const deployedCount = allFiles.reduce((n, f) => n + dedupeSpecs(f.specs, tierOf).length, 0);
  emit({
    type: "mutation-set-generated",
    siteCount,
    deployedCount,
    totalFiles: totalAlFiles,
    instrumentableFiles: allFiles.length,
    notInstrumentedFiles,
    excludedByOnly,
  });
  emit({ type: "phase-left", phase: "generate", elapsedMs: generateMutationSetMs });
  // R48: refuse an unscoped run on a large project BEFORE anything is published. See
  // `LARGE_RUN_MUTANT_THRESHOLD` for why this refuses rather than warns.
  assertRunSizeAcceptable({
    mutantCount: siteCount,
    fileCount: allFiles.length,
    narrowed: cfg.only !== undefined,
    allowLargeRun: cfg.allowLargeRun ?? false,
  });
  const artifacts = planArtifacts(allFiles, {
    ...(cfg.maxGuardsPerBatch !== undefined ? { maxGuardsPerBatch: cfg.maxGuardsPerBatch } : {}),
    emit,
  });

  // R47: the configured floor for a mutant run's time budget — see `SessionConfig.mutantTimeoutMs`.
  const minMutantBudgetMs = cfg.mutantTimeoutMs ?? MIN_MUTANT_BUDGET_MS;

  const outcomes: SessionOutcome[] = []; // internal accumulation for the report
  // R47: how many verdicts this session carried from a prior run instead of measuring. Reported,
  // never inferred from a count difference — a resumed report must be able to say so.
  let resumedMutantCount = 0;
  // R53: how many mutants were skipped because a prior run stranded the tier on them.
  let strandedSkippedCount = 0;
  let baselineGreenOverall = true;
  // Task 6 (spec §9): qualified names of baseline tests that did not pass
  // (fail/error) across all batches — surfaced in the report so an unsupported
  // test type (or a broken test) is named, never silently dropped.
  const unsupportedTestNames = new Set<string>();
  // R31: tests the source declares that the SERVER has no result for — see the baseline loop.
  const missingFromServer = new Set<string>();
  // R35: baseline tests BC REFUSED on permissions — a strict subset of `unsupportedTestNames`,
  // tracked separately because the two demand opposite responses. "Did not pass at baseline" reads
  // as "your test is broken or is an unsupported type"; a permissions refusal is neither, and is
  // fixed by one line in the target's own source (`TestPermissions = Disabled`). R27 named this
  // cause on the `unstable` path only; a test refused HERE was dropped from the green set with the
  // wrong explanation attached, or none at all.
  const permissionRefusedTests = new Set<string>();
  // R69: baseline tests refused for opening a `TestPage` — also a strict subset of
  // `unsupportedTestNames`, and tracked apart from `permissionRefusedTests` because it is the
  // OPPOSITE finding. A permissions refusal has a one-line fix in the target's own source; this has
  // none — the fenced session (`GuiAllowed=No`, `ClientType=ODataV4`) cannot create a test service
  // at all. Sharing a bucket would tell one of the two readers something false.
  const testPageUnsupportedTests = new Set<string>();
  const runnerDisagreementTests = new Set<string>();
  // Summed across batches — see `SessionReport.untargetedTriggerCount`. Declared out here rather
  // than read off the last batch's split: each batch runs its own coverage filter, and a session
  // whose only untargeted trigger sits in batch 1 must not report 0.
  let untargetedTriggerCount = 0;
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
   * `runMutantsOnBackend`, the per-mutant loop) carry it. A call site without it would send a
   * stale-high `opSeq` on that retry, be refused `reason:"lease-invalid"`, and be indistinguishable
   * at the client from genuine lease loss — falsely quarantining a healthy session.
   *
   * That used to be a hypothetical for the BASELINE site, guarded by "safe only while the backend
   * reports `coverage: "procedure"`, since the baseline then never takes the fenced RunMutant
   * path". **R58 spends that guard.** Under `coverage: "fenced"` the baseline goes through
   * `RunMutantWithCoverage` — the same fenced action, on the same lease, consuming the same
   * server-side op-seq sequence — so every baseline test now claims an op, can be refused
   * `lease-invalid`, and participates in the same reconciliation the mutant loop does
   * (`classifyLeaseVerdict` -> `handleBaselineLeaseOutcome` immediately below the call).
   * Nothing at the call site would record that dependency, so it is simply passed.
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
      emit,
    });
    leaseSession = session;
    resyncSessionOpSeq = () => session.resyncOpSeq(cfg.backend);
    // Bind before anything can run: the backend fails loudly on a RunMutant with no lease bound,
    // and this is also the fail-loud point for a backend that cannot take one at all.
    bindLeaseToBackend(cfg.backend, lease);
    session.start();

    // R19: the one publish that CAN happen under the lease, happening under it.
    //
    // Publishing the target's test apps before the lease leaves a window in which a concurrent
    // LethAL session republishes one mid-run. Nothing detects that: the attestation fence covers
    // the TARGET artifact, not the test app, so the swap is invisible to every verdict this run
    // then produces. Held under the lease, no other session is running at all.
    //
    // The CONTROL-APP publish is NOT here and cannot be — `AcquireLease` is an action on the
    // control app and the lease row lives in its own table, so there is no lease to hold until it
    // is published. R19's "move both under the lease" is impossible for that half by construction.
    //
    // Inside the same try/finally as everything else the lease guards: a publish that throws must
    // release the lease rather than leave it held for the full ttl.
    if (cfg.afterLeaseAcquired !== undefined) await cfg.afterLeaseAcquired();
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
      // permission-canary: the once-per-session measured verdict, as data — see events.ts's doc
      // comment. The prose lines below are ADDITIONALLY converted to `warning` events, unchanged,
      // because a reader following the stream should not lose them; the two are not redundant
      // representations of the same fact competing to win, they are structure and prose together.
      emit({ type: "permission-canary", result: permissionCanary });
      for (const line of permissionCanaryWarnings(permissionCanary)) {
        emit({ type: "warning", code: "permission-canary", message: line });
      }
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
        record(cfg.store, runId, m, "known-survivor", outcomes, batchIdx, emit);

      // 3. deploy — always, even for in-memory backends: they need the
      // per-batch instrumented dir just as much as a publishing backend
      // needs the compiled app. `capabilities().deploy` still describes
      // publish cost for callers, it just no longer gates this call.
      emit({ type: "phase-entered", phase: "deploy" });
      let compiled: CompiledArtifact | null = null;
      let deployed = false;
      let deployErr: unknown;
      const deployStartedMs = Date.now();
      try {
        compiled = await deployOnce(cfg.backend, safety, leaseSession, batchDir);
        deployed = true;
      } catch (err) {
        deployErr = err;
      }
      // Charged here, not on the success path below: every branch of `if (!deployed)` ends in a
      // `continue`, and a batch that failed to deploy has usually spent MORE time than one that
      // succeeded (the version-conflict retry recompiles; bisection recompiles repeatedly). Any
      // later work inside that block is charged too, by the second accumulation below.
      deployMs += Date.now() - deployStartedMs;
      const deployRetryStartedMs = Date.now();
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
          record(cfg.store, runId, m, "error", outcomes, batchIdx, emit, undefined, note);
        deployMs += Date.now() - deployRetryStartedMs;
        emit({ type: "phase-left", phase: "deploy", elapsedMs: Date.now() - deployStartedMs });
        continue; // batch aborted, next batch still attempted
      }
      deployMs += Date.now() - deployRetryStartedMs;
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
      {
        const deployElapsedMs = Date.now() - deployStartedMs;
        emit({
          type: "batch-published",
          batchIndex: batchIdx,
          guardCount: manifest.mutants.length,
          elapsedMs: deployElapsedMs,
        });
        emit({ type: "phase-left", phase: "deploy", elapsedMs: deployElapsedMs });
      }

      // 4. baseline
      emit({
        type: "phase-entered",
        phase: "baseline",
        testCount: tests.length,
        batchIndex: batchIdx,
      });
      const baselineStartedMs = Date.now();
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
      // Charged BEFORE the early exits below, for the same reason the deploy clock is: both the
      // quarantine `break` and the no-green-tests `continue` leave this scope without reaching the
      // success-path accumulation, so a baseline that aborted used to report 0 ms and silently
      // reattribute its whole cost to "overhead". Measured on a run quarantined mid-baseline:
      // baseline 0.0s, overhead 70.1s, when essentially all of it was baseline.
      const baselineElapsedMs = Date.now() - baselineStartedMs;
      baselineMs += baselineElapsedMs;
      emit({ type: "phase-left", phase: "baseline", elapsedMs: baselineElapsedMs });
      if (safety.isUnsafe) break; // stop the whole session — no mutant scheduling, no next batch
      // baseline-batch-finished: the moment of observation IS the batch's baseline RETURNING (see
      // events.ts's doc comment) — emitted here, unconditionally, so it still fires on the
      // all-red path below (`greenTests.length === 0`) rather than only on the happy path.
      // Classification is computed directly against `describeTestPermissionsRefusal`/
      // `describeTestPageUnsupported`/the stale-test-app sentinel — the SAME pure checks the
      // `refusedThisBatch`/`testPageThisBatch`/`missingFromServer` loops below also run, kept
      // independent here so this event's correctness never depends on reaching code after the
      // early `continue`.
      emit({
        type: "baseline-batch-finished",
        batchIndex: batchIdx,
        verdicts: baseline.map((b) => {
          const classification: BaselineClassification[] = [];
          if (describeTestPermissionsRefusal(b.verdict.failureMessage) !== undefined) {
            classification.push("tests-permission-refused");
          }
          if (describeTestPageUnsupported(b.verdict.failureMessage) !== undefined) {
            classification.push("tests-testpage-unsupported");
          }
          if (b.verdict.failureMessage === NO_RESULT_FOR_METHOD) {
            classification.push("stale-test-app");
          }
          return {
            name: qualifiedTestName(b.ref),
            outcome: b.verdict.outcome,
            classification,
            ...(b.verdict.failureMessage !== undefined
              ? { failureMessage: b.verdict.failureMessage }
              : {}),
          };
        }),
      });
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
            emit,
            undefined,
            "no green baseline tests",
          );
        }
        continue;
      }
      // R58, recorded rather than discovered later: under `coverage: "fenced"` these durations
      // INCLUDE coverage-collection overhead (Start/StopApplicationCoverage plus serializing the
      // whole `Code Coverage` table) that no mutant run pays. Every mutant's budget is
      // `2 * baseline` (`MIN_MUTANT_BUDGET_MS`, below), so budgets inflate slightly — the SAFE
      // direction, since a too-small budget produces a client-side `deadline-exceeded` that strands
      // a run server-side and quarantines the tier. R47 and R53 were fought over exactly these
      // numbers, so the shift is stated here rather than left to be re-derived from a timing report.
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
      // R35, blind spot 1. The evidence is already here, per-test, in BC's own words — the same
      // text R27 reads on the `unstable` path. Nothing looked at it HERE, so a suite whose test
      // codeunits omit `TestPermissions = Disabled` had its writing tests refused, dropped from
      // the green set, and reported as "did not pass at baseline" — which sends the reader to
      // debug their tests rather than declare one property.
      //
      // Keyed BATCH-LOCAL, and holding the diagnosis STRING rather than a bare flag:
      //   - batch-local, because the note below describes THIS batch's baseline. The session-level
      //     set is cumulative, so consulting it would let a refusal measured in a later batch
      //     describe an earlier batch's note (impossible — earlier notes are already written) and,
      //     worse, let a test refused in one batch be labelled "refused" in another where it
      //     failed for an ordinary reason.
      //   - the string, because `describeTestPermissionsRefusal` QUOTES BC verbatim, and that
      //     quote is what lets a reader overrule a hedged English-regex diagnosis. Discarding it
      //     and keeping only the truthiness would leave the reader with an assertion and no
      //     evidence — see the unstable path, which appends the same string.
      const refusedThisBatch = new Map<string, string>();
      // R69: batch-local for exactly the reasons the R35 map above documents — this batch's note
      // must describe THIS batch's baseline, and the session-level set is cumulative.
      const testPageThisBatch = new Map<string, string>();
      for (const b of unsupportedBaseline) {
        const name = qualifiedTestName(b.ref);
        unsupportedTestNames.add(name);
        const refusal = describeTestPermissionsRefusal(b.verdict.failureMessage);
        if (refusal !== undefined) {
          refusedThisBatch.set(name, refusal);
          permissionRefusedTests.add(name);
        }
        const testPage = describeTestPageUnsupported(b.verdict.failureMessage);
        if (testPage !== undefined) {
          testPageThisBatch.set(name, testPage);
          testPageUnsupportedTests.add(name);
        }
      }

      // R31: a test the SOURCE declares but the server returned no result for is a test the
      // published test app does not contain — i.e. what is deployed is older than the source
      // being measured. This has cost two debugging sessions, because the symptom is badly
      // disguised: the baseline goes red and dozens of mutants fall to `no-coverage`, which reads
      // as a mutation-scoring problem rather than "your published test app is stale". The
      // evidence was already present per-test; nothing aggregated it into a statement.
      for (const b of baseline) {
        if (b.verdict.failureMessage === NO_RESULT_FOR_METHOD) {
          missingFromServer.add(qualifiedTestName(b.ref));
        }
      }

      // 5. coverage filter (capability-gated)
      let perMutantTests: ReadonlyMap<string, readonly TestMethodRef[]>;
      // R-agent-output: which attribution path placed each mutant's covering tests. Empty on the
      // `coverage: "none"` branch below, where every mutant runs every green test by construction
      // and no attribution happened at all — distinct from "attributed, then fell back".
      let coverageAttribution: ReadonlyMap<string, CoverageAttribution> = new Map();
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
        coverageAttribution = split.attribution;
        uncovered = split.uncovered;
        untargetedTriggerCount += split.untargetedTriggerCount;
        // coverage-split: accumulated per batch AT SPLIT TIME — see events.ts's doc comment on
        // why this is the strongest single argument for events over the old end-of-run bag.
        emit({
          type: "coverage-split",
          batchIndex: batchIdx,
          untargetedTriggerCount: split.untargetedTriggerCount,
          coveredCount: split.covered.size,
          noCoverageCount: split.uncovered.length,
        });
      }
      // A mutant uncovered by any GREEN test but covered by a non-passing
      // baseline test is `error` (score-excluded) with a named note — never a
      // silent `no-coverage` false-negative (a real test DOES cover it; it just
      // couldn't run). `unsupportedCoverage` reuses coverageFilter against the
      // second index; empty for coverage:"none" (uncovered is empty there too).
      //
      // Its `untargetedTriggerCount` is deliberately NOT added to the session tally: a table
      // trigger can never appear in `uncovered` (FALLBACK 2 above catches every one of them
      // before the `uncovered.push`), so this call's tally is structurally 0 — and were that
      // ever to change, adding it would double-count mutants the SESSION already ran against
      // every green test. The number on the report means "took the all-green-tests fallback in
      // the run that decided the verdict", and this call decides no verdict.
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
      // R69 Phase 2 Task 6: a mutant covered ONLY by a non-passing baseline test is a routing
      // CANDIDATE, not yet a verdict — `describeTestPageUnsupported`-refused tests may be
      // routable through the client-services batch path (`selectRoutedTests`). Recording is
      // deferred until after the fenced mutant loop below (routed work must never overlap it —
      // see `SessionConfig.routedTransport`'s doc comment); everything NOT resolved to a routed
      // verdict falls back to exactly this pre-Task-6 note.
      const routableCandidates: Array<{
        mutant: MutantManifestEntry;
        covering: readonly TestMethodRef[];
      }> = [];
      for (const m of uncovered) {
        const covering = unsupportedCoverage.get(m.mutantId);
        if (covering !== undefined && covering.length > 0) {
          routableCandidates.push({ mutant: m, covering });
        } else {
          record(cfg.store, runId, m, "no-coverage", outcomes, batchIdx, emit);
        }
      }
      // R69 Phase 2 Task 6: qualified test name -> BC's own baseline failure text, the input
      // `describeTestPageUnsupported`/`selectRoutedTests`' gate 1 reads. Keyed off
      // `unsupportedBaseline` (batch-local, like `testPageThisBatch` above) rather than
      // `refusedThisBatch`/`testPageThisBatch`, which already discarded the raw text after
      // classifying it — gate 1 needs the text itself, not this batch's conclusion about it.
      const baselineFailureMessages = new Map<string, string | undefined>(
        unsupportedBaseline.map((b) => [qualifiedTestName(b.ref), b.verdict.failureMessage]),
      );

      // 5b. R47 resume: record the mutants a prior run already scored, WITHOUT executing them, and
      // hand only the remainder to the per-mutant loop.
      //
      // Deliberately placed here rather than beside the history filter at step 2, because the
      // covering-test list and its attribution are computed at step 5 and a carried verdict
      // deserves this run's fresh ones — a resumed survivor must still be actionable (which tests
      // ran it, by which attribution path), and those were never in the database.
      //
      // The `perMutantTests.get(...) === undefined` skip is the same guard the worker shards use:
      // step 5 has ALREADY recorded those mutants as `no-coverage`, and `mutants` has no unique
      // constraint on (run_id, mutant_code), so a second record() would silently duplicate rather
      // than fail.
      let toExecute: MutantManifestEntry[] = execute;
      if (resumeState !== undefined) {
        toExecute = [];
        for (const m of execute) {
          const covering = perMutantTests.get(m.mutantId);
          if (covering === undefined) continue; // step 5 already recorded no-coverage
          // R53: a mutant a prior run STRANDED the tier on is not retried by default. Measured on
          // Document Output: M0013 negates `until DOCustSetup.Next() = 0;` into `<> 0`, which never
          // terminates — so re-running it re-hangs, re-quarantines, and blocks the 125 mutants
          // queued behind it. No `--mutant-timeout-ms` value fixes that (180 s and 330 s both
          // aborted; 360 s is the hosting proxy's own ceiling), which makes retrying it not a
          // slow path but an unreachable one.
          //
          // Recorded `error` — score-excluded, never a verdict — and stated loudly, because the
          // honest answer is "this mutant was not measured", not "this mutant survived".
          if (!(cfg.retryStranded ?? false) && wasStranded(resumeState.index, m)) {
            record(
              cfg.store,
              runId,
              m,
              "error",
              outcomes,
              batchIdx,
              emit,
              undefined,
              "not re-run on resume: a prior run's execution of this mutant could not be confirmed complete and stranded the tier. A mutant that never terminates (e.g. a negated loop-exit condition) reproduces this every time and blocks every mutant behind it, so it is skipped rather than retried — pass --retry-stranded to attempt it anyway. It is NOT scored either way.",
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              true, // strandedSkip
            );
            strandedSkippedCount += 1;
            continue;
          }
          const carried = carriedVerdictFor(resumeState.index, m);
          if (carried === undefined) {
            toExecute.push(m);
            continue;
          }
          record(
            cfg.store,
            runId,
            m,
            carried.verdict,
            outcomes,
            batchIdx,
            emit,
            carried.killingTest,
            carried.failureNote,
            undefined,
            carried.durationMs,
            covering.map((ref) => qualifiedTestName(ref)),
            coverageAttribution.get(m.mutantId),
            undefined,
            true, // carried
            undefined,
            carried.runner,
            undefined,
            undefined,
            // R47/R54: NOT `runId` (this session's own id) — see record()'s `fromRunId` doc
            // comment. `resumeState` is defined in this branch (`if (resumeState !== undefined)`
            // above), so its `runId` — the PRIOR run this verdict was carried from — is in scope.
            resumeState.runId,
          );
          resumedMutantCount += 1;
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
      emit({ type: "phase-entered", phase: "mutants" });
      const mutantsStartedMs = Date.now();
      if (workers === 1) {
        // Sequential IS the parallel path with a pool of one: this is the
        // exact same runMutantsOnBackend call the fan-out branch below makes
        // per shard, just with all of `execute` as a single "shard" on the
        // one backend already deployed in step 3.
        await runMutantsOnBackend({
          permissionRefusedTests,
          runnerDisagreementTests,
          backend: cfg.backend,
          safety,
          ...(leaseSession !== undefined ? { leaseSession } : {}),
          mutants: toExecute,
          perMutantTests,
          coverageAttribution,
          baselineDuration,
          fallbackTimeoutMs,
          minMutantBudgetMs,
          store: cfg.store,
          runId,
          batchIndex: batchIdx,
          outcomes,
          quarantineStore,
          resourceKey,
          nowIso,
          attestation,
          emit,
        });
      } else {
        const shards = shardEvenly(toExecute, workers);
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
                record(cfg.store, runId, m, "error", outcomes, batchIdx, emit, undefined, note);
              }
              return;
            }
            await runMutantsOnBackend({
              permissionRefusedTests,
              runnerDisagreementTests,
              backend,
              safety,
              mutants: shard,
              perMutantTests,
              coverageAttribution,
              baselineDuration,
              fallbackTimeoutMs,
              minMutantBudgetMs,
              store: cfg.store,
              runId,
              batchIndex: batchIdx,
              outcomes,
              quarantineStore,
              resourceKey,
              nowIso,
              attestation,
              emit,
            });
          }),
        );
        const firstRejection = settled.find(
          (r): r is PromiseRejectedResult => r.status === "rejected",
        );
        if (firstRejection !== undefined) throw firstRejection.reason;
      }
      emit({ type: "phase-left", phase: "mutants", elapsedMs: Date.now() - mutantsStartedMs });
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
      // `toExecute`, not `execute`: under `--resume` a batch may schedule nothing at all because
      // every one of its mutants carried a prior verdict. Such a batch issues no covered run, so
      // it can never earn an attestation — gating it on `execute` would fail the artifact and
      // quarantine the container for the crime of having nothing left to do. A carried verdict is
      // not a verdict this artifact produced, so it is correctly outside this gate's scope.
      const contributed = toExecute.some((m) => (perMutantTests.get(m.mutantId)?.length ?? 0) > 0);
      if (caps.authoritative && contributed && !attestation.clean) {
        const note = `unattested artifact: no covered run observed the deployed binary's selector (artifactId ${compiled?.artifactId ?? "unknown"}) — verdicts discarded, container quarantined (design §G)`;
        invalidateBatchVerdicts(outcomes, batchIdx, note);
        emit({ type: "batch-invalidated", batchIndex: batchIdx, reason: note });
        // R47: and durably, in the store. `--resume` reads a run's stored verdicts by
        // `finished_at IS NULL` — the exact set this gate's in-memory-only correction used to rely
        // on `priorSurvivorKeys` filtering OUT. Without this, resuming a quarantined run would
        // resurrect the false survivors the gate exists to destroy.
        cfg.store.invalidateBatch(runId, batchIdx, note);
        safety.latchUnsafe(note);
      }
      // R69 Phase 2 Task 6: resolve this batch's routing candidates — deliberately AFTER both
      // fenced-mutant-loop branches above (sequential and worker fan-out) and after the
      // attestation gate right above, never interleaved with either. Routed work runs over a
      // DIFFERENT session/transport (client-services, `GuiAllowed=Yes`) than the lease-fenced
      // `RunMutant` path those use, so it must never overlap it on the same tier — see
      // `SessionConfig.routedTransport`'s doc comment. Skipped entirely once `safety.isUnsafe`:
      // the fenced loop or the attestation gate just latched for a reason of their own, and a
      // batch already abandoned records nothing further (matches every other post-latch branch
      // in this function).
      // R69 CLOSED (measured 2026-08-02): a mutant covered ONLY by a test the fenced session
      // cannot run is NAMED and left unscored. It is not recovered, and nothing here tries — the
      // client-services routed path that would have recovered it was measured to be worth 2.30%
      // of a real app's mutants and deleted (see ROADMAP R69, docs/measurements §"R69's go/no-go").
      // Naming it is the shipped value: `unsupportedCoverageNote` quotes BC's own refusal, so a
      // reader sees "your TestPage test cannot run on this path", not a silent `no-coverage`.
      if (routableCandidates.length > 0 && !safety.isUnsafe) {
        for (const c of routableCandidates) {
          const qualified = [...new Set(c.covering.map(qualifiedTestName))].sort();
          record(
            cfg.store,
            runId,
            c.mutant,
            "error",
            outcomes,
            batchIdx,
            emit,
            undefined,
            unsupportedCoverageNote(qualified, refusedThisBatch, testPageThisBatch),
          );
        }
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
    emit({ type: "phase-entered", phase: "teardown" });
    const teardownStartedMs = Date.now();
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
    emit({ type: "phase-left", phase: "teardown", elapsedMs: Date.now() - teardownStartedMs });
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
    const lostBatchNote = `lease-lost: this batch's artifact was deployed under a lease this session could no longer prove it held (${safety.reason ?? "unknown"}) — verdicts discarded (design §6)`;
    invalidateBatchVerdicts(outcomes, lostBatchIndex, lostBatchNote);
    emit({ type: "batch-invalidated", batchIndex: lostBatchIndex, reason: lostBatchNote });
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
  } else {
    emit({ type: "quarantined", reason: safety.reason ?? "unknown" });
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
  const totalMs = Date.now() - sessionStartedMs;
  emit({ type: "session-finished", elapsedMs: totalMs });
  return buildReport({
    caps,
    baselineGreen: baselineGreenOverall,
    batches: artifacts.length,
    outcomes,
    unsupportedTests: [...unsupportedTestNames].sort(),
    notInstrumented: { totalFiles: totalAlFiles, files: notInstrumentedFiles },
    // Every discovered test, so the report can state the denominator behind `unsupportedTests`
    // and index test files for `SessionReport.testFiles`.
    ...(missingFromServer.size > 0
      ? { staleTestApp: { missingTests: [...missingFromServer].sort() } }
      : {}),
    ...(testPageUnsupportedTests.size > 0
      ? { testPageUnsupportedTests: [...testPageUnsupportedTests].sort() }
      : {}),
    ...(permissionRefusedTests.size > 0
      ? { permissionsRefusedTests: [...permissionRefusedTests].sort() }
      : {}),
    ...(runnerDisagreementTests.size > 0
      ? { runnerDisagreementTests: [...runnerDisagreementTests].sort() }
      : {}),
    ...(cfg.stopHungSessions === true ? { stopHungSessions: true } : {}),
    baselineTests: tests.map((t) => ({
      codeunitName: t.codeunitName,
      ...(t.file !== undefined ? { file: t.file } : {}),
    })),
    timings: {
      totalMs,
      generateMutationSetMs,
      deployMs,
      baselineMs,
    },
    untargetedTriggerCount,
    // R41: recorded whenever the run was narrowed, so the `--out` JSON carries the qualifier and
    // not just the console line. Keyed on the request (`cfg.only`), not on `excludedByOnly > 0`:
    // a pattern that happens to admit every file still narrowed the run by intent, and a reader
    // comparing two reports must be able to see that this one was scoped.
    ...(cfg.only !== undefined && cfg.only.length > 0
      ? { only: { patterns: cfg.only, excludedFileCount: excludedByOnly } }
      : {}),
    ...(cfg.testsOnly !== undefined && cfg.testsOnly.length > 0
      ? { testsOnly: cfg.testsOnly }
      : {}),
    ...(safety.isUnsafe ? { quarantined: { reason: safety.reason ?? "unknown" } } : {}),
    ...(permissionCanary !== undefined ? { permissionCanary } : {}),
    // R47: keyed on the REQUEST, like `only` above — a `--resume` that turned out to carry nothing
    // still describes a run assembled differently, and a reader comparing two reports must see it.
    ...(resumeState !== undefined
      ? {
          resumedFrom: {
            runId: resumeState.runId,
            carriedMutants: resumedMutantCount,
            skippedStranded: strandedSkippedCount,
          },
        }
      : {}),
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

/**
 * R35. The note for a mutant covered ONLY by tests that did not pass at baseline.
 *
 * Two different facts need two different sentences. "Unsupported test type" is the honest label
 * when a test could not run in the web-service session — but when BC REFUSED the test on
 * permissions it is actively WRONG: it points the reader at the test's type when the cause is a
 * missing `TestPermissions = Disabled`, and a reader who believes it goes looking for a TestPage.
 *
 * `refusedThisBatch` maps a qualified test name to BC's own diagnosis text (see
 * `describeTestPermissionsRefusal`), which is appended verbatim rather than summarised: the
 * detector is a hedged English regex, and the quote is what lets a reader overrule it.
 *
 * Extracted from `runSession` so the mixed case — some covering tests refused, others merely
 * broken — is reachable from a unit test without standing up a two-batch session.
 */
export function unsupportedCoverageNote(
  qualified: readonly string[],
  refusedThisBatch: ReadonlyMap<string, string>,
  testPageThisBatch: ReadonlyMap<string, string> = new Map(),
): string {
  // "Covered by refused tests AND others" and "covered ONLY by refused tests" are different facts;
  // saying "only" in both cases contradicts the list that follows it. Shared by both named causes.
  const describe = (
    lead: string,
    named: readonly string[],
    diagnosis: string,
    subject: string,
  ): string => {
    const others = qualified.filter((n) => !named.includes(n));
    const alongside =
      others.length > 0
        ? `, and by test(s) that did not pass for another reason (${others.join(", ")})`
        : ", and by no test that passed";
    return `${lead}: mutant covered by test(s) ${subject} (${named.join(", ")})${alongside} — ${diagnosis}`;
  };

  // R35 FIRST, deliberately. A permissions refusal has a one-line fix in the reader's own source; a
  // R69 TestPage refusal has none. When a mutant is covered by one of each, leading with the
  // TestPage cause would tell a reader whose problem IS fixable that nothing can be done.
  const refused = qualified.filter((n) => refusedThisBatch.has(n));
  const refusedFirst = refused[0];
  const refusalText = refusedFirst === undefined ? undefined : refusedThisBatch.get(refusedFirst);
  if (refusalText !== undefined) {
    return describe("permissions refusal", refused, refusalText, "BC refused at baseline");
  }

  // R69: the platform cannot run these tests on this path at all — a fact about the SESSION TYPE,
  // not about the test. Named separately from the generic wording below, which sends a reader to
  // debug a test that is already correct.
  const testPage = qualified.filter((n) => testPageThisBatch.has(n));
  const testPageFirst = testPage[0];
  const testPageText =
    testPageFirst === undefined ? undefined : testPageThisBatch.get(testPageFirst);
  if (testPageText !== undefined) {
    return describe(
      "testpage unsupported on this path",
      testPage,
      testPageText,
      "that cannot run on this session type",
    );
  }

  return `unsupported test type: mutant covered only by test(s) that did not pass at baseline (${qualified.join(", ")})`;
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
  /** Which attribution path placed each mutant's covering tests — see `CoverageSplit.attribution`. */
  readonly coverageAttribution: ReadonlyMap<string, CoverageAttribution>;
  readonly baselineDuration: ReadonlyMap<string, number>;
  readonly fallbackTimeoutMs: number;
  /** R47: floor for the per-mutant budget — `SessionConfig.mutantTimeoutMs`, already defaulted. */
  readonly minMutantBudgetMs: number;
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
   * R35: session-level sink for tests BC refused on permissions, mutated in place like `outcomes`.
   *
   * The unstable path below recognises the SAME refusal (R27) and names it per mutant. Without
   * this, a run whose refusals surface only there emitted a per-mutant note saying "declare
   * `TestPermissions = Disabled`" while `SessionReport.permissionsRefused` was absent and the
   * `tests-permission-refused` caveat never fired — the same run disagreeing with itself.
   */
  readonly permissionRefusedTests: Set<string>;
  /**
   * R59: session-level sink for tests that failed their kill-confirmation while the backend runs a
   * HUB coverage mode — i.e. tests the hub passed and the fence failed. Mutated in place like
   * `permissionRefusedTests`, and for the same reason: a per-mutant note saying "runner
   * disagreement" while the report's own field was absent would be one run disagreeing with itself.
   */
  readonly runnerDisagreementTests: Set<string>;
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
  readonly emit: RunEmitter;
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
      record(args.store, args.runId, m, "no-coverage", args.outcomes, args.batchIndex, args.emit);
      continue;
    }
    await activateOnce(args.backend, args.safety, m.mutantId);
    let verdict: SessionVerdict = "survived";
    let killingTest: string | undefined;
    let failureNote: string | undefined;
    let cause: "deadline-exceeded" | "unstable" | undefined;
    // Fix round 2, residual 1 (events.ts doc comment): the exact instant the kill-confirmation
    // loop below decides `cause: "unstable"` because a HUB-green test failed on the FENCE is also
    // the exact instant it knows WHICH test disagreed — captured here so the eventual `record()`
    // call (after this loop) can carry both, matching `runnerDisagreementTests.add(...)` below.
    let runnerDisagreement: string | undefined;
    let runnerDisagreementTest: string | undefined;
    let spent = 0;
    // Whether any instrumented guard fired during this mutant's runs — see
    // `MutantOutcome.guardObserved`. Left undefined on a backend that never attests.
    let guardObserved: boolean | undefined;
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
        args.minMutantBudgetMs,
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
        args.emit,
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
      // Per-mutant, not just per-artifact: OR-ed across this mutant's covering runs so a survivor
      // can say whether any guarded code ran at all. `undefined` stays `undefined` on a backend
      // that cannot attest — see `MutantOutcome.guardObserved`.
      if (v.attestation !== undefined) {
        guardObserved = (guardObserved ?? false) || v.attestation.observedAny;
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
          detail: `test in-flight-unknown running ${ref.method} (mutant ${m.mutantId})${retried ? " — a first, proven-complete attempt had already been retried once" : ""}${v.failureMessage !== undefined ? `: ${v.failureMessage}` : ""} [budget was ${budget} ms; raise the floor with --mutant-timeout-ms and continue with --resume]`,
        });
        // R47: the two things the operator needs are the budget this run used and the fact that
        // the verdicts already measured are NOT lost. Both went unsaid until a real project hit
        // this at mutant 13 of 138 and discarded the first twelve.
        failureNote = `${STRANDED_NOTE_PREFIX}${ref.method} returned no readable result and its operation could not be confirmed complete — container may be stranded. Its budget was ${budget} ms; if the mutant was merely slow rather than stranded, raise the floor with --mutant-timeout-ms and re-run with --resume to keep this session's verdicts`;
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
          args.emit,
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
            failureNote = `${STRANDED_NOTE_PREFIX}${ref.method} confirm returned no readable result and its operation could not be confirmed complete — container may be stranded`;
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
          // R35: record it session-wide too, so the report's `permissionsRefused` field and this
          // note cannot disagree about whether the run hit a permissions refusal.
          if (refusal !== undefined) args.permissionRefusedTests.add(qualifiedTestName(ref));
          // R59: in a HUB coverage mode this test was hub-GREEN by construction — a covering test
          // comes from the green set, and the green set came from bc-dev-mcp — and it has just
          // failed unmutated on the FENCE. That is the runner disagreement itself, observed at no
          // extra cost, and reporting it only as "unstable" sends the reader to debug flakiness.
          // Strictly a diagnosis: the verdict is already `error cause=unstable` and does not move.
          const disagreement = describeRunnerDisagreement(args.backend.capabilities().coverage);
          if (disagreement !== undefined) {
            args.runnerDisagreementTests.add(qualifiedTestName(ref));
            runnerDisagreement = disagreement;
            runnerDisagreementTest = qualifiedTestName(ref);
          }
          failureNote = `unstable test ${ref.method}: fails at baseline confirmation${
            refusal !== undefined ? ` — ${refusal}` : ""
          }${disagreement !== undefined ? ` — ${disagreement}` : ""}`;
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
      args.emit,
      killingTest,
      failureNote,
      cause,
      spent,
      // `covering` is exactly what this loop just ran the mutant against, so a survivor's report
      // entry names the tests that failed to notice it — see `SessionOutcome.coveringTests`.
      covering.map((ref) => qualifiedTestName(ref)),
      args.coverageAttribution.get(m.mutantId),
      guardObserved,
      undefined, // carried
      undefined, // strandedSkip
      undefined, // runner — every call site in this loop predates client-services routing
      runnerDisagreement,
      runnerDisagreementTest,
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
 * True for a NON-AL path under a tooling directory rather than app content — any SEGMENT starting
 * with `.`, so a nested one is caught too. In practice that is `.alpackages`, `.netpackages`,
 * `.vscode`, `.snapshots` and `.git`. Excluding `.alpackages` is not merely tidiness: it is
 * hundreds of megabytes of symbol packages that would otherwise be duplicated into every batch
 * dir.
 *
 * Applied ONLY to the resource copy, never to `.al`. A dot-directory can hold real source: the
 * Continia Document Output app keeps 137 genuine `.al` files under `.dependencies`, and `alc`
 * compiles them, so filtering them out would silently shrink the app. The `.al` sweep therefore
 * stays exactly as broad as it has always been.
 */
function isToolResourcePath(rel: string): boolean {
  return rel.split(/[\\/]/).some((segment) => segment.startsWith("."));
}

/**
 * Spec §5: the instrumented app must keep the target app's id, carry the
 * per-artifact version reserved via `reserveAppVersion` (app-version.ts —
 * clock-derived, monotonic across runs with no stored counter; the old
 * `1.0.<runId>.<batchIdx>` scheme died with its dependence on a persistent
 * results DB), and must contain every project source file so `alc` can
 * actually compile it — not just the files `writeInstrumentedProject` wrote
 * for this batch's mutants.
 *
 * "Every project source file" means resources too (R39). `app.json` names a `logo`, and a real
 * project also carries translations (`.xlf`), report layouts, control add-in bundles and
 * permission XML. Copying only `*.al` left `alc` to stop at
 * `app.json(13,3): error AL1001: Source file 'Images\Logo.png' could not be found` — BEFORE
 * compiling a line, so the failure was not even attributable to instrumentation. Every fixture in
 * this repo is resource-free, which is why the real Continia Document Output app was what found
 * it. Resources keep their relative path, since that is what `app.json` and every layout
 * reference names; only `.al` is flattened, because that is the shape
 * `writeInstrumentedProject` writes.
 *
 * Exported for direct testing: the layout it produces is what `alc` compiles, and a defect here
 * surfaces as a compile error attributed to the wrong thing entirely.
 */
export async function prepareBatchProject(
  projectDir: string,
  batchDir: string,
  projectManifest: Readonly<Record<string, unknown>>,
  appVersion: string,
): Promise<void> {
  await writeStampedAppJson(batchDir, projectManifest, appVersion);

  const entries = await readdir(projectDir, { recursive: true, withFileTypes: true });

  // writeInstrumentedProject only wrote files with >=1 mutant spec in this
  // batch; copy every other project source file verbatim (files whose sites
  // landed in a different batch, or that have no mutable sites at all) so
  // the batch dir holds the FULL project alc needs to compile.
  //
  // The flattening to `basename` is dictated by `writeInstrumentedProject`, which writes its
  // emissions that way. It makes two same-named files in different folders collide, and the
  // `pathExists` skip below — there to leave an instrumented emission alone — would silently
  // swallow the second one, dropping an AL object from the published app with no diagnostic.
  // So collisions are detected here on the SOURCE paths, independently of what is already on
  // disk, and refused loudly. (Continia Document Output has 551 distinct basenames across 551
  // files, so the flattening survives there — by luck, not by design.)
  const alBySeenBasename = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const rel = relative(projectDir, join(entry.parentPath, entry.name));
    if (!rel.toLowerCase().endsWith(".al")) continue;
    const base = basename(rel);
    const previous = alBySeenBasename.get(base.toLowerCase());
    if (previous !== undefined) {
      throw new Error(
        `cannot build the batch project: two source files share the basename "${base}" (${previous} and ${rel}). Instrumented files are written flat, so one would silently replace the other and its AL objects would be missing from the published app. Rename one of them.`,
      );
    }
    alBySeenBasename.set(base.toLowerCase(), rel);
    const dest = join(batchDir, base);
    if (await pathExists(dest)) continue;
    await copyFile(join(projectDir, rel), dest);
  }

  // Resources: same set minus the `.al` files above, minus the stamped `app.json` and any
  // already-built `.app` package, copied with their directory structure intact.
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const rel = relative(projectDir, join(entry.parentPath, entry.name));
    const lower = rel.toLowerCase();
    if (lower.endsWith(".al") || lower.endsWith(".app")) continue;
    if (basename(lower) === "app.json") continue;
    if (isToolResourcePath(rel)) continue;
    const dest = join(batchDir, rel);
    await mkdir(dirname(dest), { recursive: true });
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
  opts: { coverage: CoverageMode; timeoutMs: number },
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
 * This corrects the in-memory `outcomes[]` ONLY. `runSession` pairs it with
 * `store.invalidateBatch(runId, batchIndex, note)`, which applies the same correction durably, and
 * with `safety.latchUnsafe(note)`, which marks the whole session `report.quarantined` (spec
 * §8/§12).
 *
 * The durable half is not optional (R47). This used to rely on a quarantined run never reaching
 * `store.finishRun`, so `priorSurvivorKeys`'s `finished_at IS NOT NULL` filter would exclude its
 * stale on-disk rows from a future `--skip-known-survivors` run. `--resume` then arrived reading by
 * `finished_at IS NULL` — the exact complement — which would have made those rows not merely
 * visible but preferentially selected. Correcting the store removes the dependency on a filter in
 * an unrelated query, which was always the fragile part of that argument.
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
 *
 * `emit` is REQUIRED — placed right after the other required parameters, not literally last,
 * because TypeScript rejects a required parameter following an optional one (TS1016) and every
 * parameter from `killingTest` onward is optional/defaulted. Required-and-early achieves the same
 * invariant the design calls for ("no call site can write a store row without emitting") as
 * required-and-last would: every one of the ten call sites in this file must pass it, or the
 * build fails. `record` is the single choke point that writes both the store row and the
 * `outcomes[]` entry `buildReport` still reads today; this emits the SAME facts a third way,
 * immediately after `store.recordMutant` returns, so the two can never drift apart from a missed
 * call site.
 *
 * Exported ONLY for `tests/events-orchestrator.test.ts`, which drives this choke point directly
 * (against a real in-memory `ResultsStore` — the same "construct `new ResultsStore(":memory:")`
 * and call its methods directly" pattern `resume.test.ts`/`runner-provenance.test.ts` already use)
 * to prove events agree with recorded outcomes without needing a full `runSession`. No other
 * caller outside this file may use it — `runSession` and `runMutantsOnBackend` are the only real
 * callers, and both live here.
 */
export function record(
  store: ResultsStore,
  runId: number,
  m: MutantManifestEntry,
  verdict: MutantVerdict,
  outcomes: SessionOutcome[],
  batchIndex: number,
  emit: RunEmitter,
  killingTest?: string,
  failureNote?: string,
  cause?: "deadline-exceeded" | "unstable",
  durationMs = 0,
  // The tests this mutant was actually run against — see `SessionOutcome.coveringTests`. Defaults
  // to empty for the call sites that record without executing anything (`no-coverage`, known
  // survivors, batch-wide failures), where empty is the honest answer rather than a placeholder.
  coveringTests: readonly string[] = [],
  coverageAttribution?: CoverageAttribution,
  guardObserved?: boolean,
  // R54: this verdict was carried from a prior run by `--resume`, so its duration belongs to that
  // run's cost, not this one's. See `MutantOutcome.carried`.
  carried?: boolean,
  // R53: this "error" recording is a mutant a PRIOR run stranded the tier on, skipped rather than
  // re-executed — the one call site (`runSession` step 5b) that always passes `verdict: "error"`
  // alongside this flag. Emits `mutant-skipped-stranded` instead of `mutant-scored`: that event's
  // own type already implies "error" (see events.ts's doc comment), so `verdict` is not repeated
  // on it, only `mutant`/`batchIndex`/`note`.
  strandedSkip?: boolean,
  // R69 Phase 2 Task 5: which execution path produced this verdict — see `RunnerKind` (store.ts).
  // Every call site in THIS file predates client-services routing (Task 6 wires that) except the
  // `--resume` replay path, which passes `carried.runner` through unchanged so a verdict carried
  // from an interactive run keeps its tag instead of silently reading as fenced — the resume hole
  // this task closes. Absent elsewhere, which `buildReport` reads as `"fenced"`.
  runner?: RunnerKind,
  // The two fields below ride ONLY on `mutant-scored` (never on `mutant-carried`) — see
  // events.ts's doc comment on `mutant-scored.runnerDisagreement`/`runnerDisagreementTest`. Set
  // only by the kill-confirmation call site (runMutantsOnBackend), which observes them at the
  // exact instant it also decides `cause: "unstable"`.
  runnerDisagreement?: string,
  runnerDisagreementTest?: string,
  // The prior run a carried verdict came FROM — required when `carried === true` (see the throw
  // below), never used otherwise. This is NOT `runId` (the CURRENT run being recorded into): the
  // brief's own sketch used `runId` here, but that would report a carried verdict as carried from
  // itself. The correct value is the resume's resolved prior run id, known to the ONE call site
  // that ever passes `carried: true` (`runSession`'s step 5b, which has `resumeState.runId` in
  // scope) — flagged here for the task report since it corrects rather than follows the brief.
  fromRunId?: number,
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
    batchIndex,
    ...(killingTest !== undefined ? { killingTest } : {}),
    ...(failureNote !== undefined ? { failureNote } : {}),
    ...(runner !== undefined ? { runner } : {}),
  });
  outcomes.push({
    mutant: m,
    verdict,
    batchIndex,
    durationMs,
    coveringTests,
    ...(coverageAttribution !== undefined ? { coverageAttribution } : {}),
    ...(guardObserved !== undefined ? { guardObserved } : {}),
    ...(carried === true ? { carried: true } : {}),
    ...(killingTest !== undefined ? { killingTest } : {}),
    ...(failureNote !== undefined ? { failureNote } : {}),
    ...(cause !== undefined ? { cause } : {}),
    ...(runner !== undefined ? { runner } : {}),
  });
  if (carried === true) {
    if (fromRunId === undefined) {
      throw new Error(
        "record(): carried=true requires fromRunId (the prior run this verdict was carried from) — caller-contract violation",
      );
    }
    emit({
      type: "mutant-carried",
      mutant: m,
      verdict,
      fromRunId,
      batchIndex,
      priorDurationMs: durationMs,
      ...(killingTest !== undefined ? { killingTest } : {}),
      ...(failureNote !== undefined ? { failureNote } : {}),
      coveringTests,
      ...(coverageAttribution !== undefined ? { coverageAttribution } : {}),
      ...(runner !== undefined ? { runner } : {}),
    });
  } else if (strandedSkip === true) {
    if (failureNote === undefined) {
      throw new Error(
        "record(): strandedSkip=true requires failureNote (used as mutant-skipped-stranded.note) — caller-contract violation",
      );
    }
    emit({ type: "mutant-skipped-stranded", mutant: m, batchIndex, note: failureNote });
  } else {
    emit({
      type: "mutant-scored",
      mutant: m,
      verdict,
      batchIndex,
      durationMs,
      ...(killingTest !== undefined ? { killingTest } : {}),
      ...(failureNote !== undefined ? { failureNote } : {}),
      ...(cause !== undefined ? { cause } : {}),
      coveringTests,
      ...(coverageAttribution !== undefined ? { coverageAttribution } : {}),
      ...(guardObserved !== undefined ? { guardObserved } : {}),
      ...(runner !== undefined ? { runner } : {}),
      ...(runnerDisagreement !== undefined ? { runnerDisagreement } : {}),
      ...(runnerDisagreementTest !== undefined ? { runnerDisagreementTest } : {}),
    });
  }
  return mutantRowId;
}
