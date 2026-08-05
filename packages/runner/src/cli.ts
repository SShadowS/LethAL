#!/usr/bin/env bun
import { closeSync, existsSync, openSync, writeSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import {
  type AppIdRange,
  CONTROL_REGISTER_FILENAME,
  CONTROL_SELECTOR_FILENAME,
  CONTROL_UPGRADE_FILENAME,
  type DeclaredObject,
  type InstrumentedFile,
  type SelectorConfig,
  type TierResolver,
  dedupeSpecs,
  parseIdRanges,
  scanDeclaredObjects,
  validateSelectorIds,
} from "@lethal/schemata";
// R49: a STATIC import, not a runtime read of `package.json`. R50 measured what happens to a
// runtime-computed path under `bun build --compile` — it resolves against Bun's virtual root and
// fails — so the version has to be bundled the same way the wasm assets are. The root
// `package.json` is the single source of truth for the release version (see `docs/releasing.md`);
// workspace packages stay at 0.0.0 and are private.
import rootPackageJson from "../../../package.json" with { type: "json" };
import type { ActivationConfig, FetchFn } from "./activation";
import { AlRunnerBackend } from "./al-runner-backend";
import {
  type AlRunnerCanaryResult,
  alRunnerCanaryWarnings,
  runAlRunnerCanary,
} from "./al-runner-canary";
import { ArtifactCompiler, defaultArtifactIo } from "./artifact";
import type { ExecutionBackend } from "./backend";
import { BcDevMcpBackend } from "./bcdev-backend";
import type { BcDevConfig } from "./bcdev-backend";
import { DeploymentVerifier } from "./deployment-verifier";
import { ENV_STATUS_REACHABLE_NO_VENDOR_STATUS, runDoctor } from "./doctor";
import type { DoctorConfig, DoctorDeps, DoctorReport } from "./doctor";
import { EnvToolClient, EnvToolError, READS_KEYS, validateEnvToolConfig } from "./env-tool";
import type { EnvToolBlock, EnvToolConfigSection } from "./env-tool";
import { EnvToolPublisher } from "./env-tool-publisher";
import {
  deriveMcpPort,
  requireBcDevRawFields,
  splitBaseUrl,
  startEnvToolSession,
} from "./env-tool-session";
import type { EnvToolSession } from "./env-tool-session";
import type { EventSubscriber } from "./events";
import { assertExplainableReport, explain } from "./explain";
import { HarnessVerifier } from "./harness";
import { LeaseClient } from "./lease";
import {
  LARGE_RUN_MUTANT_THRESHOLD,
  MIN_MUTANT_BUDGET_MS,
  defaultQuarantineDir,
  generateMutationSet,
  operatorTiers,
  planArtifacts,
  runSession,
} from "./orchestrator";
import type { SessionConfig } from "./orchestrator";
import { PermissionCanaryClient, runPermissionCanary } from "./permission-canary";
import { createNdjsonSink } from "./progress-ndjson";
import { createProgressRenderer } from "./progress-renderer";
import { clearPublishCeiling, knownCeiling } from "./publish-ceiling";
import type { PublishCeiling } from "./publish-ceiling";
import { canonicalContainerKey } from "./publish-serializer";
import { ContainerDeployer, defaultAlToolPaths, defaultDeployerIo } from "./publisher";
import type { AppPublisher } from "./publisher";
import { QuarantineStore } from "./quarantine-store";
import { renderConsole, writeJsonReport } from "./report";
import type { SessionReport } from "./report";
import { quarantineResourceKey } from "./resource-key";
import { RunMutantTransport } from "./run-mutant-transport";
import { ResultsStore } from "./store";
import type { PublishOutcomeRow } from "./store";

/**
 * `cli.ts` is argument marshaling only — everything that decides pass/fail
 * (batching, deploy, activation, verdicts) lives in orchestrator.ts/selection.ts,
 * which are independently unit-tested. This file wires flags + a JSON config
 * file into the already-tested library calls and renders the result.
 */

// Verified against a real BC server (2026-07-18): the real `alc.exe` enforces app.json's
// `idRanges` (AL0297) for every object it compiles, including the injected Mutation
// Selector/Control/Active objects — unlike al-runner's compiler, which tolerated
// out-of-idRange ids without complaint. 50000/50001/50002 fall outside the fixture's
// 79000-79199 idRange and failed real compilation; these must live inside whatever
// idRange the target app declares. Kept as the default so every existing caller (and both
// frozen container gates) behaves identically — a real target app whose idRanges exclude
// this band overrides it via `--selector-id`/`--control-id`/`--table-id` or a config file
// `selectorIds` section (R3/R4; see `resolveSelectorIds` and `validateSelectorIdsForProject`
// below).
const DEFAULT_SELECTOR_IDS: SelectorConfig = {
  selectorId: 79199,
  controlId: 79198,
  tableId: 79197,
};

/**
 * How often `runFromCli`'s stderr progress renderer (progress-renderer.ts) may print a mutant-
 * progress tick. Every other line it prints (phase boundaries, baseline batches, coverage
 * splits, warnings) is already low-volume and renders on every occurrence; this is the one
 * throttle, and it exists only so a run with hundreds of mutants doesn't turn into hundreds of
 * lines — the final per-mutant table in the report already exists for that. 15s: frequent enough
 * that the mutants phase never looks stalled, infrequent enough not to compete with the
 * per-batch/per-phase lines that matter more.
 */
const PROGRESS_HEARTBEAT_MS = 15_000;

/**
 * Resolves the three injected object ids (the "Mutation Selector"/"Mutation Register"/"Mutation
 * Upgrade" codeunits) with precedence CLI flag > `lethal.config.json`'s `selectorIds` section >
 * `DEFAULT_SELECTOR_IDS` — decided independently PER ID, so a caller overriding just one of the
 * three (say, because only `selectorId` collides with something) doesn't have to name the other
 * two. R3: previously all three were hardcoded to `DEFAULT_SELECTOR_IDS` with no override surface
 * at all, so any target app whose `idRanges` excluded 79197-79199 could not be instrumented.
 *
 * Three independent ids rather than one base id + fixed offsets: a real target app's `idRanges`
 * can be several disjoint, narrow bands (e.g. accreted over time from separate Microsoft
 * allocations), and a base+offset scheme can't place ids across such a gap. Three explicit knobs
 * are more to type but work for every declared-range shape; `validateSelectorIdsForProject` below
 * is what actually catches a bad choice, so the extra flexibility costs nothing in safety.
 */
export function resolveSelectorIds(
  cliOverrides: Partial<SelectorConfig>,
  configFileSelectorIds: Partial<SelectorConfig> | undefined,
): SelectorConfig {
  return {
    selectorId:
      cliOverrides.selectorId ??
      configFileSelectorIds?.selectorId ??
      DEFAULT_SELECTOR_IDS.selectorId,
    controlId:
      cliOverrides.controlId ?? configFileSelectorIds?.controlId ?? DEFAULT_SELECTOR_IDS.controlId,
    tableId: cliOverrides.tableId ?? configFileSelectorIds?.tableId ?? DEFAULT_SELECTOR_IDS.tableId,
  };
}

/**
 * Validates the optional `lethal.config.json` `"selectorIds"` section's SHAPE — pure, no I/O.
 * Absent entirely is fine (returned as-is): the section is optional, and `resolveSelectorIds`
 * falls back to `DEFAULT_SELECTOR_IDS` for any id it doesn't supply. When present, each of
 * `selectorId`/`controlId`/`tableId` that IS given must be a positive integer.
 *
 * Mirrors `validateBcDevConfig`/`validateAlRunnerConfig`'s posture: `loadLethalConfigFile` is a
 * bare `JSON.parse(...) as LethalConfigFile`, so a string/0/negative value here would otherwise
 * flow silently into `resolveSelectorIds` and only surface later as a confusing "falls outside
 * every idRange" from `validateSelectorIds` — correct, but it doesn't name the config file as the
 * source of the bad value the way this does, or the way the `--selector-id` flag's own parse-time
 * check already does.
 */
export function validateSelectorIdsConfig(
  raw: Partial<SelectorConfig> | undefined,
): Partial<SelectorConfig> | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(
      `lethal.config.json "selectorIds" section must be an object with optional numeric "selectorId"/"controlId"/"tableId" fields, got ${JSON.stringify(raw)}`,
    );
  }
  const invalid: string[] = [];
  for (const key of ["selectorId", "controlId", "tableId"] as const) {
    const v = raw[key];
    if (v !== undefined && (!Number.isInteger(v) || v < 1)) invalid.push(key);
  }
  if (invalid.length > 0) {
    throw new Error(
      `lethal.config.json "selectorIds" section has invalid field(s) (each must be a positive integer): ${invalid.join(", ")}`,
    );
  }
  return raw;
}

/**
 * Reads and parses the target project's `app.json` purely to validate selector ids against its
 * `idRanges` — a narrower, standalone reader kept separate from orchestrator.ts's own
 * `readProjectManifest` (which is per-batch and un-exported) so this validation has no dependency
 * on orchestrator.ts at all.
 */
async function readTargetAppManifestForIdCheck(
  projectDir: string,
): Promise<Record<string, unknown>> {
  const appJsonPath = join(projectDir, "app.json");
  let raw: string;
  try {
    raw = await readFile(appJsonPath, "utf8");
  } catch (err) {
    throw new Error(
      `cannot read ${appJsonPath} to validate selector ids against the target app's idRanges: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `${appJsonPath} is not valid JSON — cannot validate selector ids: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// This tool's own emitted files, by their exact names (@lethal/schemata) — never a real
// collision target. A prefix heuristic (`!basename(e).startsWith("Mutation")`) would ALSO skip a
// user's own legitimately-named file (e.g. `MutationTestHelper.Codeunit.al`), silently dropping
// it from the collision scan — exactly the "miss a real collision" failure this check exists to
// prevent. `orchestrator.ts`'s `generateMutationSet` has the same prefix heuristic and predates
// this change; left alone here (out of this task's scope) but worth the same fix.
const EMITTED_FILENAMES: ReadonlySet<string> = new Set([
  CONTROL_SELECTOR_FILENAME,
  CONTROL_REGISTER_FILENAME,
  CONTROL_UPGRADE_FILENAME,
]);

/**
 * Scans every `.al` file under `projectDir` (skipping this tool's own emitted files — see
 * `EMITTED_FILENAMES`) for codeunit ids the target project ALREADY declares — the input
 * `validateSelectorIds`'s existing-object-collision check needs. Only codeunits are collected:
 * all three injected objects are codeunits (see `emitMutationSelector`/`emitRegisterInstall`/
 * `emitRegisterUpgrade`), and a BC object id is unique only within its own type, so a same-id
 * table/page is not a real collision.
 */
async function scanProjectCodeunitIds(projectDir: string): Promise<Map<number, DeclaredObject>> {
  const entries = (await readdir(projectDir, { recursive: true }))
    .filter((e) => e.toLowerCase().endsWith(".al"))
    .filter((e) => !EMITTED_FILENAMES.has(basename(e)));
  const byId = new Map<number, DeclaredObject>();
  for (const rel of entries) {
    const source = await readFile(join(projectDir, rel), "utf8");
    for (const obj of scanDeclaredObjects(source)) {
      if (obj.type === "codeunit" && !byId.has(obj.id)) byId.set(obj.id, obj);
    }
  }
  return byId;
}

/**
 * The full R3/R4 pre-compile check: reads the target's `app.json` `idRanges`, scans its already-
 * declared codeunit ids, and validates the resolved `selectorIds` against both plus the
 * pairwise-distinct rule — all BEFORE any `alc`/`altool` invocation.
 *
 * Called twice on the real `lethal run` path, deliberately: first from `runFromCli`, as early as
 * both inputs (`parsed.projectDir`, resolved `selectorIds`) are available — specifically BEFORE
 * `resolveEnvToolSession`, which can provision a real, billed Layer-6C environment, so a bad id
 * fails in milliseconds rather than after a live environment already exists. Second, inside
 * `buildBackend` (both branches), positioned after every pre-existing early-exit check that
 * doesn't need a real project directory — kept as defense in depth for any caller that reaches
 * `buildBackend` some other way, and because it costs nothing beyond a second fs read.
 */
export async function validateSelectorIdsForProject(
  projectDir: string,
  selectorIds: SelectorConfig,
): Promise<void> {
  const manifest = await readTargetAppManifestForIdCheck(projectDir);
  const idRanges: AppIdRange[] = parseIdRanges(manifest);
  const existingCodeunitIds = await scanProjectCodeunitIds(projectDir);
  validateSelectorIds(selectorIds, idRanges, existingCodeunitIds);
}

export interface DryRunCliConfig {
  readonly mode: "dry-run";
  readonly projectDir: string;
  /** R41: `--only` globs, absent when the run was not narrowed — see `RunCliConfig.only`.
   *  Honoured here too, so the count a dry run reports is the count a real run would produce. */
  readonly only?: readonly string[];
  /**
   * R90: same defaults as `RunCliConfig`, because a dry run is where the publish ceiling is worth
   * knowing — before anything is generated, instrumented, compiled or published. Both are read
   * BEST-EFFORT and never created: a dry run must work in a project that has no config file and
   * has never been run (see `printDryRun`), so a missing file means "no bracket to report", not
   * an error.
   */
  readonly dbPath: string;
  readonly configPath: string;
}

export interface RunCliConfig {
  readonly mode: "run";
  readonly projectDir: string;
  readonly testDir: string;
  readonly backendKind: "bcdev" | "al-runner";
  readonly dbPath: string;
  readonly configPath: string;
  readonly skipKnownSurvivors: boolean;
  readonly outPath?: string;
  readonly workers: number;
  readonly compileConcurrency?: number;
  // Env-tool session controls (Task 7). Both default to false and are only meaningful for the
  // bcdev backend's environment tool (Task 6) — al-runner has no environment to keep or expire.
  readonly keepEnv: boolean;
  readonly allowExpiringEnv: boolean;
  /**
   * R3: per-id overrides from `--selector-id`/`--control-id`/`--table-id`, present only for the
   * ids actually given on argv — absent (not `{}`) when none were passed, matching this file's
   * `exactOptionalPropertyTypes` convention for optional fields and keeping every pre-existing
   * `parseCliConfig` equality test (which expects no such key at all) unaffected. Resolved against
   * `lethal.config.json`'s `selectorIds` section and `DEFAULT_SELECTOR_IDS` by `resolveSelectorIds`.
   */
  readonly selectorIdOverrides?: Partial<SelectorConfig>;
  /**
   * R41: `--only <glob>` (repeatable) narrows which project files contribute mutants, so a large
   * project has a cheap first run. Absent — not `[]` — when the flag was not given, matching this
   * file's `exactOptionalPropertyTypes` convention and leaving every existing `parseCliConfig`
   * equality test unaffected.
   *
   * Narrows MUTATION only. Every file is still parsed into the project-wide semantic context
   * (without which the Tier-2 shadowing guard goes inert and verdicts change), still compiled, and
   * still published. A pattern matching no file is refused — see `admittedByOnly`.
   */
  readonly only?: readonly string[];
  /**
   * R45: `--tests-only <glob>` (repeatable) narrows which TEST files run at baseline. Absent means
   * the whole suite.
   *
   * Distinct from `only` in kind, not just in target. `--only` selects mutants and cannot change a
   * verdict. This selects tests and CAN: exclude the test that would have killed a mutant and that
   * mutant is reported `survived`. It exists because the baseline dominates a real run — 744.8s of
   * 953.8s on Continia Document Output, all 1,246 tests, for a run scoped to one codeunit — and it
   * is recorded as a report caveat (`tests-narrowed`) so the trade is never invisible.
   */
  readonly testsOnly?: readonly string[];
  /**
   * R44: `--max-guards-per-batch <n>` bounds how many injected guards go into one published
   * artifact. Absent means no limit.
   *
   * Publish cost scales with guard count because BC recompiles the extension server-side: 163
   * guards published in 28 s, 11,777 were cut off by the hosting proxy at 362 s. Note each batch
   * pays its own deploy AND baseline, so a smaller budget buys publishability at the price of
   * repeating both — pair it with `--tests-only` (R45) on a large suite.
   */
  readonly maxGuardsPerBatch?: number;
  /**
   * R47: `--mutant-timeout-ms <n>` raises the FLOOR of the per-mutant time budget. Absent means
   * `MIN_MUTANT_BUDGET_MS` (180 s, R91).
   *
   * The effective budget stays `max(2 x that test's baseline duration, this)`. It exists because
   * the floor was a hardcoded constant with no config surface, and exceeding it costs the WHOLE
   * run: an over-budget run is indistinguishable from one the server may still be executing, so
   * the session quarantines. Measured on a real project, that discarded 12 scored mutants at
   * mutant 13 of 138.
   */
  readonly mutantTimeoutMs?: number;
  /**
   * R53 (`--stop-hung-sessions`), opt-in. Lets LethAL END THE BC SESSION running a mutant that has
   * exceeded its budget, so a non-terminating mutant scores `timeout-killed` instead of
   * quarantining the tier and blocking every mutant behind it. Off by default because it stops a
   * session on the user's server — see `SessionConfig.stopHungSessions`.
   */
  readonly stopHungSessions?: boolean;
  /**
   * R47: `--resume` (most recent unfinished run) or `--resume-run <id>` (a named one). Absent means
   * a fresh run. See `SessionConfig.resume`.
   */
  readonly resume?: "last" | number;
  /**
   * R53: `--retry-stranded` re-runs mutants a prior run stranded the tier on, instead of skipping
   * them. Off by default — the measured cause is a non-terminating mutant, which reproduces every
   * time and blocks every mutant behind it.
   */
  readonly retryStranded?: boolean;
  /**
   * R48: `--allow-large-run` opts out of the pre-flight size refusal — see
   * `LARGE_RUN_MUTANT_THRESHOLD`.
   */
  readonly allowLargeRun?: boolean;
  /**
   * Task 6 (event-stream refactor, spec 2026-08-05 §A): `--progress-out <path>` streams the event
   * stream to this path as NDJSON, one JSON object per line, flushed as each event arrives — the
   * crash diagnostic a finished-only report cannot be, and a structured stream an agent/CI consumer
   * can read without shelling out to `jq` against rendered prose. See `progress-ndjson.ts`'s module
   * doc for the header-line and provisional-verdict contract. Absent means no file is written.
   */
  readonly progressOutPath?: string;
}

/**
 * `lethal clear-quarantine --server <url> --instance <name>` (spec §10): reads the current
 * quarantine record's generation and calls `store.clear(key, gen)` — an operator-proven clear
 * after the operator has independently recycled the tier, not a self-service unblock.
 */
export interface ClearQuarantineCliConfig {
  readonly mode: "clear-quarantine";
  readonly server: string;
  readonly serverInstance: string;
}

/**
 * `lethal clear-ceiling --project <dir> --server <url> --instance <name> [--file <name>]`
 * (R90 fix round 1): discards recorded publish outcomes for one tier, so a TRANSIENT publish
 * failure stops permanently refusing files that size. Mirrors `clear-quarantine` — this project's
 * other sticky refusal state — in shape, in that the real clearing logic is an exported function
 * (`clearPublishCeiling`, publish-ceiling.ts) and this is only the wrapper.
 *
 * It needs `--project`/`--db` where `clear-quarantine` needs neither, because the ceiling lives in
 * the RESULTS database (`<project>/lethal.sqlite`), not in the machine-global `~/.lethal`
 * quarantine directory — and `--db` is honoured, resolved exactly as `run` resolves it, so an
 * operator who ran with `--db X` clears the same file that run wrote.
 */
export interface ClearCeilingCliConfig {
  readonly mode: "clear-ceiling";
  readonly projectDir: string;
  readonly dbPath: string;
  readonly server: string;
  readonly serverInstance: string;
  /** Narrows the clear to rows recorded against this file. Absent means the whole tier — see
   *  `clearPublishCeiling` for why the blanket clear is the default rather than the exception. */
  readonly file?: string;
}

/**
 * `lethal force-reset-lease --server <url> --instance <name> --config <path> [--project <dir>]`
 * (design §8 step 2 of the operator recovery procedure — see fixtures/README.md's "Recovering
 * from container-needs-recycle" and `performForceResetLease` below). Unlike `clear-quarantine`,
 * this needs a `--config` too: it authenticates a LIVE `HarnessInfo`/`ForceResetLease` OData call
 * against the server, which needs the bcdev section's company/username/password/tenant — nothing
 * clear-quarantine's purely-local quarantine-record clear requires.
 *
 * `--project` mirrors `DoctorCliConfig`'s own optional field below (R109): used only to satisfy a
 * `{projectDir}` placeholder an `envTool.resolve` block's command might reference — this command
 * runs no session, so it has no `testDir`/`runId` of its own the way `lethal run` does. Without
 * it, `resolveForceResetLeaseConfig` supplies `""` (`renderCommand` then throws BY NAME on the
 * unresolved placeholder, which is correct, but leaves an operator whose config needs it with no
 * flag to unblock themselves mid-recovery — this closes that gap).
 */
export interface ForceResetLeaseCliConfig {
  readonly mode: "force-reset-lease";
  readonly server: string;
  readonly serverInstance: string;
  readonly configPath: string;
  readonly projectDir?: string;
}

/**
 * R109: `lethal doctor --config <path> [--project <dir>]` — every pre-flight refusal `lethal run`
 * would otherwise discover ONE AT A TIME, run READ-ONLY and reported all at once. `--project` is
 * optional and used only to satisfy `{projectDir}` placeholders an `envTool.resolve` block's
 * command might reference (env-tool.ts's `renderCommand`) — doctor runs no session, so it has no
 * `testDir`/`runId` of its own the way `lethal run` does.
 */
export interface DoctorCliConfig {
  readonly mode: "doctor";
  readonly configPath: string;
  readonly projectDir?: string;
}

/**
 * `lethal explain <report.json>` — projects a finished report into what its data MEANS (see
 * `explain.ts`). Takes its input as a POSITIONAL rather than a flag, like every `<tool> <verb>
 * <file>` command, and reads nothing else: no server, no database, no config. It is the only
 * subcommand that touches no environment at all.
 */
export interface ExplainCliConfig {
  readonly mode: "explain";
  readonly reportPath: string;
}

/**
 * R49: `lethal --help` / `-h`, and a bare `lethal` with no arguments at all.
 *
 * `parseArgs` runs in strict mode, so before this an unknown `--help` exited 1 with a raw
 * `TypeError: Unknown option '--help'` and a stack trace into the bundled binary. That was
 * tolerable while the only way to run LethAL was from a checkout next to `fixtures/README.md`;
 * `v0.1.0-alpha.1` ships a downloadable executable whose user has neither.
 */
export interface HelpCliConfig {
  readonly mode: "help";
}

/** R49: `lethal --version` / `-V`. A bug report that cannot name the build it came from is a bug
 *  report about an unknown program. */
export interface VersionCliConfig {
  readonly mode: "version";
}

export type CliConfig =
  | DryRunCliConfig
  | RunCliConfig
  | ClearQuarantineCliConfig
  | ClearCeilingCliConfig
  | ForceResetLeaseCliConfig
  | DoctorCliConfig
  | ExplainCliConfig
  | HelpCliConfig
  | VersionCliConfig;

const VALID_SUBCOMMANDS = [
  "run",
  "clear-quarantine",
  "clear-ceiling",
  "force-reset-lease",
  "doctor",
  "explain",
] as const;

/**
 * `lethal` is invoked as `lethal run --project ...`, `lethal clear-quarantine --server ...
 * --instance ...`, or `lethal force-reset-lease --server ... --instance ... --config ...` (see
 * fixtures/README.md) rather than bare flags — require and validate the subcommand explicitly so
 * an unknown/missing one fails with a clear message instead of silently ignoring it. Returns the
 * validated subcommand so callers can dispatch on it.
 */
function requireKnownSubcommand(positionals: readonly string[]): string {
  const [subcommand] = positionals;
  if (subcommand !== undefined && (VALID_SUBCOMMANDS as readonly string[]).includes(subcommand)) {
    return subcommand;
  }
  const got = subcommand === undefined ? "none" : `"${subcommand}"`;
  throw new Error(
    `unknown subcommand: got ${got}, expected one of: ${VALID_SUBCOMMANDS.join(", ")}. Run \`lethal --help\` for usage.`,
  );
}

/**
 * R49: usage text. Written for someone holding only the downloaded binary — every flag that changes
 * what a run MEASURES says so, because those are the ones whose absence produces a confident wrong
 * number rather than an error.
 */
export function helpText(version: string): string {
  return `lethal ${version} — mutation testing for Business Central AL

USAGE
  lethal run               --project <dir> --tests <dir> --backend <bcdev|al-runner> [options]
  lethal run               --project <dir> --dry-run
  lethal clear-quarantine  --server <url> --instance <name>
  lethal clear-ceiling     --project <dir> --server <url> --instance <name> [--db <path>] [--file <name>]
  lethal force-reset-lease --server <url> --instance <name> --config <path> [--project <dir>]
  lethal doctor            --config <path> [--project <dir>]
  lethal explain           <report.json>

RUN — required
  --project <dir>            AL project to mutate (the app under test)
  --tests <dir>              AL test project (omit only with --dry-run)
  --backend <name>           bcdev (live BC, authoritative) or al-runner (offline, NOT authoritative)

RUN — scope. These bound cost. --tests-only can change a verdict; the others cannot.
  --only <glob>              only these files contribute mutants (repeatable). Every file is still
                             parsed, compiled and published — this selects mutants, not sources
  --tests-only <glob>        only these test files run at baseline (repeatable). CAN CHANGE A
                             VERDICT: exclude a killing test and its mutant is reported survived.
                             The report flags it 'tests-narrowed'
  --skip-known-survivors     skip mutants a prior finished run recorded as survivors
  --allow-large-run          run more than ${LARGE_RUN_MUTANT_THRESHOLD} mutation sites (refused by default — a whole
                             real app costs days and usually cannot publish at all)
  --dry-run                  list what would be mutated; execute nothing. Reports both the raw
                             mutation-site count and the DEPLOYED count (they differ), plus this
                             tier's measured publish bracket. It never creates a results database;
                             when one already exists AND the config names a bcdev tier to look the
                             bracket up for, that database is OPENED FOR WRITING and its schema
                             brought up to date, exactly as a real run would

RUN — cost and recovery
  --max-guards-per-batch <n> cap guards per published artifact. Publish cost scales with guard
                             count because BC recompiles server-side
  --mutant-timeout-ms <n>    floor for a mutant's time budget (default ${MIN_MUTANT_BUDGET_MS} ms). The budget is
                             max(2 x that test's baseline, this). Exceeding it quarantines the run
  --resume                   continue the most recent unfinished run in --db, reusing its verdicts
  --resume-run <id>          resume a specific run id
  --retry-stranded           on resume, retry mutants that stranded the tier (skipped by default:
                             a mutant that never terminates blocks every mutant behind it)
  --stop-hung-sessions       let LethAL END THE BC SESSION running a mutant that exceeds its
                             budget, so a never-terminating mutant scores timeout-killed instead
                             of quarantining the run. OFF by default: it stops a session on your
                             server. LethAL only targets a session its own run recorded, under
                             the lease fence, but that id cannot be independently verified
  --workers <n>              parallel workers (bcdev is limited to 1)
  --compile-concurrency <n>  concurrent alc processes
  --progress-out <path>      stream events to this file as NDJSON, one JSON object per line,
                             flushed as each event arrives — a crash diagnostic and a structured
                             feed for agents/CI. VERDICT LINES ARE PROVISIONAL UNTIL
                             'session-finished': a later 'batch-invalidated' event can supersede
                             a verdict this file already wrote

RUN — environment
  --config <path>            lethal.config.json (default: <project>/lethal.config.json)
  --db <path>                results database (default: <project>/lethal.sqlite)
  --out <path>               write the JSON report here
  --selector-id <n>          override the injected selector codeunit id
  --control-id <n>           override the injected control codeunit id
  --table-id <n>             override the injected control table id
  --keep-env                 do not delete an environment the env tool created
  --allow-expiring-env       proceed against an environment that expires during the run

CLEAR-CEILING — undo a publish-ceiling measurement (R90)
  A file at or above a guard count MEASURED to fail on a tier is refused before anything is
  compiled or published. That bracket is a ratchet: a refused file can never publish, so it can
  never widen the bracket back. Any throw out of the publish call records a failure, including a
  transient one (a spawn failure, a restarting server), so this is the way back.
  --project <dir>            project whose results database holds the measurement
  --server <url>             tier identity, same pair a run uses
  --instance <name>
  --file <name>              clear only rows recorded against this file. Omit to clear the whole
                             tier — the right choice when the TOPOLOGY changed (container
                             recycled, proxy reconfigured), and the only way to reach rows from a
                             multi-file artifact, which carry no filename at all
  --db <path>                results database (default: <project>/lethal.sqlite). A refusal
                             message pre-fills this with the database the measurement was
                             actually recorded in — copy it rather than retyping
  Every row removed is printed, with the bracket before and after: discarding a genuine failure
  is real evidence loss, and it cost a live publish failure to learn. A clear that removes NOTHING
  reports 'nothing-matched'/'nothing-recorded' and exits 1 — it did not undo anything, and the
  next run will be refused identically.

DOCTOR — every pre-flight refusal, read-only, all at once (R109)
  'lethal run' discovers a stopped environment, a stale control app, a quarantined tier, or a
  missing alc/altool ONE AT A TIME, each after whatever ran before it. 'lethal doctor' runs every
  one of those checks read-only and reports them all in a single pass, so a user with several
  problems finds all of them in one round-trip instead of one slow retry per fix.
  --config <path>            lethal.config.json (the bcdev/envTool sections every check reads)
  --project <dir>            optional; only used to satisfy {projectDir} placeholders an
                             envTool.resolve command might reference
  Does NOT check: the per-file publish ceiling (needs a generated mutation manifest), baseline
  test health (needs an actual run), or the machine-global lease/op-marker (no read-only peek
  exists on the control app today, R110) — all three are printed as an explicit caveat on every
  invocation, never silently implied as covered.
  Exits 0 when every check passes, 1 otherwise, naming each failing check.

EXPLAIN — what a finished report MEANS, as JSON on stdout
  'lethal explain report.json' projects a report a run wrote with --out. It reads that file and
  nothing else: no server, no database, no config. Every survivor arrives with the machine field
  that decides what it is worth — 'executionProven' is true ONLY for an exact, member-level
  coverage match, so a survivor with false means some test touched the object and NO test is
  measured to have executed the mutated procedure. Each caveat, error cause and tool condition
  arrives with the same interpretation the source constant carries, plus a 'basis' pointing at the
  evidence. Structure is versioned under 'explainSchemaVersion'; the PROSE is not contractual and
  may be reworded without a bump — every machine-usable value is already its own field, so there
  is nothing to parse out of a sentence. A report from another schema version, or carrying a
  caveat this build cannot interpret, is REFUSED rather than explained with the value dropped.

OTHER
  -h, --help                 this text
  -V, --version              print the version

EXIT CODES
  0 ok   1 error   ${QUARANTINED_EXIT_CODE} quarantined (the run refused to vouch for its own verdicts)

A score is only as good as its caveats: read \`validity\` in the JSON report before quoting
\`mutationScore\`. A survivor is a lead, not a proven test-suite gap.`;
}

/**
 * Parses a `--selector-id`/`--control-id`/`--table-id` flag value into a positive integer object
 * id, or `undefined` when the flag was not given at all. Mirrors `--workers`'s validation.
 */
function parseObjectIdFlag(value: string | undefined, flagName: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`--${flagName} must be a positive integer`);
  }
  return n;
}

/**
 * Pure argument parsing/validation — no file or network I/O. Kept separate
 * from `main()` so arg-validation errors (missing --project, unknown
 * --backend, ...) are directly unit-testable without spawning a process.
 */
/**
 * Every flag `run` accepts, in one place.
 *
 * Exported so the help-text test can DERIVE the flag list instead of restating it. That test is
 * named "documents every flag parseCliConfig accepts" and used to hold a hand-maintained array,
 * which had already drifted — `--retry-stranded` shipped documented in help but absent from the
 * list, so the very drift the test exists to prevent had happened inside the test itself.
 */
export const RUN_FLAGS = {
  project: { type: "string" },
  tests: { type: "string" },
  backend: { type: "string" },
  db: { type: "string" },
  out: { type: "string" },
  config: { type: "string" },
  "skip-known-survivors": { type: "boolean", default: false },
  "dry-run": { type: "boolean", default: false },
  workers: { type: "string" },
  "compile-concurrency": { type: "string" },
  server: { type: "string" },
  instance: { type: "string" },
  // R90 fix round 1: `clear-ceiling`'s optional per-file narrowing. Lives in the shared flag table
  // because `parseArgs` runs in strict mode over ONE option set for every subcommand.
  file: { type: "string" },
  "keep-env": { type: "boolean", default: false },
  "allow-expiring-env": { type: "boolean", default: false },
  "selector-id": { type: "string" },
  "control-id": { type: "string" },
  "table-id": { type: "string" },
  // R41: repeatable — several `--only` patterns union. See `RunCliConfig.only`.
  only: { type: "string", multiple: true },
  // R45: repeatable — see `RunCliConfig.testsOnly`.
  "tests-only": { type: "string", multiple: true },
  // R44: see `RunCliConfig.maxGuardsPerBatch`.
  "max-guards-per-batch": { type: "string" },
  // R47: see `RunCliConfig.mutantTimeoutMs` / `resume`.
  "mutant-timeout-ms": { type: "string" },
  resume: { type: "boolean", default: false },
  "resume-run": { type: "string" },
  // R53: see `RunCliConfig.retryStranded`.
  "retry-stranded": { type: "boolean", default: false },
  // R53: see `RunCliConfig.stopHungSessions`.
  "stop-hung-sessions": { type: "boolean", default: false },
  // R48: see `RunCliConfig.allowLargeRun`.
  "allow-large-run": { type: "boolean", default: false },
  // Task 6 (event-stream refactor): see `RunCliConfig.progressOutPath`.
  "progress-out": { type: "string" },
} as const;

export function parseCliConfig(argv: readonly string[]): CliConfig {
  // R49: intercepted BEFORE `parseArgs`, which runs in strict mode and would reject `--help` as an
  // unknown option — a `TypeError` with a stack trace into the bundled binary, for the one flag a
  // new user is most likely to type first. A bare invocation gets the same treatment: with nothing
  // to go on, usage is more useful than "unknown subcommand: got none".
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    return { mode: "help" };
  }
  if (argv.includes("--version") || argv.includes("-V")) {
    return { mode: "version" };
  }

  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { ...RUN_FLAGS },
  });

  const subcommand = requireKnownSubcommand(positionals);

  if (subcommand === "clear-quarantine") {
    const server = values.server;
    if (server === undefined || server === "") {
      throw new Error("missing required --server <url>");
    }
    const serverInstance = values.instance;
    if (serverInstance === undefined || serverInstance === "") {
      throw new Error("missing required --instance <name>");
    }
    return { mode: "clear-quarantine", server, serverInstance };
  }

  if (subcommand === "clear-ceiling") {
    const server = values.server;
    if (server === undefined || server === "") {
      throw new Error("missing required --server <url>");
    }
    const serverInstance = values.instance;
    if (serverInstance === undefined || serverInstance === "") {
      throw new Error("missing required --instance <name>");
    }
    const project = values.project;
    if (project === undefined || project === "") {
      throw new Error(
        "missing required --project <dir> (the publish ceiling lives in that project's results " +
          "database, not in the machine-global quarantine directory)",
      );
    }
    // Fix round 2: an EMPTY `--file` throws rather than silently widening the scope from one file
    // to the entire tier — `--file "$F"` with an unset shell variable would otherwise destroy every
    // measurement on the tier while the operator believed they had named one. Same treatment its
    // two neighbours above already get, for the same reason.
    const file = values.file;
    if (file === "") {
      throw new Error(
        "--file was given as an empty string. Omit --file entirely to clear the whole tier; an " +
          "empty value would silently widen the scope from one file to every measurement on it.",
      );
    }
    return {
      mode: "clear-ceiling",
      projectDir: project,
      dbPath: values.db ?? join(project, "lethal.sqlite"),
      server,
      serverInstance,
      ...(file !== undefined ? { file } : {}),
    };
  }

  if (subcommand === "force-reset-lease") {
    const server = values.server;
    if (server === undefined || server === "") {
      throw new Error("missing required --server <url>");
    }
    const serverInstance = values.instance;
    if (serverInstance === undefined || serverInstance === "") {
      throw new Error("missing required --instance <name>");
    }
    const configPath = values.config;
    if (configPath === undefined || configPath === "") {
      throw new Error(
        "missing required --config <path> (needed to read the bcdev company/username/password " +
          "credentials this recovery action authenticates the live OData calls with)",
      );
    }
    const project = values.project;
    return {
      mode: "force-reset-lease",
      server,
      serverInstance,
      configPath,
      ...(project !== undefined && project !== "" ? { projectDir: project } : {}),
    };
  }

  if (subcommand === "doctor") {
    const configPath = values.config;
    if (configPath === undefined || configPath === "") {
      throw new Error(
        "missing required --config <path> (the bcdev/envTool sections every check reads)",
      );
    }
    const project = values.project;
    return {
      mode: "doctor",
      configPath,
      ...(project !== undefined && project !== "" ? { projectDir: project } : {}),
    };
  }

  if (subcommand === "explain") {
    // POSITIONAL, so `positionals[1]`. An empty or missing one is refused here rather than reaching
    // `readFile("")` and surfacing as a bare ENOENT with no statement of what was expected.
    const [, reportPath] = positionals;
    if (reportPath === undefined || reportPath === "") {
      throw new Error(
        "missing required <report.json> (the finished report to explain, e.g. the file a run " +
          "wrote with --out). `lethal explain` reads only that file — no server, database or " +
          "config is involved.",
      );
    }
    return { mode: "explain", reportPath };
  }

  const projectDir = values.project;
  if (projectDir === undefined || projectDir === "") {
    throw new Error("missing required --project <dir>");
  }

  // R41: an empty `--only ""` is a caller mistake that would otherwise reach `admittedByOnly` as
  // a pattern matching nothing and be refused there with a less specific message. Reject at parse
  // time, like every other flag value this file validates.
  const onlyRaw = values.only;
  if (onlyRaw?.some((p) => p === "") === true) {
    throw new Error('--only requires a non-empty glob (e.g. --only "Al/Codeunit/**")');
  }
  const only = onlyRaw !== undefined && onlyRaw.length > 0 ? { only: onlyRaw } : {};

  const testsOnlyRaw = values["tests-only"];
  if (testsOnlyRaw?.some((p) => p === "") === true) {
    throw new Error(
      '--tests-only requires a non-empty glob (e.g. --tests-only "Src/Documents/**")',
    );
  }
  const testsOnly =
    testsOnlyRaw !== undefined && testsOnlyRaw.length > 0 ? { testsOnly: testsOnlyRaw } : {};

  const maxGuardsRaw = values["max-guards-per-batch"];
  const maxGuardsPerBatch = maxGuardsRaw === undefined ? undefined : Number(maxGuardsRaw);
  if (
    maxGuardsPerBatch !== undefined &&
    (!Number.isInteger(maxGuardsPerBatch) || maxGuardsPerBatch < 1)
  ) {
    throw new Error("--max-guards-per-batch must be a positive integer");
  }

  // R47: the per-mutant budget floor. Rejected at parse time like every other numeric flag here.
  const mutantTimeoutRaw = values["mutant-timeout-ms"];
  const mutantTimeoutMs = mutantTimeoutRaw === undefined ? undefined : Number(mutantTimeoutRaw);
  if (
    mutantTimeoutMs !== undefined &&
    (!Number.isInteger(mutantTimeoutMs) || mutantTimeoutMs < 1)
  ) {
    throw new Error("--mutant-timeout-ms must be a positive integer (milliseconds)");
  }

  // R47: `--resume` takes the most recent unfinished run; `--resume-run <id>` names one. Both at
  // once is a contradiction, not a precedence question — refuse rather than silently pick.
  const resumeLast = values.resume === true;
  const resumeRunRaw = values["resume-run"];
  if (resumeLast && resumeRunRaw !== undefined) {
    throw new Error("--resume and --resume-run <id> are mutually exclusive");
  }
  const resumeRunId = resumeRunRaw === undefined ? undefined : Number(resumeRunRaw);
  if (resumeRunId !== undefined && (!Number.isInteger(resumeRunId) || resumeRunId < 1)) {
    throw new Error("--resume-run must be a positive integer run id");
  }
  const resume: { resume?: "last" | number } = resumeLast
    ? { resume: "last" }
    : resumeRunId !== undefined
      ? { resume: resumeRunId }
      : {};

  if (values["dry-run"] === true) {
    // A dry run executes nothing, so there is no per-mutant budget to floor and no prior verdict
    // to reuse. Accepting either silently would imply it had done something — the same reasoning
    // `--tests-only` gets immediately below.
    if (mutantTimeoutMs !== undefined) {
      throw new Error(
        "--mutant-timeout-ms has no effect with --dry-run (a dry run executes no mutants)",
      );
    }
    if (resumeLast || resumeRunRaw !== undefined) {
      throw new Error("--resume has no effect with --dry-run (a dry run records no verdicts)");
    }
    // `--tests-only` narrows the BASELINE, and a dry run executes nothing at all — accepting it
    // silently would imply it had scoped something.
    if (testsOnlyRaw !== undefined && testsOnlyRaw.length > 0) {
      throw new Error("--tests-only has no effect with --dry-run (a dry run executes no tests)");
    }
    return {
      mode: "dry-run",
      projectDir,
      dbPath: values.db ?? join(projectDir, "lethal.sqlite"),
      configPath: values.config ?? join(projectDir, "lethal.config.json"),
      ...only,
    };
  }

  const testDir = values.tests;
  if (testDir === undefined || testDir === "") {
    throw new Error("missing required --tests <dir> (omit only together with --dry-run)");
  }

  const backendArg = values.backend;
  if (backendArg === undefined || backendArg === "") {
    throw new Error('missing required --backend <"bcdev" | "al-runner">');
  }
  if (backendArg !== "bcdev" && backendArg !== "al-runner") {
    throw new Error(`unknown --backend "${backendArg}" (expected "bcdev" or "al-runner")`);
  }

  const workers = values.workers === undefined ? 1 : Number(values.workers);
  if (!Number.isInteger(workers) || workers < 1)
    throw new Error("--workers must be a positive integer");
  const compileConcurrency =
    values["compile-concurrency"] === undefined ? undefined : Number(values["compile-concurrency"]);
  if (
    compileConcurrency !== undefined &&
    (!Number.isInteger(compileConcurrency) || compileConcurrency < 1)
  )
    throw new Error("--compile-concurrency must be a positive integer");

  // R3: `--selector-id`/`--control-id`/`--table-id` override the three injected object ids
  // (DEFAULT_SELECTOR_IDS) independently — see `resolveSelectorIds`'s doc comment for why three
  // explicit ids rather than one base+offsets. Parsed here (not left to `resolveSelectorIds`) so
  // a non-integer/non-positive value is rejected at argv-parse time, matching `--workers`/
  // `--compile-concurrency` immediately above.
  const selectorIdFlag = parseObjectIdFlag(values["selector-id"], "selector-id");
  const controlIdFlag = parseObjectIdFlag(values["control-id"], "control-id");
  const tableIdFlag = parseObjectIdFlag(values["table-id"], "table-id");
  const selectorIdOverrides: Partial<SelectorConfig> = {
    ...(selectorIdFlag !== undefined ? { selectorId: selectorIdFlag } : {}),
    ...(controlIdFlag !== undefined ? { controlId: controlIdFlag } : {}),
    ...(tableIdFlag !== undefined ? { tableId: tableIdFlag } : {}),
  };

  // bcdev mutant activation is a single server-side record shared by every worker — server +
  // serverInstance + company, one row (Layer 5C-A: RunMutant's SetActive+run+ClearActive touches
  // that same `LC Mutation Active` row). Per-worker ArtifactCompiler.outputDir isolates each
  // worker's COMPILED ARTIFACT, but not this: two workers issuing RunMutant concurrently would
  // both drive the SAME active row, so worker B's activation can clobber worker A's within A's
  // run+isolation window, silently attributing a result to the wrong mutant. RunMutant's identity
  // echo does not catch this — it validates its own tuple, not a concurrent overwrite by another
  // worker (only 5C-B's machine-global lease does). Every worker would also publish the same app
  // id to the same server instance. Real parallelism against the authoritative backend needs
  // per-container isolation (deferred to the container-pool layer) — reject rather than silently
  // corrupt results.
  if (backendArg === "bcdev" && workers > 1) {
    throw new Error(
      "--workers > 1 is not supported with --backend bcdev: mutant activation is a single " +
        "server-side record shared by all workers, so concurrent workers would overwrite each " +
        "other's active mutant. Parallel execution on a real BC server needs per-container " +
        "isolation (deferred to the container-pool layer).",
    );
  }

  // Task 7: the env-tool session (Task 6) lives entirely under the bcdev backend — al-runner has
  // no environment for either flag to act on. `--keep-env` is refused outright rather than
  // silently ignored: a caller who passes it expecting an environment to survive teardown, on a
  // backend with no environment at all, should hear about the mismatch, not see it do nothing.
  const keepEnv = values["keep-env"] === true;
  const allowExpiringEnv = values["allow-expiring-env"] === true;
  if (keepEnv && backendArg === "al-runner") {
    throw new Error(
      "--keep-env applies to the bcdev backend's environment tool; al-runner has no environment",
    );
  }
  // Minor 5 (Task 7 review): `--allow-expiring-env` got the silent-no-op treatment `--keep-env`
  // just above explicitly argues against — same backend-mismatch, same refusal, same reasoning.
  if (allowExpiringEnv && backendArg === "al-runner") {
    throw new Error(
      "--allow-expiring-env applies to the bcdev backend's environment tool; al-runner has no environment",
    );
  }

  return {
    mode: "run",
    projectDir,
    testDir,
    backendKind: backendArg,
    dbPath: values.db ?? join(projectDir, "lethal.sqlite"),
    configPath: values.config ?? join(projectDir, "lethal.config.json"),
    skipKnownSurvivors: values["skip-known-survivors"] ?? false,
    workers,
    keepEnv,
    allowExpiringEnv,
    ...(values.out !== undefined ? { outPath: values.out } : {}),
    ...(compileConcurrency !== undefined ? { compileConcurrency } : {}),
    ...(Object.keys(selectorIdOverrides).length > 0 ? { selectorIdOverrides } : {}),
    ...only,
    ...testsOnly,
    ...(maxGuardsPerBatch !== undefined ? { maxGuardsPerBatch } : {}),
    ...(mutantTimeoutMs !== undefined ? { mutantTimeoutMs } : {}),
    ...resume,
    ...(values["allow-large-run"] === true ? { allowLargeRun: true } : {}),
    ...(values["retry-stranded"] === true ? { retryStranded: true } : {}),
    ...(values["stop-hung-sessions"] === true ? { stopHungSessions: true } : {}),
    ...(values["progress-out"] !== undefined ? { progressOutPath: values["progress-out"] } : {}),
  };
}

export interface BcDevConfigSection {
  readonly mcpCommand: readonly string[];
  readonly server: string;
  readonly serverInstance: string;
  readonly tenant?: string;
  readonly company: string;
  readonly username: string;
  readonly password: string;
  readonly packageCachePath: string;
  /**
   * R43: absolute path to the `alc.exe` to compile the instrumented artifact with. Absent means
   * "the newest AL VS Code extension installed" (`defaultAlToolPaths`), the behaviour before this
   * existed.
   *
   * Needed because the compiler BUILD is not interchangeable. Measured 2026-07-27: an artifact
   * built by `alc 18.0.38.8509` is refused by a hosted BC 28 environment with
   * `Specified part does not exist in the package.`, while the same source built by `alc 17.x`
   * (the version matching the target's declared `runtime`) publishes cleanly. With no override, a
   * project whose server needs a specific compiler could not be run at all — the machine's newest
   * extension decided, and losing that lottery looked like a packaging bug in LethAL.
   */
  readonly alcPath?: string;
  /**
   * R64: absolute path to the `altool`/`altool.exe` to PUBLISH the instrumented artifact with.
   * Absent means "the newest AL VS Code extension installed" (`defaultAlToolPaths`), same fallback
   * as `alcPath`. Like `alcPath`, a value here also satisfies `buildBackend`'s "no AL extension
   * installed" gate for the half it names — see `resolveAlToolPaths`.
   *
   * Needed because, like the compiler, the publish TOOL build is not interchangeable: the VS Code
   * AL extension's bundled `altool` (17.0.2273547, measured 2026-07-31) has no working
   * non-interactive `UserPassword` auth path for `publishapp` (env vars are silently ignored, and
   * `auth login` is AAD-only per its own description), while the
   * `microsoft.dynamics.businesscentral.development.tools` 18.x prerelease dotnet tool (`al`
   * globally installed) reads `BC_SERVER_USERNAME`/`BC_SERVER_PASSWORD` and publishes cleanly.
   * With no override, `alcPath` alone cannot route publish through a different tool build than
   * compile.
   */
  readonly altoolPath?: string;
  // Absolute path to the compiled `lethal-control.app` — see BcDevConfig.controlSymbolPath
  // (bcdev-backend.ts) for why deploy()/compileCheck() need it (Task 8).
  readonly controlSymbolPath: string;
  // Extra env vars for the spawned bc-dev-mcp server process, e.g.
  // { "BC_DEV_USER": "...", "BC_DEV_PASSWORD": "..." } — see BcDevConfig.env.
  readonly env?: Record<string, string>;
  /**
   * OData root, used VERBATIM when present. `odataBaseUrl` injects port 7048, which is right for a
   * container and wrong for an environment tool's `https://host/{envId}`. Set only by
   * `env-tool-session`; a hand-written bcdev section leaves it absent and keeps the derivation.
   */
  readonly baseUrl?: string;
  /**
   * bc-dev-mcp connection port. Set only by `env-tool-session` (derived from `baseUrl` — see
   * `deriveMcpPort` there); a hand-written bcdev section leaves it absent, matching a container's
   * existing behaviour of letting bc-dev-mcp fall back to its own default.
   */
  readonly port?: number;
  /**
   * Coverage the backend claims for baseline routing/selection — forwarded verbatim to
   * `BcDevMcpBackend` as `coverageMode` (see `BcDevConfig.coverageMode`, bcdev-backend.ts, for the
   * full rationale: `"none"` is the env-tool fallback for when bc-dev-mcp cannot reach the
   * environment). Mirrors `port` immediately above exactly: absent (the default) leaves
   * `BcDevMcpBackend`'s own `"procedure"` default in effect. Task 7 review, Important 4: this
   * field did not exist before, so `coverageMode: "none"` could never actually be selected by any
   * `lethal run` — `BcDevConfig.coverageMode` existed but had no config surface reaching it.
   *
   * R58 adds `"fenced"`: per-procedure coverage collected on the SAME fenced session the mutants
   * run on, so the green set and the verdicts stop coming from two different session types.
   * **The default since the R58 rollout (spec step 5)** — see `BcDevConfig.coverageMode` for the
   * measurement behind it. `"procedure"` (legacy hub) remains selectable for one release.
   */
  readonly coverageMode?: "procedure" | "none" | "fenced";
}

export interface AlRunnerConfigSection {
  readonly alRunnerPath: string;
  readonly packagesDir?: string;
  readonly stubsDir?: string;
  // Opt-in server-mode transport (Task 4): keeps one al-runner process warm
  // instead of spawning one per test. Off by default.
  readonly serverMode?: boolean;
}

export interface LethalConfigFile {
  readonly bcdev?: Partial<BcDevConfigSection>;
  readonly alRunner?: Partial<AlRunnerConfigSection>;
  // Task 7: an environment tool (Task 6) resolves/provisions the bcdev section instead of it
  // being hand-written — see `resolveEnvToolSession` below.
  readonly envTool?: Partial<EnvToolConfigSection>;
  /**
   * R3: config-file override for the three injected object ids, one precedence step below
   * `--selector-id`/`--control-id`/`--table-id` and one above `DEFAULT_SELECTOR_IDS` — see
   * `resolveSelectorIds`. Lets a project pin non-default ids (e.g. because its `idRanges` exclude
   * 79197-79199, or because it shares a container with another instrumented project) without
   * having to pass flags on every invocation.
   */
  readonly selectorIds?: Partial<SelectorConfig>;
}

/** Pure validators — no I/O — so "missing config field" errors are unit-testable directly. */
export function validateBcDevConfig(
  raw: Partial<BcDevConfigSection> | undefined,
): BcDevConfigSection {
  if (!raw) {
    throw new Error(
      'lethal.config.json is missing the "bcdev" section (required for --backend bcdev)',
    );
  }
  const missing: string[] = [];
  if (!Array.isArray(raw.mcpCommand) || raw.mcpCommand.length === 0) missing.push("mcpCommand");
  if (!raw.server) missing.push("server");
  if (!raw.serverInstance) missing.push("serverInstance");
  if (!raw.company) missing.push("company");
  if (!raw.username) missing.push("username");
  if (!raw.password) missing.push("password");
  if (!raw.packageCachePath) missing.push("packageCachePath");
  if (!raw.controlSymbolPath) missing.push("controlSymbolPath");
  if (missing.length > 0) {
    throw new Error(
      `lethal.config.json "bcdev" section is missing required field(s): ${missing.join(", ")}`,
    );
  }
  return raw as BcDevConfigSection;
}

export function validateAlRunnerConfig(
  raw: Partial<AlRunnerConfigSection> | undefined,
): AlRunnerConfigSection {
  if (!raw) {
    throw new Error(
      'lethal.config.json is missing the "alRunner" section (required for --backend al-runner)',
    );
  }
  if (!raw.alRunnerPath) {
    throw new Error(
      'lethal.config.json "alRunner" section is missing required field(s): alRunnerPath',
    );
  }
  return raw as AlRunnerConfigSection;
}

async function loadLethalConfigFile(path: string): Promise<LethalConfigFile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(
      `cannot read config file at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    return JSON.parse(text) as LethalConfigFile;
  } catch (err) {
    throw new Error(
      `config file at ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * bc-dev's OData base URL isn't a separate config field — it's server + serverInstance, with
 * port 7048 injected. Verified against a real BC server (2026-07-18): `server` (e.g.
 * "http://Cronus28", used unqualified by bc-dev-mcp's own dev-service protocol) has no port,
 * which resolves to 80 for a plain HTTP request — but BC's OData/web-service endpoint listens
 * on 7048, not 80 (confirmed: port 80 returns 404, port 7048 serves OData correctly). Mirrors
 * bc-mcp's `deriveODataUrl` (a separately verified, already-working reference for this exact
 * container), which unconditionally forces port 7048 unless it's already exactly that.
 */
export function odataBaseUrl(server: string, serverInstance: string): string {
  const url = new URL(server);
  if (url.port !== "7048") url.port = "7048";
  return `${url.toString().replace(/\/+$/, "")}/${serverInstance}`;
}

/**
 * R51: the OData base URL a RECOVERY command (`force-reset-lease`) should call, given the tier the
 * operator named and whatever the config declares.
 *
 * `odataBaseUrl` injects port 7048, which is right for a container and wrong for an environment
 * behind a path-routed HTTPS proxy — the env-tool case, where the endpoint is
 * `https://host/{envId}` on 443. `runFromCli` has always honoured an explicit `bcdev.baseUrl` for
 * exactly this reason; `force-reset-lease` did not, so it could not reach a hosted environment at
 * all. Measured 2026-07-27: `HarnessInfo unreachable: Unable to connect`, on the one recovery path
 * a proxy-severed run actually needs.
 *
 * The operator's `--server`/`--instance` stay AUTHORITATIVE for which tier is reset — this command
 * clears safety state, and resetting the wrong tier is the worst outcome available. So a configured
 * `baseUrl` is honoured only when it is consistent with the named instance, and a mismatch is
 * REFUSED naming both rather than resolved by a precedence rule nobody would remember under
 * pressure. A config with no `baseUrl` keeps the container behaviour untouched.
 */
export function recoveryBaseUrl(
  server: string,
  serverInstance: string,
  configuredBaseUrl: string | undefined,
): string {
  if (configuredBaseUrl === undefined || configuredBaseUrl === "") {
    return odataBaseUrl(server, serverInstance);
  }
  // A PATH SEGMENT, not a substring. `includes` looked equivalent and is not: an instance named
  // "a" is a substring of almost any hostname ("example.com"), so a mismatched tier would sail
  // through the check that exists to catch it. Caught by the test below, not by reading this.
  let segments: readonly string[];
  try {
    segments = new URL(configuredBaseUrl).pathname.split("/").filter((s) => s !== "");
  } catch {
    throw new Error(
      `force-reset-lease: configured bcdev.baseUrl "${configuredBaseUrl}" is not a valid URL`,
    );
  }
  if (!segments.includes(serverInstance)) {
    throw new Error(
      `force-reset-lease: --instance "${serverInstance}" does not appear in the configured bcdev.baseUrl "${configuredBaseUrl}", so the two name different tiers. This command clears safety state (op marker, active-mutant row, every outstanding lease credential) and will not guess which one you meant — point --server/--instance at the tier the config describes, or remove bcdev.baseUrl to address a container by server+instance on port 7048.`,
    );
  }
  return configuredBaseUrl.replace(/\/+$/, "");
}

/**
 * The OData config every bcdev control-surface client built FROM THE LOADED CONFIG FILE is
 * shaped from: `DeploymentVerifier`/`HarnessVerifier` (`buildBackend`) and the lease client's own
 * `HarnessVerifier` (`leaseSessionFor`) both used to build this object inline, independently
 * (t7, 5C-B2 review) — a real session then made two separate `HarnessInfo` round trips built from
 * what were SUPPOSED to be identical fields, with no compiler check that they stayed that way: a
 * field added to one construction and not the other would silently target the two clients at
 * differently-configured endpoints. One helper, one source of truth.
 *
 * Deliberately NOT reused by `forceResetLeaseFromCli`'s own construction below: that one sources
 * `baseUrl` from the operator's `--server`/`--instance` flags, not `c.server`/`c.serverInstance`
 * — a real divergence (see that function's doc comment), not the accidental duplication this
 * fixes.
 */
export function odataCfgFor(c: BcDevConfigSection): ActivationConfig {
  return {
    baseUrl: c.baseUrl ?? odataBaseUrl(c.server, c.serverInstance),
    company: c.company,
    username: c.username,
    password: c.password,
    ...(c.tenant !== undefined ? { tenant: c.tenant } : {}),
  };
}

/**
 * Builds one backend instance targeting `scratchDir` for all of its own scratch
 * output. Called once for the session's main backend (baseline/coverage), and —
 * when `--workers > 1` — once more per worker with a distinct `scratchDir`
 * (`cli.ts`'s `runFromCli`), so that:
 *   - each al-runner worker gets its own `instrumentedDir` — `AlRunnerBackend`
 *     copies each batch's compiled source into a private subdirectory of it on
 *     every `deploy()` call (see the comment there), so a distinct
 *     `instrumentedDir` per worker is what makes those copies land in
 *     genuinely separate directories instead of racing on the same one, and
 *   - each bcdev worker gets its own `ArtifactCompiler.outputDir`. Since Layer
 *     5A the compiled .app is content-addressed per artifact id (never a fixed
 *     filename), so collisions are already structurally impossible — a private
 *     outputDir per worker additionally keeps each worker's scratch/final
 *     artifacts physically separate and independently disposable.
 */
/**
 * Static fallback for the al-runner non-authoritative warning, used ONLY when `runFromCli`
 * cannot yet run the real canary (`al-runner-canary.ts`) because `lethal.config.json` has no
 * `alRunnerPath` configured — `validateAlRunnerConfig` throws its own targeted error for that
 * moments later in `buildBackend`, so this is printed on the way to that throw, not instead of
 * it. Every session that DOES have a configured path gets `alRunnerCanaryWarnings`'s dynamic,
 * measured-on-this-binary text instead (R7/R8 — see that module's doc comment for why a canary
 * that re-proves the defect every session beats a warning frozen at 2026-07-25).
 *
 * Called ONCE per session from `runFromCli`, not from `buildBackend`: backends are constructed
 * once for the session plus once per worker, so warning at construction printed the same
 * paragraph five times under `--workers 4` and trained the reader to scroll past it.
 */
function warnAlRunnerNotAuthoritative(): void {
  console.warn(
    "[lethal] al-runner is NOT authoritative: it reports `pass` for an `asserterror` that " +
      "raised no error, so any mutant killable only by an asserterror assertion is reported " +
      "as SURVIVED. Treat survivors from this backend as unconfirmed — re-run them under " +
      "--backend bcdev before acting on them.",
  );
}

/**
 * Builds one `EnvToolPublisher` for a resolved bcdev connection. The ONLY place that derives
 * `serializerKey` for this project — called both by `resolveEnvToolSession` (for the control app
 * and `publishApps` entries) and by `buildBackend` (for each batch's compiled artifact), always
 * from the SAME resolved `BcDevConfigSection` and the SAME `EnvToolClient` instance. Two
 * independently-derived keys for one environment would silently defeat
 * `serializePublish`'s per-environment serialization (Task 4's carried-forward warning); reusing
 * one function — and, just as importantly, one `client` — closes that off structurally rather
 * than by convention. Reusing the client also matters for credential redaction: only the client
 * that actually resolved username/password (via `EnvToolClient.run`'s `reads` handling) has them
 * in its `secrets` list, so a second, freshly-constructed client used for the batch-artifact
 * publisher would fail to redact them from a publish failure's error text.
 *
 * `envId` is taken as an explicit parameter — NEVER derived from `bcdev.serverInstance` here.
 * That only happens to hold when `serverInstance` was itself derived from `baseUrl`'s first path
 * segment AND that segment happens to equal the envId (`splitBaseUrl`, env-tool-session.ts); it
 * does not hold for an explicit `reads: { serverInstance: ... }` override, or a portal whose URL
 * is `https://host/tenants/env-4711` (`serverInstance === "tenants"`, not the envId at all). The
 * real, resolved envId lives on `EnvToolSession.envId` — callers thread it through from there.
 */
export function makeEnvToolPublisher(
  client: EnvToolClient,
  publishBlock: EnvToolBlock,
  envId: string,
  bcdev: BcDevConfigSection,
): EnvToolPublisher {
  return new EnvToolPublisher(
    client,
    publishBlock,
    { envId, serializerKey: canonicalContainerKey(bcdev) },
    { readArtifact: async (p) => new Uint8Array(await readFile(p)) },
  );
}

/**
 * Resolves which `alc` and `altool` a bcdev session will actually spawn: an explicit
 * `bcdev.alcPath`/`bcdev.altoolPath` wins over whatever `defaultAlToolPaths()` discovered, and
 * either half can be absent.
 *
 * The two overrides exist for the same reason and are independent on purpose — a tool BUILD is not
 * interchangeable, and compile and publish can need different ones. `alcPath` came first (R43:
 * `alc 18` writes OPC part names BC 28 cannot load). `altoolPath` followed (R64): the AL VS Code
 * extension's bundled `altool` 17.0.2273547 has no working non-interactive `UserPassword` auth for
 * `publishapp` — `BC_SERVER_USERNAME`/`BC_SERVER_PASSWORD` are ignored and `auth login` is
 * AAD-only — while the `microsoft.dynamics.businesscentral.development.tools` 18.x dotnet tool
 * reads those env vars and publishes.
 *
 * Its own exported function, and the one `buildBackend` calls, for the reason `deployerFor` below
 * spells out: a test that re-implements this precedence would stay green even if `buildBackend`
 * stopped honouring the override, which is precisely the regression worth pinning.
 */
export function resolveAlToolPaths(
  c: Pick<BcDevConfigSection, "alcPath" | "altoolPath">,
  discovered: { readonly alcPath: string; readonly altoolPath: string } | undefined,
): { readonly alcPath: string | undefined; readonly altoolPath: string | undefined } {
  return {
    alcPath: c.alcPath ?? discovered?.alcPath,
    altoolPath: c.altoolPath ?? discovered?.altoolPath,
  };
}

/**
 * Selects the deployer `buildBackend` uses for the bcdev batch-artifact publisher: through the
 * env-tool publisher when a session resolved one (`envToolDeploy` defined), else the ordinary
 * container/altool deployer. Extracted out of `buildBackend` (Task 7 review, Minor 7) rather than
 * left inlined there, so a test can invoke the EXACT function `buildBackend` calls when proving the
 * env-tool publisher and the `publishApps`/control-app publisher share one `serializerKey` (Task
 * 4's carried-forward requirement) — a hand-rolled reconstruction of `buildBackend`'s own ternary
 * would stay green even if `buildBackend` itself diverged, which is precisely the regression that
 * guarantee exists to catch.
 */
export function deployerFor(
  c: BcDevConfigSection,
  altoolPath: string,
  envToolDeploy?: {
    readonly client: EnvToolClient;
    readonly publishBlock: EnvToolBlock;
    readonly envId: string;
  },
): AppPublisher {
  return envToolDeploy !== undefined
    ? makeEnvToolPublisher(envToolDeploy.client, envToolDeploy.publishBlock, envToolDeploy.envId, c)
    : new ContainerDeployer(
        {
          altoolPath,
          server: c.server,
          serverInstance: c.serverInstance,
          username: c.username,
          password: c.password,
          ...(c.tenant !== undefined ? { tenant: c.tenant } : {}),
        },
        defaultDeployerIo,
      );
}

/**
 * Shapes the `BcDevConfig` object `buildBackend` passes to `BcDevMcpBackend`'s constructor — pure,
 * no I/O, so the forwarding of every optional field (`tenant`, `env`, `port`, `coverageMode`) is
 * directly unit-testable without a real `alc.exe`/`altool.exe` install. Extracted (Task 7 review,
 * Important 4) specifically so `coverageMode`'s forwarding — mirroring `port`'s existing
 * pass-through exactly — has a seam a test can call directly.
 */
export function bcDevBackendConfig(
  c: BcDevConfigSection,
  projectDir: string,
  /** R53: the opt-in `--stop-hung-sessions`. Threaded here rather than read off the config file —
   *  it is a run-time choice about acting on the user's server, not a property of the target. */
  stopHungSessions?: boolean,
): BcDevConfig {
  return {
    mcpCommand: c.mcpCommand,
    project: projectDir,
    server: c.server,
    serverInstance: c.serverInstance,
    company: c.company,
    packageCachePath: c.packageCachePath,
    controlSymbolPath: c.controlSymbolPath,
    ...(c.tenant !== undefined ? { tenant: c.tenant } : {}),
    ...(c.env !== undefined ? { env: c.env } : {}),
    ...(c.port !== undefined ? { port: c.port } : {}),
    ...(c.coverageMode !== undefined ? { coverageMode: c.coverageMode } : {}),
    ...(stopHungSessions === true ? { stopHungSessions: true } : {}),
  };
}

/**
 * Runs Task 6's `startEnvToolSession` lifecycle EXACTLY ONCE for a `run` invocation and returns a
 * `LethalConfigFile` with `bcdev` substituted by the resolved section — the object `buildBackend`,
 * `leaseSessionFor`, and `resourceIdentityFor` all read `configFile.bcdev` from (each calls
 * `validateBcDevConfig` independently; that is fine, since it is pure and does not provision
 * anything — what must never happen more than once is THIS function's call to `startSession`,
 * which spawns the configured tool and, in create-mode, provisions a real environment). A naive
 * port that resolved at each of those three seams instead of once here would provision THREE
 * environments for one `lethal run`.
 *
 * Also returns `deploy` — the same `client` and `publishBlock` `startEnvToolSession`'s own
 * publisher was built from — so `buildBackend` can build its batch-artifact publisher through
 * `makeEnvToolPublisher` without re-deriving either (see that function's doc comment for why
 * reusing the client, not just the key-derivation function, matters).
 *
 * al-runner and a bcdev config with no `envTool` section are a no-op: the config file comes back
 * unchanged, `envSession` is absent, and there is nothing for `runFromCli`'s `finally` to tear
 * down. `startEnvToolSession` itself trusts that `validateEnvToolConfig` already ran — this
 * function is the only caller in `cli.ts`, and it always validates immediately before starting,
 * so that ordering holds on every path that reaches it.
 */
export async function resolveEnvToolSession(
  parsed: RunCliConfig,
  configFile: LethalConfigFile,
  runId: string,
  deps: {
    makeClient?: (cfg: EnvToolConfigSection) => EnvToolClient;
    startSession?: typeof startEnvToolSession;
    // Real default is a live `HarnessVerifier` fetch — injectable so this function (and the
    // create-mode/resolve-mode paths through it) is unit-testable without a real BC endpoint.
    verifyHarness?: (cfg: ActivationConfig) => Promise<void>;
  } = {},
): Promise<{
  readonly effectiveConfig: LethalConfigFile;
  readonly envSession?: EnvToolSession;
  readonly deploy?: {
    readonly client: EnvToolClient;
    readonly publishBlock: EnvToolBlock;
    readonly envId: string;
  };
}> {
  if (parsed.backendKind !== "bcdev" || configFile.envTool === undefined) {
    return { effectiveConfig: configFile };
  }
  // Item 6 (final review): a field env-tool resolves via some block's `reads` must not ALSO be
  // hand-written in the `bcdev` section — fixtures/README.md's worked example calls this "two
  // sources, one value". `validateEnvToolConfig` (env-tool.ts) has no `BcDevConfigSection` type of
  // its own to check that against, so the overlap is computed here, from the SAME raw bcdev
  // section `startEnvToolSession` below reads, and handed in as plain key names.
  const bcdevRaw = configFile.bcdev ?? {};
  const bcdevDeclaredKeys = (READS_KEYS as readonly string[]).filter((key) => {
    const v = (bcdevRaw as Record<string, unknown>)[key];
    return typeof v === "string" && v !== "";
  });
  const envCfg = validateEnvToolConfig(configFile.envTool, {
    env: process.env,
    hasPackageCachePath: Boolean(configFile.bcdev?.packageCachePath),
    bcdevDeclaredKeys,
  });
  const makeClient =
    deps.makeClient ??
    ((cfg: EnvToolConfigSection) => new EnvToolClient(cfg, undefined, parsed.projectDir));
  const client = makeClient(envCfg);
  const publishBlock = envCfg.publish;
  // Unreachable once `validateEnvToolConfig` has succeeded (it requires `publish` itself) — this
  // narrows the type for the closures below rather than defending against a real gap.
  if (publishBlock === undefined) throw new EnvToolError("envTool.publish is required");
  const start = deps.startSession ?? startEnvToolSession;
  const verifyHarness =
    deps.verifyHarness ??
    (async (cfg: ActivationConfig) => {
      await new HarnessVerifier(cfg).verify();
    });
  const envSession = await start({
    cfg: envCfg,
    bcdevRaw,
    projectDir: parsed.projectDir,
    testDir: parsed.testDir,
    runId,
    client,
    // Item 2 (final review): thread the ACTUAL resolved envId through — never `bcdev.serverInstance`
    // (see `makeEnvToolPublisher`'s doc comment for why that only sometimes coincides with it).
    makePublisher: (bcdev, envId) => makeEnvToolPublisher(client, publishBlock, envId, bcdev),
    verifyHarness,
    allowExpiring: parsed.allowExpiringEnv,
  });
  return {
    effectiveConfig: { ...configFile, bcdev: envSession.bcdev },
    envSession,
    deploy: { client, publishBlock, envId: envSession.envId },
  };
}

export async function buildBackend(
  parsed: RunCliConfig,
  configFile: LethalConfigFile,
  scratchDir: string,
  envToolDeploy?: {
    readonly client: EnvToolClient;
    readonly publishBlock: EnvToolBlock;
    readonly envId: string;
  },
  // R21: injectable so a unit test can drive the "AL extension not found" branch below without a
  // real install — the real default (`defaultAlToolPaths`) reads `~/.vscode/extensions`, which a
  // test cannot control.
  deps: { alToolPaths?: typeof defaultAlToolPaths } = {},
  // R3: the resolved selector/control/table ids (`resolveSelectorIds`) — trailing, defaulted
  // param so every pre-existing positional call site (tests included) keeps behaving exactly as
  // before without having to name it. `runFromCli` is the one real caller that threads a
  // non-default value through.
  selectorIds: SelectorConfig = DEFAULT_SELECTOR_IDS,
): Promise<ExecutionBackend> {
  if (parsed.backendKind === "al-runner") {
    // R3/R4: validated here, first, before constructing anything — al-runner's own `alc` run is
    // lazy (`AlRunnerBackend.activate()`, see `selector.ts`'s doc comment), so this is the
    // earliest point that can catch a bad id for this backend too.
    await validateSelectorIdsForProject(parsed.projectDir, selectorIds);
    const c = validateAlRunnerConfig(configFile.alRunner);
    return new AlRunnerBackend({
      alRunnerPath: c.alRunnerPath,
      instrumentedDir: join(scratchDir, "al-runner-active"),
      testDir: parsed.testDir,
      ...(c.packagesDir !== undefined ? { packagesDir: c.packagesDir } : {}),
      ...(c.stubsDir !== undefined ? { stubsDir: c.stubsDir } : {}),
      selectorObjectId: selectorIds.selectorId,
      ...(c.serverMode !== undefined ? { serverMode: c.serverMode } : {}),
    });
  }

  const c = validateBcDevConfig(configFile.bcdev);

  // Important 3 (Task 7 review): a worker backend that silently drops `envToolDeploy` would build
  // a `ContainerDeployer` and publish via altool to an env-tool-provisioned HTTPS environment —
  // exactly the plausible-silent-default this project forbids. Every caller building a bcdev
  // backend for a config with an `envTool` section MUST thread `deploy` through; a call site that
  // forgets throws here, loudly, rather than silently falling back to altool. Checked BEFORE any
  // I/O (`defaultAlToolPaths`, `mkdir`) so this is reachable without a real alc/altool install.
  if (configFile.envTool !== undefined && envToolDeploy === undefined) {
    throw new Error(
      "buildBackend: bcdev config has an `envTool` section configured but no env-tool deploy was " +
        "supplied — refusing to fall back to ContainerDeployer/altool, which would silently " +
        "publish outside the configured environment tool",
    );
  }

  const alToolPaths = deps.alToolPaths ?? defaultAlToolPaths;
  const toolPaths = await alToolPaths();
  const resolved = resolveAlToolPaths(c, toolPaths);
  // R43/R64: a configured `alcPath`/`altoolPath` SATISFIES the requirement below — the gate exists
  // to catch "no AL compiler/publisher anywhere", and an explicit path is one. Which of the two a
  // session actually needs depends on the publish route, so the gate asks for exactly those:
  // compilation is always local, so alc is required everywhere; altool is spawned only by
  // `ContainerDeployer` (the non-envTool branch of `deployerFor`).
  if (resolved.alcPath === undefined) {
    // R21: the env-tool publish path (`envToolDeploy` defined, `deployerFor` below takes the
    // env-tool branch) never constructs a `ContainerDeployer` and so never touches
    // `toolPaths.altoolPath` — altool.exe is irrelevant there. `alc.exe` is still genuinely
    // required on EVERY path: compilation is always local, env-tool or not. Naming altool.exe as
    // a requirement on a path that never uses it is a confusing gate for an install that only
    // has the AL compiler and not the (server-publish-only) altool binary.
    if (envToolDeploy !== undefined) {
      throw new Error(
        "could not locate alc.exe under the AL Language VS Code extension install " +
          "(~/.vscode/extensions/ms-dynamics-smb.al-*); alc.exe is required because compilation " +
          "is always local, even when publishing through envTool — install the AL extension, or " +
          "set bcdev.alcPath",
      );
    }
    throw new Error(
      "could not locate alc.exe/altool.exe under the AL Language VS Code extension install " +
        "(~/.vscode/extensions/ms-dynamics-smb.al-*); install the extension, set bcdev.alcPath " +
        "and bcdev.altoolPath, or run with --backend al-runner",
    );
  }
  // R64: the container publish path spawns altool, so a pinned `alcPath` alone must NOT wave it
  // through to fail later at publish time — but a pinned `altoolPath` genuinely satisfies it, the
  // same way `alcPath` satisfies the compiler half. Before that override existed this branch was
  // unreachable (no extension meant no alc either), which is why the message is separate: "install
  // the extension" is unhelpful advice for someone who did pin a compiler and nothing else.
  if (envToolDeploy === undefined && resolved.altoolPath === undefined) {
    throw new Error(
      "could not locate altool.exe under the AL Language VS Code extension install " +
        "(~/.vscode/extensions/ms-dynamics-smb.al-*); publishing to a container spawns altool — " +
        "install the extension, set bcdev.altoolPath, or run with --backend al-runner",
    );
  }
  // R3/R4: validated here — after alc/altool are confirmed present (so the "could not locate..."
  // guard above still fires first when BOTH conditions are wrong, matching this function's prior
  // error-priority for an incomplete install) but before any compiler/deployer object touches the
  // target project, and well before an actual `alc` invocation would burn a live BC round trip on
  // an AL0297.
  await validateSelectorIdsForProject(parsed.projectDir, selectorIds);
  const outputDir = join(scratchDir, "publish");
  await mkdir(outputDir, { recursive: true });
  const compiler = new ArtifactCompiler(
    {
      alcPath: resolved.alcPath,
      packageCachePath: c.packageCachePath,
      outputDir,
    },
    defaultArtifactIo,
  );
  // Task 7: when this session's `envTool` section resolved the connection, publish batch
  // artifacts through it too — `ContainerDeployer`/altool has no notion of the configured tool's
  // environment at all. `envToolDeploy` is threaded down from `resolveEnvToolSession` rather than
  // re-derived from `configFile.envTool` here so there is exactly one `EnvToolClient` instance and
  // one `canonicalContainerKey` derivation shared with the control-app/`publishApps` publisher —
  // see `makeEnvToolPublisher`'s doc comment. `deployerFor` (Minor 7) is the same function a test
  // exercises directly to prove both publisher constructions share one `serializerKey`.
  // `altoolPath` is only ever READ on the non-envTool branch (`deployerFor` builds a
  // `ContainerDeployer` there); the second guard above refuses that path outright unless an altool
  // resolved, so an empty string here is unreachable rather than a silent default.
  const deployer: AppPublisher = deployerFor(c, resolved.altoolPath ?? "", envToolDeploy);
  // One OData config, several consumers on the same LethAL Control / MutationControl web-service
  // endpoints: the RunMutant execution transport, the HarnessInfo prerequisite check, and the
  // (Layer-5A) deployment identity verifier.
  const odataCfg = odataCfgFor(c);
  const verifier = new DeploymentVerifier(odataCfg);
  const harnessVerifier = new HarnessVerifier(odataCfg);
  return new BcDevMcpBackend(
    bcDevBackendConfig(c, parsed.projectDir, parsed.stopHungSessions),
    undefined,
    { compiler, deployer, verifier, harnessVerifier },
    (targetAppId, artifactId) => new RunMutantTransport(odataCfg, targetAppId, artifactId),
  );
}

/**
 * Maps the loaded config file's `bcdev` section to the `SessionConfig` identity fields
 * `runSession` needs for the quarantine consult (spec §9/§11) — `resourceServer`/
 * `resourceServerInstance`, sourced from the SAME `server`/`serverInstance` values
 * `canonicalContainerKey` (publish-serializer.ts) and `quarantineResourceKey` (resource-key.ts)
 * already key off. Only a bcdev session has a shared server-side tier to strand — al-runner
 * omits both fields, which `runSession` treats as "no shared tier to consult", not an error.
 *
 * Kept as its own small, directly unit-testable, pure seam (rather than inlined in `runFromCli`)
 * because this exact gap — `cli.ts` never sourcing these fields, so the quarantine consult wired
 * in `runSession` was silently inert for every real CLI-driven bcdev session — was flagged by
 * Task 11's review and folded into Task 13. A test on this one function pins the fix down without
 * needing to unit-test `main()`/`runFromCli` end to end.
 */
/**
 * Layer 5C-B1 (design §6): the lease wiring for a bcdev session — `SessionConfig.lease`, or `{}`
 * for al-runner (a `deploy: "none"` backend publishes nothing to a shared container, so there is
 * nothing for a machine-global lease to fence).
 *
 * `serverGeneration` is wired to a REAL `HarnessVerifier.verify()` rather than a bare
 * HarnessInfo read: the verifier is also design §7's pre-publish gate (protocol v2 required,
 * multi-tenant container refused), and calling it here runs that gate before this session can
 * acquire — let alone publish. Sourced from the same `odataCfg` as every other control-surface
 * client, so the lease is taken against the exact container the mutants will run on.
 *
 * Kept as its own small seam (like `resourceIdentityFor` above, and for the same reason) so a
 * regression that leaves a real CLI-driven bcdev session unfenced is directly testable.
 */
/**
 * R19: the post-lease work `runSession` must do, as a `SessionConfig` fragment.
 *
 * Publishing the target's TEST apps moved out of provisioning and under the lease. Pre-lease, a
 * concurrent LethAL session can republish one mid-run, and nothing detects it — the attestation
 * fence covers the TARGET artifact, not the test app, so the swap is invisible to every verdict
 * the run produces.
 *
 * A seam rather than an inline spread, for the same reason `leaseSessionFor` is one: the wiring is
 * the part that can silently vanish. If this fragment stops being produced, the test apps are
 * never published at all — which is the R31/R56 staleness class (a gate measuring a previously
 * published build), observed twice and badly disguised both times. Inline, nothing could test it.
 *
 * Empty when there is no env-tool session: on that path nobody asked LethAL to publish test apps.
 */
export function afterLeaseAcquiredFor(envSession: EnvToolSession | undefined): {
  afterLeaseAcquired?: () => Promise<void>;
} {
  if (envSession === undefined) return {};
  return { afterLeaseAcquired: () => envSession.publishTestApps() };
}

export function leaseSessionFor(
  parsed: RunCliConfig,
  configFile: LethalConfigFile,
): Pick<SessionConfig, "lease"> {
  if (parsed.backendKind !== "bcdev") return {};
  const c = validateBcDevConfig(configFile.bcdev);
  const odataCfg = odataCfgFor(c);
  const harnessVerifier = new HarnessVerifier(odataCfg);
  return {
    lease: {
      client: new LeaseClient(odataCfg),
      serverGeneration: async () => (await harnessVerifier.verify()).serverGeneration,
    },
  };
}

/**
 * R26: wires the once-per-session permission canary for an authoritative (bcdev) session.
 *
 * bcdev-only, and not by convention — the Permissions Mock is a property of the FENCED
 * `RunMutant` -> `Test Suite Mgt.RunAllTests` path, which only the bcdev backend has. al-runner
 * has no such path (and no `LethAL Control` app to ask), so there is genuinely nothing to measure
 * there; returning `{}` leaves `SessionReport.permissionCanary` absent rather than reporting an
 * inconclusive verdict for a question that does not apply.
 *
 * Built through the SAME `odataCfgFor(c)` helper as the lease client and both harness verifiers,
 * so this cannot end up pointed at a differently-configured endpoint than the calls whose
 * behaviour it is characterising — see that helper's doc comment for the bug that motivated it.
 */
export function permissionCanaryFor(
  parsed: RunCliConfig,
  configFile: LethalConfigFile,
): Pick<SessionConfig, "permissionCanary"> {
  if (parsed.backendKind !== "bcdev") return {};
  const client = new PermissionCanaryClient(odataCfgFor(validateBcDevConfig(configFile.bcdev)));
  return { permissionCanary: () => runPermissionCanary(client) };
}

export function resourceIdentityFor(
  parsed: RunCliConfig,
  configFile: LethalConfigFile,
): Pick<SessionConfig, "resourceServer" | "resourceServerInstance"> {
  if (parsed.backendKind !== "bcdev") return {};
  const c = validateBcDevConfig(configFile.bcdev);
  return { resourceServer: c.server, resourceServerInstance: c.serverInstance };
}

function lineOfIndex(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

function sitesOf(files: readonly InstrumentedFile[]) {
  return files.flatMap((f) => {
    // R92: `dedupeSpecs` returns the SURVIVING spec objects themselves, so reference identity is
    // the exact "does this site ship" answer — no second implementation of §3.2 precedence to
    // drift from the real one. A site listed without this flag reads as a mutant that will be
    // measured, and for a Tier-1 mutant a Tier-2 operator displaces, that is simply false.
    const kept = new Set(dedupeSpecs(f.specs, dryRunTierOf));
    return f.specs.map((spec) => ({
      file: f.path,
      operatorName: spec.operatorName,
      line: lineOfIndex(f.source, spec.before.startIndex),
      deployed: kept.has(spec),
    }));
  });
}

/**
 * R92: the DEPLOYED mutant count per file — what actually ships after §3.2 dedup drops a Tier-1
 * mutant wherever a Tier-2 operator claims the same site. Measured on Document Output: 176 sites
 * -> 148 deployed (-16%), 991 -> 973, 476 -> 473. The gap is not a constant; it depends on the
 * operator mix of the specific file, so it cannot be estimated from the site count.
 *
 * Runs the SAME `dedupeSpecs` `writeInstrumentedProject` runs at compile time (project.ts), bound
 * to the SAME `operatorTiers` map `runSession` uses — a dry run that reported a number produced by
 * a second implementation of the rule would be exactly the drift this exists to prevent.
 */
const dryRunTierOf: TierResolver = (name) => operatorTiers.get(name);

/**
 * R90: the measured publish bracket for the tier this project is configured against, if there is
 * one to report.
 *
 * **What is tolerated and what is not** — fix round 1 corrected this comment, which previously
 * claimed a blanket "best-effort" the code does not implement:
 *  - An ABSENT config file or ABSENT database: tolerated, returns `undefined`, prints nothing.
 *    `--dry-run` is the one mode that requires neither, so their absence is a normal state rather
 *    than a failure. `existsSync` also keeps `new ResultsStore(path)` (`create: true`) from
 *    CREATING a database a dry run was never asked to make.
 *  - An UNREADABLE or malformed config file: tolerated, returns a `note` the caller prints. The
 *    dry run's own answer (how many mutants, in which files) does not depend on the config at all,
 *    so killing it over a config it did not need would be the wrong trade.
 *  - A locked, corrupt or unreadable DATABASE, and a corrupt `outcome` value in it: **NOT
 *    tolerated — these throw**, deliberately. `new ResultsStore(...)` and `knownCeiling(...)` sit
 *    outside the `try` above on purpose. A database that exists but cannot be read is a real
 *    problem with the file this project's verdicts live in, and reporting "no ceiling measured"
 *    for it would be indistinguishable from a tier that has genuinely never failed — the
 *    empty-vs-empty confusion this project treats as its signature bug.
 *
 * An EXISTING database is opened read-WRITE, not read-only: `ResultsStore`'s constructor ensures
 * the schema (see its `migrate`), and going around it to read `publish_outcomes` directly would
 * mean a second implementation of the row parsing — including the corrupt-value guard — which is
 * exactly the drift this file avoids elsewhere. The writes it can perform are idempotent, additive
 * and identical to the ones `lethal run` performs on the same file moments later. `--help` says so.
 */
async function dryRunCeiling(
  dbPath: string,
  configPath: string,
): Promise<{ tier: string; ceiling: PublishCeiling } | { note: string } | undefined> {
  if (!existsSync(configPath) || !existsSync(dbPath)) return undefined;
  let server: string | undefined;
  let serverInstance: string | undefined;
  try {
    const configFile = await loadLethalConfigFile(configPath);
    server = configFile.bcdev?.server;
    serverInstance = configFile.bcdev?.serverInstance;
  } catch (err) {
    return {
      note:
        `could not read the configured tier from ${configPath}: ` +
        `${err instanceof Error ? err.message : String(err)} — no publish ceiling to report`,
    };
  }
  if (server === undefined || serverInstance === undefined) return undefined;
  const tier = quarantineResourceKey({ server, serverInstance });
  const store = new ResultsStore(dbPath);
  try {
    return { tier, ceiling: knownCeiling(store, tier) };
  } finally {
    store.close();
  }
}

/**
 * Batch count here is derived from `planArtifacts` — the exact same seam
 * `runSession` uses to decide how many artifacts to compile and deploy — so
 * this can never report a number `runSession` wouldn't actually produce.
 *
 * Exported for test: R92's whole point is that the two counts are NAMED and distinguishable in the
 * output, and R90's is that the bracket reads as measurement — neither is checkable by inspecting
 * the numbers this function is handed, only by reading the lines it prints.
 */
export async function printDryRun(
  projectDir: string,
  only: readonly string[] | undefined,
  paths: { readonly dbPath: string; readonly configPath: string },
): Promise<void> {
  // R41: `--only` is honoured here too. A dry run whose whole purpose is "how big is this going to
  // be" would be worse than useless if it answered for the unnarrowed project.
  const { files, skipped, totalFiles, excludedByOnly } = await generateMutationSet(
    projectDir,
    only !== undefined ? { only } : {},
  );
  const sites = sitesOf(files);
  const artifacts = planArtifacts(files);
  // R92: the two numbers are NAMED, never left to be told apart by position — the campaign's own
  // rung-1 gate pre-committed the site count as the expected mutant count and `assertCardinality`
  // correctly refused every anchor until it was corrected. The tool was right and the plan was
  // wrong, and nothing in the tool's output would have prevented the mistake.
  const perFile = files
    .map((f) => ({
      file: f.path,
      sites: f.specs.length,
      deployed: dedupeSpecs(f.specs, dryRunTierOf).length,
    }))
    .sort((a, b) => b.deployed - a.deployed || a.file.localeCompare(b.file));
  const deployedTotal = perFile.reduce((n, f) => n + f.deployed, 0);

  console.log(
    `dry run: ${files.length} file(s), ${sites.length} mutant site(s), ${deployedTotal} deployed mutant(s), ${artifacts.length} batch(es)`,
  );
  // R48: a dry run exists to answer "how big is this going to be", so it is the right place to say
  // that the answer is "too big to run". Saying it here — rather than only when `lethal run`
  // refuses — means the narrowing conversation happens before anything is published.
  if (sites.length > LARGE_RUN_MUTANT_THRESHOLD) {
    console.log(
      `NOTE: ${sites.length} sites is above the ${LARGE_RUN_MUTANT_THRESHOLD} pre-flight limit, so 'lethal run' will refuse this scope. Narrow it with --only <glob>, or pass --allow-large-run.`,
    );
  }
  if (only !== undefined && only.length > 0) {
    console.log(
      `narrowed by --only ${only.map((p) => `"${p}"`).join(", ")}: ${excludedByOnly} of ${totalFiles} .al file(s) excluded from mutation (still parsed, compiled and published)`,
    );
  }
  // R92/R90: per-file guard counts, largest DEPLOYED first — the ordering that matters, since the
  // publish ceiling bites per file (batches split at file granularity, so `--max-guards-per-batch`
  // cannot rescue a file that alone exceeds it) and the biggest file is the one to split or
  // exclude. Both counts are labelled: `sites=` is raw mutation sites, `deployed=` is what actually
  // ships. They differ, and by an amount no one can estimate from the other.
  if (perFile.length > 0) {
    console.log(
      "\nper-file guard counts (largest deployed first) — 'sites' is raw mutation sites, 'deployed' is what ships after tier-precedence dedup:",
    );
    for (const f of perFile) {
      console.log(`  ${f.file}  sites=${f.sites}  deployed=${f.deployed}`);
    }
  }
  // R90: what this project's configured tier has actually MEASURED about publishing, stated as a
  // bracket with its date, never as a limit. A tier with no recorded failure refuses nothing —
  // discovering the ceiling costs exactly one honest failure, and this is where a user learns
  // whether that price has already been paid here.
  const measured = await dryRunCeiling(paths.dbPath, paths.configPath);
  if (measured !== undefined && "note" in measured) {
    console.log(`\nNOTE: ${measured.note}`);
  } else if (measured !== undefined) {
    const { smallestFailure, largestSuccess, failureObservedOn } = measured.ceiling;
    if (smallestFailure === undefined && largestSuccess === undefined) {
      console.log(
        `\npublish ceiling for tier ${measured.tier}: nothing measured yet. Nothing will be refused — a fresh topology discovers its own ceiling by failing once.`,
      );
    } else {
      const failurePart =
        smallestFailure === undefined
          ? "no publish failure has been recorded here yet"
          : `${smallestFailure} guards failed to publish${failureObservedOn === undefined ? "" : ` on ${failureObservedOn}`}`;
      const successPart =
        largestSuccess === undefined
          ? "no successful publish has been recorded here yet"
          : `${largestSuccess} guards published successfully`;
      const refusalPart =
        smallestFailure === undefined
          ? "Nothing will be refused."
          : `Any single file at or above ${smallestFailure} deployed guards will be REFUSED by 'lethal run' before anything is compiled or published.`;
      console.log(
        `\npublish ceiling MEASURED on tier ${measured.tier}: ${failurePart}; ${successPart}. ${refusalPart} This is a recorded observation of this topology, not a fixed limit.`,
      );
    }
  }
  for (const [i, artifact] of artifacts.entries()) {
    const artifactSites = sitesOf(artifact);
    const artifactDeployed = artifactSites.filter((s) => s.deployed).length;
    console.log(
      `\nbatch ${i} (${artifactSites.length} mutant site(s), ${artifactDeployed} deployed):`,
    );
    for (const s of artifactSites) {
      // R92 again, at the finest granularity there is: a site the tier-precedence rule drops is
      // NOT a mutant this run will measure, and a list that renders it identically to one that
      // will is how a site count gets pre-committed as a mutant count.
      const suffix = s.deployed ? "" : "  [not deployed — displaced by a higher-tier operator]";
      console.log(`  ${s.file}:${s.line}  ${s.operatorName}${suffix}`);
    }
  }
  // R5: dry-run mirrors the session report's "not instrumented" accounting so it's visible
  // before any deploy, not just at the end of a real run.
  if (skipped.length > 0) {
    const skippedSites = skipped.reduce((n, s) => n + s.sites, 0);
    console.log(
      `\nnot instrumented: ${skipped.length}/${totalFiles} .al file(s), ${skippedSites} mutation site(s) never measured — object kind cannot carry the selector var:`,
    );
    for (const s of skipped) {
      console.log(`  ${s.file} (${s.kinds}, ${s.sites} site(s))`);
    }
  }
}

/**
 * Runs `body` — everything from directly after `resolveEnvToolSession` resolves through to the end
 * of the session (`buildBackend`, the worker-backend loop, `ResultsStore`, `runSession`) — and
 * tears down `envSession` in a `finally` that runs no matter how `body` settles.
 *
 * Task 7 review, Important 1: `resolveEnvToolSession` may already have provisioned a REAL, billed
 * environment by the time `body` starts. `body` throwing — `buildBackend` failing on the common
 * first-run "could not locate alc.exe/altool.exe" path, the worker loop, or `new
 * ResultsStore(...)` — must still reach this `finally`, or the only way back is the
 * `~/.lethal/env-state/<runId>.json` crash-recovery record instead of an automatic teardown.
 *
 * Task 7 review, Important 2: `teardown`'s own failure is caught here and only `console.warn`ed —
 * the SAME posture `env-tool-session.ts`'s own `teardown` already uses internally for a failed
 * `deleteEnv` spawn. `teardown` can also reject for a reason `env-tool-session.ts` cannot catch
 * itself: `validateEnvToolConfig` only checks that a `deleteEnv` placeholder is KNOWN, not that
 * it's suppliable at teardown time, so a `deleteEnv` block naming `{appFile}` makes `renderCommand`
 * throw from inside `teardown`'s own `catch`. Left unguarded, that would discard `body`'s report
 * and error, turning exit 0 or the quarantine exit code 3 into an ordinary uncaught-throw exit 1 —
 * exactly the "fix your config and retry" signal the quarantine code exists to avoid sending when
 * the real state is a stranded tier.
 *
 * Exported so both properties are directly unit-testable against a `body`/`teardown` that
 * throw/reject on demand, without a real backend or a real environment tool.
 */
export async function withEnvTeardown(
  envSession: EnvToolSession | undefined,
  keepEnv: boolean,
  body: () => Promise<SessionReport>,
): Promise<SessionReport> {
  let report: SessionReport | undefined;
  try {
    report = await body();
    return report;
  } finally {
    if (envSession !== undefined) {
      try {
        await envSession.teardown({
          keepEnv,
          // `report` is `undefined` only when `body` itself threw (a real failure, not a
          // quarantine verdict) — that is not treated as a quarantine here either, matching what
          // `main()` reports as the exit code (an uncaught throw exits 1, never the quarantine
          // code 3).
          quarantined: report?.quarantined !== undefined,
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.warn(
          `[lethal] env-tool teardown failed and could not complete automatically — the environment may still exist; check ~/.lethal/env-state for the crash-recovery record. Underlying error: ${detail}`,
        );
      }
    }
  }
}

/**
 * R7/R8: prove — on the ACTUAL configured binary, every al-runner session — whether the two
 * measured al-runner defects (asserterror never fails; a table object's own global var doesn't
 * survive a trigger's write back out) are present on THIS machine's build, rather than
 * repeating a claim frozen at the moment someone last measured it by hand. Only possible once
 * `alRunnerPath` is known; if it isn't, `buildBackend` throws its own targeted "missing
 * alRunnerPath" error moments later, and the static fallback (`warnAlRunnerNotAuthoritative`)
 * covers that gap instead — in which case there is nothing measured to return either.
 *
 * Extracted out of `runFromCli` (rather than left inlined there) so this specific branch — which
 * config field gates the canary vs. the fallback, and that the canary's own warnings actually
 * reach `console.warn` — is directly testable without mocking `runFromCli`'s config-file I/O,
 * `resolveEnvToolSession`, `buildBackend`, and `runSession` all at once (see cli.test.ts's own
 * note on why it deliberately does not exercise `runFromCli` end to end).
 *
 * Returns the measured result (or `undefined` on the no-`alRunnerPath` fallback path) so
 * `runFromCli` can attach it to the `SessionReport` via `withAlRunnerCanary` below — printing it
 * once via `console.warn` here and nowhere else was the exact "warning that scrolls past, and a
 * `--out` JSON report or any CI that discards stderr never sees it at all" gap review flagged.
 */
export async function announceAlRunnerCanary(
  configFile: LethalConfigFile,
  runCanary: typeof runAlRunnerCanary = runAlRunnerCanary,
): Promise<AlRunnerCanaryResult | undefined> {
  const alRunnerPath = configFile.alRunner?.alRunnerPath;
  if (alRunnerPath === undefined) {
    warnAlRunnerNotAuthoritative();
    return undefined;
  }
  const canary = await runCanary(alRunnerPath);
  for (const line of alRunnerCanaryWarnings(canary)) console.warn(line);
  return canary;
}

/**
 * Attaches a measured al-runner canary result onto a `SessionReport` — a plain, obviously-correct
 * merge (never mutating `report`) extracted so it's directly unit-testable without needing a real
 * `runSession`/`ResultsStore`/backend to produce a `SessionReport` in the first place. `canary`
 * is `undefined` on every bcdev session (never computed) and on the al-runner no-`alRunnerPath`
 * fallback path (nothing was measured) — both leave `report` untouched rather than adding an
 * `alRunnerCanary` key with no real content.
 */
export function withAlRunnerCanary(
  report: SessionReport,
  canary: AlRunnerCanaryResult | undefined,
): SessionReport {
  return canary !== undefined ? { ...report, alRunnerCanary: canary } : report;
}

/**
 * Fans one already-stamped `RunEvent` out to several independent `SessionConfig.emit` subscribers
 * — today, the stderr progress renderer (Task 5) and, when `--progress-out` is given, the NDJSON
 * sink (Task 6). Isolates a throwing subscriber from its siblings, same shape as `events.ts`'s own
 * `createEmitter`, but WITHOUT re-stamping `seq`: every event reaching this function already
 * carries its real `seq` from `runSession`'s canonical stream, and re-running it through
 * `createEmitter` would silently overwrite that with a second, locally-recomputed counter — numerically
 * identical only by the accident that this function happens to see every event with none filtered
 * out. Reusing `createEmitter` here would make that coincidence load-bearing without a compiler
 * catching it if it ever stopped holding.
 *
 * Exported for testing — `runFromCli` only ever exercises this when a real subscriber actually
 * throws, which the happy-path crash-survival run (task-6-report.md) never did, so the isolation
 * behaviour it exists for needs its own direct unit tests (cli.test.ts) rather than depending on
 * `runFromCli`'s end-to-end plumbing to hit the catch branch by chance.
 */
export function fanOutEmit(subs: readonly EventSubscriber[]): EventSubscriber {
  const broken = new Set<number>();
  return (event) => {
    subs.forEach((sub, i) => {
      try {
        sub(event);
      } catch (err) {
        if (!broken.has(i)) {
          broken.add(i);
          process.stderr.write(
            `[lethal] progress subscriber ${i} threw and will keep receiving events: ${String(err)}\n`,
          );
        }
      }
    });
  };
}

export async function runFromCli(
  parsed: RunCliConfig,
  deps: {
    resolveEnvToolSession?: typeof resolveEnvToolSession;
    buildBackend?: typeof buildBackend;
    // Task 7 review, wave 2: injectable so a test can drive `runFromCli`'s own cleanup/return-value
    // wiring (a quarantined report surviving a `store.close()` failure; a report surviving a
    // `backend.close()` failure) with a canned `SessionReport`, without needing a real backend/AL
    // project to produce one for real.
    runSession?: typeof runSession;
    // R3 review: injectable for the same reason as the three above — most of this file's own
    // `runFromCli` unit tests use a fake, nonexistent `projectDir` (e.g. "C:/proj") and inject
    // `buildBackend`/`runSession` to avoid touching real I/O; without this seam, the REAL
    // `validateSelectorIdsForProject` below would try to read a nonexistent app.json and break
    // every one of them. See its call site's comment for WHY it moved here at all.
    validateSelectorIdsForProject?: typeof validateSelectorIdsForProject;
    // R7/R8: injectable so a test can drive the al-runner canary's warning wiring below with a
    // canned `AlRunnerCanaryResult`, without spawning a real al-runner process.
    runAlRunnerCanary?: typeof runAlRunnerCanary;
  } = {},
): Promise<SessionReport> {
  const configFile = await loadLethalConfigFile(parsed.configPath);
  // R3: resolved once, up front, from CLI flags > this config file's `selectorIds` section >
  // DEFAULT_SELECTOR_IDS (`resolveSelectorIds`). Threaded through to every `build(...)` call below
  // and into `runTheSession`'s `SessionConfig.selectorIds`.
  const selectorIds = resolveSelectorIds(
    parsed.selectorIdOverrides ?? {},
    validateSelectorIdsConfig(configFile.selectorIds),
  );
  // R3 review (Important): validated HERE, before `resolveSession` below — not left solely to the
  // check already inside the real `buildBackend` (kept there too, as defense in depth, since a
  // caller could reach `buildBackend` some other way). `resolveEnvToolSession` can provision a
  // REAL, billed environment (Layer 6C `envTool`); by the time `buildBackend`'s own check would
  // fire, that environment already exists. Both inputs this needs — `parsed.projectDir` and the
  // resolved `selectorIds` — are available now, with no I/O of `resolveSession`'s own in between,
  // so there is no reason to defer it past this point.
  const validateIds = deps.validateSelectorIdsForProject ?? validateSelectorIdsForProject;
  await validateIds(parsed.projectDir, selectorIds);
  const scratchRoot = await mkdtemp(join(tmpdir(), "lethal-"));
  // R7/R8: captured here (outer scope) rather than discarded, so the `withEnvTeardown` closure
  // below can attach it to the final `SessionReport` — see `withAlRunnerCanary`. Stays
  // `undefined` for every bcdev session (this branch never runs) and for the al-runner
  // no-`alRunnerPath` fallback path.
  let alRunnerCanaryResult: AlRunnerCanaryResult | undefined;
  if (parsed.backendKind === "al-runner") {
    alRunnerCanaryResult = await announceAlRunnerCanary(
      configFile,
      deps.runAlRunnerCanary ?? runAlRunnerCanary,
    );
    // R18: `--keep-env`/`--allow-expiring-env` are refused OUTRIGHT for al-runner (parseCliConfig,
    // above) on the reasoning that a silent no-op is wrong — a whole configured `envTool` section
    // being silently ignored deserves at least the same treatment. Not refused outright (unlike
    // those flags) because a config file is often shared across `--backend` choices and an
    // operator switching backends for a one-off al-runner run shouldn't be blocked by it; but
    // silence is exactly the failure mode this project refuses to ship.
    if (configFile.envTool !== undefined) {
      console.warn(
        "[lethal] envTool is configured but IGNORED: --backend al-runner has no environment to " +
          "resolve or provision — the entire `envTool` section in this config is silently unused " +
          "on this path. Remove it, or run with --backend bcdev to have it take effect.",
      );
    }
  }

  // Task 7: resolves the bcdev section EXACTLY ONCE (see `resolveEnvToolSession`'s doc comment)
  // and substitutes it into `effectiveConfig`, which every downstream seam below reads instead of
  // the raw `configFile` — `buildBackend` (both the main backend and, in a future multi-worker
  // bcdev world, any per-worker one), `resourceIdentityFor`, and `leaseSessionFor` all still call
  // `validateBcDevConfig` independently, but against the SAME already-resolved section.
  const resolveSession = deps.resolveEnvToolSession ?? resolveEnvToolSession;
  const { effectiveConfig, envSession, deploy } = await resolveSession(
    parsed,
    configFile,
    basename(scratchRoot),
  );

  // Minor 6 (Task 7 review): `--keep-env` with a bcdev backend but no `envTool` section configured
  // is a silent no-op — there is no environment for it to act on. Not catchable at parse time
  // (parsing has no config file loaded yet), so it's caught here, right after the config-dependent
  // `envSession` is known. `--keep-env` + `--backend al-runner` is refused outright at parse time
  // instead (see `parseCliConfig`), so by construction the only way to reach this with `keepEnv`
  // true and `envSession` undefined is exactly this case.
  if (parsed.keepEnv && envSession === undefined) {
    console.warn(
      "[lethal] --keep-env has no effect: the bcdev config has no `envTool` section configured, " +
        "so there is no environment for LethAL to keep",
    );
  }

  const build = deps.buildBackend ?? buildBackend;
  const runTheSession = deps.runSession ?? runSession;

  // Important 1 (Task 7 review): the try/finally that owns teardown (`withEnvTeardown`) now wraps
  // `buildBackend`, the worker-backend loop, and `new ResultsStore(...)` too — not just
  // `runSession` — so a REAL, possibly-billed, provisioned environment from `resolveEnvToolSession`
  // above is never leaked no matter which of those steps throws.
  return await withEnvTeardown(envSession, parsed.keepEnv, async () => {
    let backend: ExecutionBackend | undefined;
    let store: ResultsStore | undefined;
    // Task 6: opened before `runTheSession` (below) so a killed process still leaves whatever was
    // written to the OS. Closed in the `finally` below, best-effort, same posture as `store`/
    // `backend`.
    let progressOutFd: number | undefined;
    // Task 7 review, wave 2 (Important — the restructure itself introduced this): `report` MUST be
    // captured in a local BEFORE the `finally` runs, and returned AFTER it — never
    // `return await runSession(...)` directly inside the `try`. Per JS `try/finally` semantics, a
    // throw from `finally` silently DISCARDS the `try`'s pending return value and replaces it with
    // the `finally`'s own error; a `store.close()`/`backend.close()` failure would then look
    // identical to `runSession` itself throwing — `withEnvTeardown`'s `report` would stay
    // `undefined`, `quarantined` would evaluate `false` even for an actually-quarantined report,
    // and `envSession.teardown` would take the DELETE branch on the environment the quarantine
    // exists to preserve for investigation. `main()` would also exit 1 instead of the quarantine
    // code 3, and the report would never be printed/written.
    let report: SessionReport | undefined;
    try {
      backend = await build(parsed, effectiveConfig, scratchRoot, deploy, {}, selectorIds);
      // `SessionConfig.backendFactory` is synchronous (`runSession` calls it
      // without awaiting — see orchestrator.ts), but building a worker's backend
      // is async (bcdev needs `defaultAlToolPaths()` + `mkdir`). So every worker
      // backend is constructed here, up front, each with its own
      // `<scratchRoot>/worker-<i>` scratch dir; the factory below just hands back
      // the already-built instance for that index. `runSession` still owns
      // disposing them (see `closeIfSupported` in orchestrator.ts) — it just
      // doesn't own constructing them.
      //
      // (bcdev + --workers > 1 is refused in `parseCliConfig`, so this loop only ever builds
      // al-runner backends today — `effectiveConfig` equals `configFile` on that path regardless,
      // since `resolveEnvToolSession` is a no-op for al-runner. `deploy` is still threaded through
      // (Important 3, Task 7 review): a bcdev worker built without it would silently publish via
      // `ContainerDeployer`/altool instead of through the configured env tool — unreachable today
      // only because of the `--workers > 1` bcdev refusal above, and that restriction is
      // explicitly deferred rather than permanent.)
      const workerBackends: ExecutionBackend[] = [];
      if (parsed.workers > 1) {
        for (let i = 0; i < parsed.workers; i++) {
          workerBackends.push(
            await build(
              parsed,
              effectiveConfig,
              join(scratchRoot, `worker-${i}`),
              deploy,
              {},
              selectorIds,
            ),
          );
        }
      }
      store = new ResultsStore(parsed.dbPath);
      // Task 5 (event-stream refactor, spec 2026-08-05 §A): a run this long (a baseline alone
      // can run for minutes with zero prior output) needs a live indication it hasn't stalled.
      // Writes to STDERR — never stdout, which is where the final report goes
      // (`renderConsole`/`writeJsonReport` below) — because mixing progress into the report's
      // own stream already cost a real session a swallowed error, twice, behind a `grep` on the
      // combined output.
      const progress = createProgressRenderer((line) => process.stderr.write(`${line}\n`), {
        heartbeatMs: PROGRESS_HEARTBEAT_MS,
      });
      // Task 6 (event-stream refactor, spec 2026-08-05 §A): `--progress-out <path>` streams the
      // SAME events to an NDJSON file, one JSON object per line, flushed synchronously per event
      // so a killed process still leaves whatever was written to the OS — see progress-ndjson.ts's
      // module doc, including the header-line and provisional-verdict contract. `fs.writeSync`
      // (not a `WriteStream`) because a buffered stream can lose whatever sits in its in-process
      // buffer when the process is killed rather than exiting cleanly, which is exactly the case
      // this flag exists to survive.
      const emitSubscribers: EventSubscriber[] = [progress];
      if (parsed.progressOutPath !== undefined) {
        progressOutFd = openSync(parsed.progressOutPath, "w");
        const fd = progressOutFd;
        emitSubscribers.push(createNdjsonSink((chunk) => writeSync(fd, chunk)));
      }
      report = await runTheSession({
        backend,
        store,
        projectDir: parsed.projectDir,
        testDir: parsed.testDir,
        instrumentedDir: join(scratchRoot, "instrumented"),
        selectorIds,
        skipKnownSurvivors: parsed.skipKnownSurvivors,
        workers: parsed.workers,
        // `SessionConfig.emit` is typed `EventSubscriber` (events.ts) precisely because
        // `runSession` splices it in as an additional subscriber of its own canonical,
        // seq-stamped stream — every event this receives IS a full `RunEvent`, no cast required.
        // A single subscriber even when `--progress-out` adds a second one: `fanOutEmit` isolates
        // either from a throw in the other, and from re-stamping `seq` (see its own doc comment).
        emit: emitSubscribers.length > 1 ? fanOutEmit(emitSubscribers) : progress,
        ...(parsed.only !== undefined ? { only: parsed.only } : {}),
        ...(parsed.testsOnly !== undefined ? { testsOnly: parsed.testsOnly } : {}),
        ...(parsed.maxGuardsPerBatch !== undefined
          ? { maxGuardsPerBatch: parsed.maxGuardsPerBatch }
          : {}),
        ...(parsed.mutantTimeoutMs !== undefined
          ? { mutantTimeoutMs: parsed.mutantTimeoutMs }
          : {}),
        ...(parsed.resume !== undefined ? { resume: parsed.resume } : {}),
        ...(parsed.retryStranded === true ? { retryStranded: true } : {}),
        ...(parsed.stopHungSessions === true ? { stopHungSessions: true } : {}),
        ...afterLeaseAcquiredFor(envSession),
        ...(parsed.allowLargeRun === true ? { allowLargeRun: true } : {}),
        ...(parsed.compileConcurrency !== undefined
          ? { compileConcurrency: parsed.compileConcurrency }
          : {}),
        ...resourceIdentityFor(parsed, effectiveConfig),
        ...leaseSessionFor(parsed, effectiveConfig),
        ...permissionCanaryFor(parsed, effectiveConfig),
        ...(parsed.workers > 1
          ? {
              backendFactory: (i: number) => {
                const b = workerBackends[i];
                if (b === undefined) {
                  throw new Error(`runFromCli: no worker backend pre-built for index ${i}`);
                }
                return b;
              },
            }
          : {}),
      });
    } finally {
      // Best-effort cleanup — mirrors orchestrator.ts's own posture (~line 2056: "deliberately
      // swallow errors here... a failure here must not mask/replace whatever real error is already
      // propagating"). Each close is independently guarded so one failing never skips the others,
      // and none of them can replace `report` (captured above) or a real error already unwinding
      // through this `finally`.
      if (store !== undefined) {
        try {
          store.close();
        } catch (err) {
          console.warn(
            `[lethal] store.close() failed during cleanup (best-effort; the session's report/exit code is unaffected): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      // Release whatever the backend is holding open: the spawned bc-dev MCP
      // child, or (server mode) the one warm al-runner process. The
      // `process.exit(0)` below would paper over a leak here, but only for this
      // entry point — anything else embedding the backend would hang or leak a
      // process instead.
      if (backend instanceof BcDevMcpBackend || backend instanceof AlRunnerBackend) {
        try {
          await backend.close();
        } catch (err) {
          console.warn(
            `[lethal] backend.close() failed during cleanup (best-effort; the session's report/exit code is unaffected): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      // Task 6: closes the `--progress-out` file descriptor, if one was opened. Best-effort, same
      // posture as `store`/`backend` above — a close failure here must not mask a real error
      // already unwinding through this `finally`, and every event that mattered was already
      // flushed synchronously by `writeSync` at emit time, not buffered here waiting for a close.
      if (progressOutFd !== undefined) {
        try {
          closeSync(progressOutFd);
        } catch (err) {
          console.warn(
            `[lethal] closing --progress-out file failed during cleanup (best-effort; the session's report/exit code is unaffected): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    // Reached only when the `try` above completed WITHOUT throwing, so `runSession` resolved and
    // `report` is set — a throw from `runSession` (or from `build`/`ResultsStore`) propagates
    // through this `finally` and out of this function instead of falling through to here. Guarded
    // explicitly (never a `!` assertion — biome forbids them) rather than trusted, matching this
    // project's "fail loudly on a caller-contract violation" rule.
    if (report === undefined) {
      throw new Error(
        "runFromCli: the try block completed without throwing but produced no report — this is a bug in runFromCli, not a session failure",
      );
    }
    // R7/R8: persist the measured canary verdict onto the report itself (a `--out` JSON report,
    // or any CI that discards stderr, previously had no record of it at all — only the
    // console.warn lines printed once at the very start, before a single mutant ran).
    return withAlRunnerCanary(report, alRunnerCanaryResult);
  });
}

/**
 * Distinct process exit code for a `quarantined` session result (`SessionReport.quarantined`
 * set — a run came back in-flight-unknown, latched unsafe, and durably quarantined the tier,
 * spec §8/§12) — separate from exit 1's "an ordinary uncaught failure/config error". A CI/operator
 * script can branch on this without parsing the rendered console report: 3 means "the tier may be
 * stranded, go recycle it and run `lethal clear-quarantine`", not "fix your config and retry".
 */
const QUARANTINED_EXIT_CODE = 3;

/**
 * Operator-proven clear (spec §10): reads the current quarantine record's generation and calls
 * `store.clear(key, gen)` — never an unconditional delete, so a clear computed against a
 * generation the store no longer holds (a NEWER strand was recorded on this tier since) comes
 * back "stale" and leaves that newer record intact rather than erasing it. An absent record is
 * idempotent "not-quarantined". Takes an already-constructed `QuarantineStore` (rather than
 * building one from `defaultQuarantineDir()` itself) so this — the actual clear logic — is
 * directly unit-testable against a scratch store, without a test having to touch the real
 * operator-facing `~/.lethal/quarantine` directory `clearQuarantineFromCli` below points at.
 */
export async function clearQuarantine(
  store: QuarantineStore,
  key: string,
): Promise<"cleared" | "stale" | "not-quarantined"> {
  const rec = await store.read(key);
  if (rec === null) return "not-quarantined";
  return await store.clear(key, rec.generation);
}

/**
 * `lethal clear-quarantine --server ... --instance ...` (spec §10). Opens the SAME store
 * `runSession` durably writes to (`defaultQuarantineDir`) — there is no `--quarantine-dir`
 * override here because an operator clearing a real tier must hit the real store, not one a
 * stray flag silently redirected.
 */
async function clearQuarantineFromCli(parsed: ClearQuarantineCliConfig): Promise<number> {
  const key = quarantineResourceKey({
    server: parsed.server,
    serverInstance: parsed.serverInstance,
  });
  const store = new QuarantineStore(defaultQuarantineDir());
  const result = await clearQuarantine(store, key);
  console.log(result); // "cleared" | "stale" | "not-quarantined"
  return result === "stale" ? 1 : 0;
}

/**
 * `lethal clear-ceiling --project ... --server ... --instance ... [--file ...]` (R90 fix round 1).
 *
 * Refuses a MISSING database loudly rather than creating an empty one and reporting a cheerful
 * "cleared 0 rows": `new ResultsStore(path)` has `create: true`, so without this guard the one
 * command whose entire job is undoing a recorded measurement would answer identically whether the
 * measurement was removed or the operator mistyped the path. That is this project's signature bug
 * (empty-vs-empty "matches"), on the command least able to afford it.
 *
 * Prints every row it destroyed and the ceiling on both sides of the clear. Discarding a `failed`
 * row that was genuine is real evidence loss — it cost a live publish failure to learn — so the
 * loss is made visible rather than forbidden (see `clearPublishCeiling`).
 *
 * **Fix round 2: a clear that removed NOTHING is never reported as success.** It opens with a
 * machine-readable outcome word, mirroring `clear-quarantine`'s single-word line — `cleared`,
 * `nothing-matched` (the tier has rows, but none the requested scope named) or `nothing-recorded`
 * (this tier has no rows at all) — and both zero cases list what the database DOES hold, which is
 * the real diagnosis for the two ways to get here: the wrong database, or a tier identity spelled
 * differently from the one the run recorded under.
 *
 * The exit code DIVERGES from `clear-quarantine`, deliberately. There, `not-quarantined` exits 0
 * because the state the operator wanted (not quarantined) is the state they have. Here it is not:
 * an operator runs this because a file was refused, and a clear that removed nothing leaves that
 * refusal exactly where it was — the next run fails identically. Exiting 0 would tell a human and
 * a script that the escape hatch worked when it did nothing, which is the failure this command
 * exists to prevent, committed by the command itself. So: removed nothing, exit 1.
 */
export async function clearCeilingFromCli(parsed: ClearCeilingCliConfig): Promise<number> {
  if (!existsSync(parsed.dbPath)) {
    throw new Error(
      `no results database at ${parsed.dbPath} — nothing has ever been measured against this project, so there is no publish ceiling to clear. Pass --db <path> if the run used a database elsewhere.`,
    );
  }
  const tier = quarantineResourceKey({
    server: parsed.server,
    serverInstance: parsed.serverInstance,
  });
  const store = new ResultsStore(parsed.dbPath);
  try {
    const result = clearPublishCeiling(store, tier, parsed.file);
    const scope = parsed.file === undefined ? "" : ` file ${parsed.file}`;
    if (result.removed.length === 0) {
      // Everything still on this tier, so a mistyped `--file` is answerable rather than a dead end.
      const remaining = store.publishOutcomes(tier);
      const outcome = remaining.length === 0 ? "nothing-recorded" : "nothing-matched";
      console.log(
        `${outcome}: clear-ceiling removed 0 row(s) for tier ${tier}${scope}. NOTHING WAS CLEARED — whatever refused this project is still recorded, and the next run will be refused identically.`,
      );
      if (remaining.length > 0) {
        console.log(`  tier ${tier} does hold ${remaining.length} row(s):`);
        for (const row of remaining) console.log(`  ${describePublishRow(row)}`);
        console.log(
          "  Re-run naming one of those files with --file, or omit --file to clear the tier.",
        );
      } else {
        const tiers = store.publishOutcomeTiers();
        console.log(
          tiers.length === 0
            ? `  ${parsed.dbPath} holds no publish outcomes for ANY tier — this is probably not the database the run recorded into (check --db).`
            : `  ${parsed.dbPath} holds outcomes only for: ${tiers.join(", ")} — check --server/--instance against how the run recorded the tier.`,
        );
      }
      return 1;
    }
    console.log(`cleared: tier ${tier}${scope} — removed ${result.removed.length} row(s)`);
    for (const row of result.removed) console.log(`  ${describePublishRow(row)}`);
    console.log(
      `  ceiling before: ${describeCeiling(result.before)}\n  ceiling after:  ${describeCeiling(result.after)}`,
    );
    return 0;
  } finally {
    store.close();
  }
}

/** One recorded publish outcome, as `clear-ceiling` lists it — removed, or still present. */
function describePublishRow(row: PublishOutcomeRow): string {
  return `${row.recordedAt}  ${row.outcome}  ${row.guardCount} guard(s)  ${row.file ?? "(multi-file artifact)"}`;
}

/** One-line rendering of a bracket, for `clear-ceiling`'s before/after report. */
function describeCeiling(c: PublishCeiling): string {
  if (c.smallestFailure === undefined && c.largestSuccess === undefined) return "nothing measured";
  const fail =
    c.smallestFailure === undefined
      ? "no recorded failure"
      : `smallest recorded failure ${c.smallestFailure} guard(s)${c.failureObservedOn === undefined ? "" : ` (${c.failureObservedOn})`}`;
  const ok =
    c.largestSuccess === undefined
      ? "no recorded success"
      : `largest recorded success ${c.largestSuccess} guard(s)`;
  return `${fail}; ${ok}`;
}

/**
 * R109: printed on every `lethal doctor` invocation, success or failure — what the checks do NOT
 * cover, so a clean report is never misread as "everything `lethal run` might refuse on was
 * checked". The per-file publish ceiling (`publish-ceiling.ts`) needs a generated mutation
 * manifest's per-file guard counts, which doctor — deliberately read-only, no instrumentation
 * step — never produces. Baseline test health needs an actual run against the target. Both are
 * measured gaps, not oversights (see `roadmap-auditor`'s standard for what "done" needs to mean
 * here): stating them plainly is this project's answer to exactly this shape of omission.
 *
 * Review round 1 (Critical) added the lease/op-marker: it shipped as a fifth CHECK in round 0,
 * always reporting `"clear"` — a check that structurally could not fail, counted as a pass in the
 * one report a user in exactly that stuck state would read. `ControlApi` (extensions/lethal-
 * control) exposes no read-only peek at the machine-global lease/op-marker row today —
 * `GetOperationStatus` requires an ALREADY-HELD `(epoch, token, generation)` tuple, and doctor
 * must not acquire one just to check (acquiring, even to release immediately after, is a
 * mutation). This is a "not implemented yet" gap, not a platform limit: `ControlState.Codeunit.al`
 * already has the precedent (`CurrentServerGeneration()`, documented as a plain read-only
 * accessor) for surfacing `Owner`/`Op Kind`/`Expires At` the same way — filed as R110, out of this
 * task's scope. The lease belongs here, in what doctor admits it cannot check, not in `checks`
 * pretending it can.
 */
export const DOCTOR_NOT_CHECKED =
  "Not checked: the per-file publish ceiling (needs a generated mutation manifest), baseline " +
  "test health (needs an actual run), and the machine-global lease/op-marker (no read-only peek " +
  "exists on the control app today — R110). A clean report here does not mean `lethal run` " +
  "cannot still refuse for any of these reasons.";

/**
 * Final review: printed ONLY for a create-mode envTool config (`envTool.envId` absent) —
 * `environment`/`quarantine`/`control-version` are all omitted from `checks` entirely for exactly
 * this config shape (see `buildDoctorDeps`'s `isCreateMode`), so a reader needs to know WHY those
 * three are simply missing rather than passing, failing, or silently forgotten.
 */
export const DOCTOR_CREATE_MODE_CAVEAT =
  "envTool.envId is absent (create-mode): this config creates a NEW environment on every " +
  "`lethal run`, so environment status, the quarantine record, and the control-app version have " +
  "nothing to check yet — none exists until a run provisions one. Only tool-paths is checked here.";

/**
 * The `packageCachePath` `validateBcDevConfig` requires (it is `BcDevConfigSection`'s shared
 * shape) when a read-only resolver has nothing else to offer for it — a config that leaves
 * `packageCachePath` to `downloadSymbols` (no static path declared — legal per
 * `validateEnvToolConfig`'s `hasPackageCachePath` option) genuinely has no value for this field
 * until a real session runs `downloadSymbols`, which a read-only resolver must never do.
 *
 * Computes the SAME default `startEnvToolSession` does (env-tool-session.ts:240,
 * `args.bcdevRaw.packageCachePath ?? join(args.projectDir, ".alpackages")`) WITHOUT running
 * `downloadSymbols` — one place, so `buildDoctorDeps`'s `resolvedBcdev` and
 * `resolveForceResetLeaseConfig` cannot drift apart on it the way doctor already drifted from
 * `run` twice before this task (the `altool` requirement, R21; the `requireStatus` comparison,
 * R34's parity fix) — this is the THIRD instance of the same defect class, caught only because a
 * fix round tried the same env-tool config against doctor and it threw on a field neither command
 * dereferences. Shared here rather than copy-pasted a second time.
 */
function packageCachePathDefault(
  bcdevRaw: Partial<BcDevConfigSection> | undefined,
  projectDir: string | undefined,
): string {
  return bcdevRaw?.packageCachePath ?? join(projectDir ?? ".", ".alpackages");
}

/**
 * R109 ruling, honesty constraint 2: `requireStatus` is `Pick`ed straight off `EnvToolConfigSection`
 * (env-tool.ts) rather than re-declared — a future rename/reshape of that field breaks THIS
 * function at compile time instead of silently leaving `DoctorConfig.envReady` derived from a
 * field that no longer means what it says.
 */
function doctorConfigFromEnvTool(
  envTool: Pick<EnvToolConfigSection, "requireStatus"> | undefined,
): DoctorConfig {
  const equals = envTool?.requireStatus?.equals;
  return equals !== undefined ? { envReady: equals } : {};
}

/**
 * R109 ruling, honesty constraint 1: builds `DoctorDeps`/`DoctorConfig` through the SAME
 * load-and-validate path `lethal run` uses — `validateBcDevConfig`/`validateEnvToolConfig`, the
 * identical calls `resolveEnvToolSession`/`buildBackend` make — never a second, hand-rolled parse.
 * A config `run` would reject (a missing `bcdev` section, a malformed `envTool` block, an
 * `envTool.resolve` producing no `baseUrl`, …) throws HERE too, identically: that is a
 * caller-contract violation (a broken invocation), not a "failing check" `runDoctor` could report
 * — the split CLAUDE.md asks for between "throw on a bad call" and "report a bad state".
 *
 * Constraint 3 (every check calls the refusal's own machinery): `HarnessVerifier.fetchControlVersion`
 * (harness.ts) for control-version, `HarnessVerifier.checkReachable` (harness.ts — pure reachability,
 * deliberately narrower than `verify()`/`fetchControlVersion()` so a content problem is never
 * mis-attributed under the name "environment", review round 1's Minor finding) for a directly-
 * configured container's environment probe, `QuarantineStore`/`quarantineResourceKey`/
 * `defaultQuarantineDir` (quarantine-store.ts/resource-key.ts/orchestrator.ts — the SAME three
 * `runSession`'s quarantine consult and `clearQuarantineFromCli` use) for quarantine,
 * `defaultAlToolPaths`/`resolveAlToolPaths` (publisher.ts/cli.ts — the SAME pair `buildBackend`
 * uses) for tool-paths, and `EnvToolClient` (env-tool.ts) for an env-tool-configured environment.
 * `altoolRequired` mirrors `buildBackend`'s own `envToolDeploy !== undefined` leniency
 * (cli.ts:1548, R21) rather than a doctor-only opinion — an env-tool project never spawns altool,
 * so doctor must not fail one for lacking it (review round 1, Important).
 *
 * Constraint 4 (read-only hard boundary): the environment probe below spawns ONLY the configured
 * `envTool.resolve` blocks — never `createEnv`/`startEnv`/`publish`/`downloadSymbols`, which
 * provision, bill, or mutate. This is the one place in `lethal doctor`'s whole call graph that
 * spawns an external process at all, and it is scoped to that one array on purpose.
 *
 * No `leaseState` here (review round 1, Critical): it shipped in round 0 always returning
 * `"clear"` — a check that structurally could not fail, counted as a pass. See `DOCTOR_NOT_CHECKED`
 * (which now names it, and R110) rather than a fifth entry in `DoctorDeps` pretending to observe
 * something no read-only call can.
 *
 * Create-mode envTool configs (final review): `environment`/`quarantine`/`control-version` are
 * omitted from the returned `deps` entirely (not merely made to throw a friendlier error) when
 * `envTool.envId` is absent — `isCreateMode` below. Those three all need an environment that does
 * not exist yet; the honest failure mode is "nothing to check", and `runDoctor` already skips a
 * check whose dep is absent (doctor.ts) rather than reporting it. `createModeCaveat` names WHY, so
 * a reader sees the reason rather than three checks silently missing.
 */
export async function buildDoctorDeps(
  configFile: LethalConfigFile,
  opts: {
    readonly projectDir?: string;
    readonly quarantineDir?: string;
    readonly alToolPaths?: typeof defaultAlToolPaths;
    readonly fetchFn?: FetchFn;
    readonly makeEnvToolClient?: (cfg: EnvToolConfigSection) => EnvToolClient;
  } = {},
): Promise<{
  readonly cfg: DoctorConfig;
  readonly deps: DoctorDeps;
  readonly createModeCaveat?: string;
}> {
  let envCfg: EnvToolConfigSection | undefined;
  if (configFile.envTool !== undefined) {
    const bcdevRaw = configFile.bcdev ?? {};
    const bcdevDeclaredKeys = (READS_KEYS as readonly string[]).filter((key) => {
      const v = (bcdevRaw as Record<string, unknown>)[key];
      return typeof v === "string" && v !== "";
    });
    // SAME validator, SAME opts shape `resolveEnvToolSession` builds — a malformed envTool
    // section throws here identically to `run` (constraint 1).
    envCfg = validateEnvToolConfig(configFile.envTool, {
      env: process.env,
      hasPackageCachePath: Boolean(configFile.bcdev?.packageCachePath),
      bcdevDeclaredKeys,
    });
    // Fail fast on the three fields the env tool itself can never supply — the SAME check
    // `startEnvToolSession` runs as its very first statement, exported for exactly this reuse
    // (env-tool-session.ts). `server`/`serverInstance`/credentials are deliberately NOT required
    // here: in env-tool mode they don't exist yet (resolved later — see `resolvedBcdev` below).
    requireBcDevRawFields(bcdevRaw);
  } else if (configFile.bcdev === undefined) {
    // Final review (Minor): `validateBcDevConfig`'s own message says `...(required for --backend
    // bcdev)` — accurate for `run`, which HAS a --backend flag to name; doctor has none. An
    // al-runner-only project (no `bcdev` section at all — `run --backend al-runner` never touches
    // `configFile.bcdev`, so this is a perfectly valid config) hit that message and read it as
    // "your config is broken", when the honest answer is narrower: doctor's checks are all live-BC
    // concerns and none of them apply here yet. Scoped to `bcdev` being FULLY ABSENT — a `bcdev`
    // section that IS present but missing a required field is a genuine typo, and
    // `validateBcDevConfig`'s own field-listing message below is the right one for that.
    throw new Error(
      'lethal doctor only checks a bcdev-configured project — environment, quarantine, control-app version and alc/altool are all live-BC concerns. This config has no "bcdev" section; if this is an al-runner project (--backend al-runner), there is nothing here for doctor to check today.',
    );
  } else {
    // No envTool, `bcdev` present: this IS exactly what `run` validates (`buildBackend`/
    // `resourceIdentityFor`/`leaseSessionFor` all call this on the SAME `configFile.bcdev`) — fail
    // here, eagerly, rather than lazily inside whichever check happens to touch it first.
    validateBcDevConfig(configFile.bcdev);
  }
  const makeClient =
    opts.makeEnvToolClient ??
    ((cfg: EnvToolConfigSection) => new EnvToolClient(cfg, undefined, opts.projectDir));
  // Snapshot into a `const` so a closure below can narrow it — TS will not narrow a captured
  // `let` across a nested arrow function even after an `!== undefined` check, since it cannot
  // prove nothing reassigns it before the closure runs.
  const resolvedEnvCfg = envCfg;

  // Final review: a CREATE-MODE envTool config (`envId` absent — `validateEnvToolConfig`'s own
  // create-mode branch, env-tool.ts:288-306; `requireStatus` is REFUSED there, env-tool.ts:378)
  // is structurally valid and `lethal run` provisions it. But `environment`/`quarantine`/
  // `control-version` all need an environment that does not exist yet — `resolveEnvToolOnce`
  // would substitute `{envId}` into a `resolve` block's command with nothing supplied, and
  // `renderCommand` throws BY NAME on that (env-tool.ts): "no value available for placeholder
  // {envId}". That message names an INTERNAL placeholder, reads as a bug in the user's config,
  // and would send someone editing a file that is correct. Detected here, once, and used below to
  // omit those three deps entirely (never define them as failing checks) rather than widen the
  // read-only boundary to make an environment exist to check.
  const isCreateMode =
    resolvedEnvCfg !== undefined &&
    (resolvedEnvCfg.envId === undefined || resolvedEnvCfg.envId === "");

  // Spawns ONLY `envTool.resolve` — never createEnv/startEnv/publish/downloadSymbols (constraint
  // 4, the hard read-only boundary). Memoized: `environment`/`quarantine`/`control-version` all
  // need the identity this produces (server/serverInstance/credentials, for an env-tool-configured
  // project — see `resolvedBcdev` below), and `runDoctor` may call them concurrently; this ensures
  // the external tool is spawned at most once per `lethal doctor` invocation, not once per check.
  let resolvePromise: Promise<Record<string, string>> | undefined;
  const resolveEnvToolOnce = (): Promise<Record<string, string>> => {
    if (resolvedEnvCfg === undefined) return Promise.resolve({});
    if (resolvePromise === undefined) {
      resolvePromise = (async () => {
        const client = makeClient(resolvedEnvCfg);
        const supplied: Record<string, string> = {
          envId: resolvedEnvCfg.envId ?? "",
          projectDir: opts.projectDir ?? "",
          testDir: "",
          runId: "doctor",
        };
        const resolved: Record<string, string> = {};
        for (const [i, block] of (resolvedEnvCfg.resolve ?? []).entries()) {
          Object.assign(resolved, await client.run(block, `resolve[${i}]`, supplied));
        }
        return resolved;
      })();
    }
    return resolvePromise;
  };

  /**
   * The `BcDevConfigSection` `quarantine`/`control-version` need — `server`/`serverInstance` and
   * OData credentials. For a directly-configured bcdev section this is exactly `run`'s own
   * `validateBcDevConfig(configFile.bcdev)` (unchanged). For an env-tool-configured project those
   * fields are legitimately ABSENT from the raw file (the tool supplies them) — mirrors
   * `startEnvToolSession`'s own step 4 derivation (`splitBaseUrl`/`deriveMcpPort`, exported from
   * env-tool-session.ts for exactly this reuse) so doctor's identity can never drift from a real
   * run's, rather than a second, hand-rolled derivation.
   */
  const resolvedBcdev = async (): Promise<BcDevConfigSection> => {
    if (resolvedEnvCfg === undefined) return validateBcDevConfig(configFile.bcdev);
    const resolved = await resolveEnvToolOnce();
    const baseUrl = resolved.baseUrl;
    if (baseUrl === undefined) throw new EnvToolError("envTool.resolve produced no baseUrl");
    const { server, serverInstance } = splitBaseUrl(
      baseUrl,
      resolved.server,
      resolved.serverInstance,
    );
    const port = deriveMcpPort(baseUrl);
    const username = resolved.username;
    const password = resolved.password;
    if (username === undefined || password === undefined) {
      throw new EnvToolError("envTool.resolve produced no username/password");
    }
    // See `packageCachePathDefault`'s doc comment — doctor never compiles or publishes either, but
    // `validateBcDevConfig`'s shared shape still requires the field. Fix round 1 (Important 2):
    // this was previously omitted here, so `lethal doctor` against an env-tool config that legally
    // leaves `packageCachePath` to `downloadSymbols` threw "missing required field(s):
    // packageCachePath" and never ran a single check — doctor stricter than `run` for the third
    // time in this subsystem.
    const packageCachePath = packageCachePathDefault(configFile.bcdev, opts.projectDir);
    return validateBcDevConfig({
      ...(configFile.bcdev ?? {}),
      baseUrl,
      server,
      serverInstance,
      port,
      username,
      password,
      packageCachePath,
    });
  };

  const harnessVerifierFor = async (): Promise<HarnessVerifier> =>
    new HarnessVerifier(odataCfgFor(await resolvedBcdev()), opts.fetchFn ?? fetch);

  const envStatus = async (): Promise<string> => {
    const resolveBlocks = resolvedEnvCfg?.resolve;
    if (resolvedEnvCfg !== undefined && resolveBlocks !== undefined && resolveBlocks.length > 0) {
      const resolved = await resolveEnvToolOnce();
      // Review round 1 (bonus fix alongside the Minor below): only compare a REAL status when
      // `requireStatus` is actually declared — R34/`validateEnvToolConfig`'s own posture ("does
      // not check a status when no expectation is declared… pre-R34 configs unaffected"). A
      // `resolve` block reading `status` without `requireStatus` set is legal (nothing forces the
      // two together), and comparing it against the hardcoded default anyway would apply an
      // expectation this config never declared.
      if (resolvedEnvCfg.requireStatus !== undefined && resolved.status !== undefined) {
        return resolved.status;
      }
      // No `requireStatus` declared, or resolve declared no `status` read — resolve succeeding is
      // itself the only signal available; fall through to the reachability probe below rather
      // than reporting a status this config never asked to observe.
    }
    // No envTool, or one with nothing to say about status: a directly-configured container has no
    // separate "status" concept LethAL can read, and neither does an envTool config with no
    // `requireStatus` — HarnessInfo answering IS the readiness signal. `checkReachable()`, not
    // `verify()`: review round 1 (Minor) — `verify()`'s appId/protocol/isolation/tenant/version
    // gates would surface OTHER checks' concerns under the name "environment". The sentinel says
    // exactly what was established, rather than inventing a vendor status word ("Running") nothing
    // reported.
    await (await harnessVerifierFor()).checkReachable();
    return ENV_STATUS_REACHABLE_NO_VENDOR_STATUS;
  };

  const quarantine = async (): Promise<string> => {
    const bcdev = await resolvedBcdev();
    const key = quarantineResourceKey({
      server: bcdev.server,
      serverInstance: bcdev.serverInstance,
    });
    const store = new QuarantineStore(opts.quarantineDir ?? defaultQuarantineDir());
    const rec = await store.read(key);
    return rec === null
      ? "clear"
      : `${rec.opKind}: ${rec.detail}, recorded ${rec.recordedAtIso}, generation ${rec.generation}`;
  };

  const controlVersion = async (): Promise<string> =>
    (await harnessVerifierFor()).fetchControlVersion();

  // Deliberately independent of `resolvedBcdev`: `alcPath`/`altoolPath` overrides are always
  // hand-written LOCAL machine paths (never env-tool-derived), so this check must not fail just
  // because server identity is unresolvable — it is testing something else entirely.
  const toolPaths = async (): Promise<{ readonly alc: string; readonly altool: string }> => {
    const discover = opts.alToolPaths ?? defaultAlToolPaths;
    const discovered = await discover();
    const alcPath = configFile.bcdev?.alcPath;
    const altoolPath = configFile.bcdev?.altoolPath;
    const resolved = resolveAlToolPaths(
      {
        ...(alcPath !== undefined ? { alcPath } : {}),
        ...(altoolPath !== undefined ? { altoolPath } : {}),
      },
      discovered,
    );
    return { alc: resolved.alcPath ?? "", altool: resolved.altoolPath ?? "" };
  };

  return {
    cfg: {
      ...doctorConfigFromEnvTool(envCfg),
      // Review round 1 (Important): an env-tool-configured project publishes through the tool and
      // never spawns altool at all (`deployerFor`/`buildBackend`'s `envToolDeploy !== undefined`
      // branch, cli.ts:1548, R21) — mirror `run`'s own leniency rather than being stricter than it.
      ...(configFile.envTool !== undefined ? { altoolRequired: false } : {}),
    },
    // Create mode: omit the three deps ENTIRELY (not merely make them throw a friendlier error) —
    // `runDoctor` skips a check whose dep is absent, rather than reporting a failure for a
    // question that has no answer yet. See `DOCTOR_CREATE_MODE_CAVEAT` and `doctorFromCli` below.
    deps: isCreateMode ? { toolPaths } : { envStatus, quarantine, controlVersion, toolPaths },
    ...(isCreateMode ? { createModeCaveat: DOCTOR_CREATE_MODE_CAVEAT } : {}),
  };
}

/** Renders a `DoctorReport` the same way every other subcommand renders its own outcome — one
 *  named line per check, then the machine-readable summary word `clear-quarantine`/`clear-ceiling`
 *  already use for their own top line. `createModeCaveat` (final review) is an ADDITIONAL,
 *  config-shape-specific line appended after `DOCTOR_NOT_CHECKED` — see `buildDoctorDeps`'s
 *  `isCreateMode` for what triggers it and why it is not merged into that fixed constant (it is
 *  conditional; `DOCTOR_NOT_CHECKED` is universal). */
export function renderDoctorReport(report: DoctorReport, createModeCaveat?: string): string {
  const lines = report.checks.map((c) => `  [${c.ok ? "ok" : "FAIL"}] ${c.name}: ${c.detail}`);
  return [
    report.ok ? "ok: every check passed" : "FAIL: at least one check failed",
    ...lines,
    "",
    DOCTOR_NOT_CHECKED,
    ...(createModeCaveat !== undefined ? [createModeCaveat] : []),
  ].join("\n");
}

/**
 * Final review (Important 1): ALWAYS calls the real `buildDoctorDeps` — never a swappable
 * top-level resolver. R51 review round 1 found and reverted exactly that shape on
 * `forceResetLeaseFromCli` (`deps.resolveConfig ?? resolveForceResetLeaseConfig`): a test could
 * pin "calls whatever it was handed" while the REAL production default, reached by every actual
 * invocation via `main()`'s bare call, stayed completely unpinned. The fix kept there — and the
 * one repeated here — is injection ONE LAYER DEEPER: the low-level I/O seams `buildDoctorDeps`
 * itself already accepts (`fetchFn`/`quarantineDir`/`alToolPaths`/`makeEnvToolClient`), threaded
 * through unchanged, so a test exercises the REAL `buildDoctorDeps` and the real `renderDoctorReport`/
 * exit-code logic, with only the network/filesystem swapped out underneath it.
 */
export async function doctorFromCli(
  parsed: DoctorCliConfig,
  deps: {
    readonly quarantineDir?: string;
    readonly alToolPaths?: typeof defaultAlToolPaths;
    readonly fetchFn?: FetchFn;
    readonly makeEnvToolClient?: (cfg: EnvToolConfigSection) => EnvToolClient;
  } = {},
): Promise<number> {
  const configFile = await loadLethalConfigFile(parsed.configPath);
  const {
    cfg,
    deps: doctorDeps,
    createModeCaveat,
  } = await buildDoctorDeps(configFile, {
    ...(parsed.projectDir !== undefined ? { projectDir: parsed.projectDir } : {}),
    ...(deps.quarantineDir !== undefined ? { quarantineDir: deps.quarantineDir } : {}),
    ...(deps.alToolPaths !== undefined ? { alToolPaths: deps.alToolPaths } : {}),
    ...(deps.fetchFn !== undefined ? { fetchFn: deps.fetchFn } : {}),
    ...(deps.makeEnvToolClient !== undefined ? { makeEnvToolClient: deps.makeEnvToolClient } : {}),
  });
  const report = await runDoctor(cfg, doctorDeps);
  console.log(renderDoctorReport(report, createModeCaveat));
  return report.ok ? 0 : 1;
}

/**
 * `lethal explain <report.json>` — reads the file, refuses anything that is not an explainable
 * report (`assertExplainableReport`, R113), and prints the projection as JSON.
 *
 * JSON and not a rendered table: the projection IS the artifact, its structure is the versioned
 * contract (`EXPLAIN_SCHEMA_VERSION`), and a second prose surface would be a second place for the
 * meanings to drift — `renderConsole` already exists for the run itself. Pretty-printed so a human
 * reading it in a terminal is not the loser.
 *
 * Every failure throws: a malformed report exits 1 through `main`'s catch, with
 * `MalformedReportError`'s own message. There is no "explained what it could" path, deliberately —
 * see `assertExplainableReport`.
 */
export async function explainFromCli(parsed: ExplainCliConfig): Promise<number> {
  let raw: string;
  try {
    raw = await readFile(parsed.reportPath, "utf8");
  } catch (err) {
    throw new Error(
      `explain: could not read ${parsed.reportPath} — ${err instanceof Error ? err.message : String(err)}. Pass the JSON report a run wrote with --out.`,
    );
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `explain: ${parsed.reportPath} is not valid JSON — ${err instanceof Error ? err.message : String(err)}.`,
    );
  }
  console.log(JSON.stringify(explain(assertExplainableReport(parsedJson)), null, 2));
  return 0;
}

/**
 * What `performForceResetLease` (design §8 step 2) reports back: a real reset (with the old and
 * new generation, and the new epoch), or a well-formed refusal — the generation read live from
 * `HarnessInfo` no longer matched the row's current one by the time the reset actually ran (a
 * concurrent recovery/reset raced this one). Never thrown for the refusal case; the CLI wrapper
 * decides how to report each outcome.
 */
export type ForceResetLeaseResult =
  | {
      readonly outcome: "reset";
      readonly oldGeneration: string;
      readonly newGeneration: string;
      readonly newEpoch: number;
    }
  | { readonly outcome: "refused"; readonly oldGeneration: string; readonly reason: string };

/**
 * The actual read-then-reset mechanics behind `lethal force-reset-lease` (design §8 step 2 of
 * the operator recovery procedure — restart the NST, THIS, a clean-state probe, `lethal
 * clear-quarantine`; see fixtures/README.md's "Recovering from container-needs-recycle").
 *
 * Reads the CURRENT `serverGeneration` live via `HarnessVerifier.verify()` (`HarnessInfo
 * (clientProtocol: 2)`), then echoes EXACTLY that value into `LeaseClient.forceResetLease` —
 * `ForceResetLease`'s whole authorization is that echo (replay protection across resets,
 * `ControlState.Codeunit.al`'s `TryForceResetLease` doc comment), so this must NEVER accept a
 * caller-supplied or cached generation; the only way to obtain one here is this live read.
 *
 * Kept separate from `forceResetLeaseFromCli` below — like `clearQuarantine`/
 * `clearQuarantineFromCli` above — so this, the actual read-then-reset logic, is directly
 * unit-testable against an injected `fetchFn`, without touching a real config file or
 * `process.argv`.
 */
export async function performForceResetLease(
  cfg: ActivationConfig,
  fetchFn: FetchFn = fetch,
): Promise<ForceResetLeaseResult> {
  const { serverGeneration } = await new HarnessVerifier(cfg, fetchFn).verify();
  const resetOutcome = await new LeaseClient(cfg, fetchFn).forceResetLease(serverGeneration);
  if (resetOutcome.reset) {
    return {
      outcome: "reset",
      oldGeneration: serverGeneration,
      newGeneration: resetOutcome.serverGeneration,
      newEpoch: resetOutcome.epoch,
    };
  }
  return { outcome: "refused", oldGeneration: serverGeneration, reason: resetOutcome.reason };
}

/**
 * force-reset-lease's own envTool resolution. Before this existed, `forceResetLeaseFromCli` called
 * `validateBcDevConfig(configFile.bcdev)` DIRECTLY — which throws on an envTool config, because
 * `server`/`serverInstance`/`username`/`password` are legitimately absent from the file on disk
 * (the tool supplies them at runtime). Every recovery against a hosted Layer-6C environment needed
 * a hand-materialised copy of the config with those fields injected —
 * `.claude/skills/recover-tier`'s bundled `materialize-config.ts` (now deleted) existed only to
 * paper over this; before THAT script existed, a real campaign paid for the gap with a manual,
 * mid-recovery python-injection step. The fix belongs in the tool, not in a skill's workaround
 * script.
 *
 * Mirrors `buildDoctorDeps`'s `resolvedBcdev` (R109) rather than re-deriving the algorithm: the
 * SAME `validateEnvToolConfig`/`requireBcDevRawFields` calls, the SAME `splitBaseUrl`/
 * `deriveMcpPort` derivation (env-tool-session.ts, exported for exactly this reuse), and the SAME
 * `validateBcDevConfig` on the assembled result — never a second, hand-rolled parse that could
 * drift from what `run` accepts.
 *
 * Deliberately NOT `resolveEnvToolSession`: its own doc comment (above, `cli.ts:246`) says it "can
 * provision a real, billed Layer-6C environment" — create-mode's `createEnv`/`startEnv`. A
 * recovery command is reached for AFTER a session already died and left a tier stranded; it must
 * never be able to spend money or mutate infrastructure as a side effect of resolving a config at
 * the exact moment an operator is trying to clean up. This function spawns ONLY the configured
 * `envTool.resolve` blocks — the identical hard boundary `buildDoctorDeps` documents as its own
 * constraint 4 — and its body never references `startEnvToolSession`, `createEnv`, `startEnv`,
 * `publish` or `downloadSymbols`.
 */
export async function resolveForceResetLeaseConfig(
  configFile: LethalConfigFile,
  opts: {
    readonly projectDir?: string;
    readonly makeEnvToolClient?: (cfg: EnvToolConfigSection) => EnvToolClient;
  } = {},
): Promise<BcDevConfigSection> {
  if (configFile.envTool === undefined) return validateBcDevConfig(configFile.bcdev);

  const bcdevRaw = configFile.bcdev ?? {};
  const bcdevDeclaredKeys = (READS_KEYS as readonly string[]).filter((key) => {
    const v = (bcdevRaw as Record<string, unknown>)[key];
    return typeof v === "string" && v !== "";
  });
  // SAME validator `run`/`buildDoctorDeps` use — a malformed envTool section throws here
  // identically to both.
  const envCfg = validateEnvToolConfig(configFile.envTool, {
    env: process.env,
    hasPackageCachePath: Boolean(bcdevRaw.packageCachePath),
    bcdevDeclaredKeys,
  });
  // Fails fast on the three fields the env tool itself can never supply — the SAME check
  // `startEnvToolSession` runs as its very first statement and `buildDoctorDeps` runs identically.
  requireBcDevRawFields(bcdevRaw);

  const makeClient =
    opts.makeEnvToolClient ??
    ((cfg: EnvToolConfigSection) => new EnvToolClient(cfg, undefined, opts.projectDir));
  const client = makeClient(envCfg);
  const supplied: Record<string, string> = {
    envId: envCfg.envId ?? "",
    projectDir: opts.projectDir ?? "",
    testDir: "",
    runId: "force-reset-lease",
  };
  // The hard read-only boundary: ONLY `resolve` blocks are ever run here.
  const resolved: Record<string, string> = {};
  for (const [i, block] of (envCfg.resolve ?? []).entries()) {
    Object.assign(resolved, await client.run(block, `resolve[${i}]`, supplied));
  }

  const baseUrl = resolved.baseUrl;
  if (baseUrl === undefined) throw new EnvToolError("envTool.resolve produced no baseUrl");
  const { server, serverInstance } = splitBaseUrl(
    baseUrl,
    resolved.server,
    resolved.serverInstance,
  );
  const port = deriveMcpPort(baseUrl);
  const username = resolved.username;
  const password = resolved.password;
  if (username === undefined || password === undefined) {
    throw new EnvToolError("envTool.resolve produced no username/password");
  }
  // See `packageCachePathDefault`'s doc comment — this recovery command never compiles or
  // publishes, so the value is never dereferenced on this path, but `validateBcDevConfig`'s shared
  // shape still requires it.
  const packageCachePath = packageCachePathDefault(bcdevRaw, opts.projectDir);
  return validateBcDevConfig({
    ...bcdevRaw,
    baseUrl,
    server,
    serverInstance,
    port,
    username,
    password,
    packageCachePath,
  });
}

/**
 * `lethal force-reset-lease --server ... --instance ... --config ...` (design §8 step 2). Reads
 * the bcdev credentials (company/username/password/tenant) from the SAME config file `lethal
 * run` uses — via `resolveForceResetLeaseConfig`, which resolves an envTool config the same
 * read-only way `lethal doctor` does (see that function's doc comment) — but the operator's
 * `--server`/`--instance` flags — not whatever the config file's own `bcdev.server`/
 * `bcdev.serverInstance` happen to hold — pick the target, mirroring `clear-quarantine`'s identity
 * source: an operator recovering a specific wedged container names it explicitly, rather than
 * trusting a possibly shared/stale config file to point at the right one.
 *
 * This is a recovery tool that clears safety state (the op marker, the committed active-mutant
 * row, and every outstanding lease credential) — it prints exactly what it is about to reset
 * BEFORE doing it, and (via `performForceResetLease`) never accepts a generation from anywhere
 * but a live `HarnessInfo` read.
 *
 * `deps` is deliberately narrower than `runFromCli`'s own `deps.resolveEnvToolSession`/
 * `deps.buildBackend` seam: it does NOT let a caller swap out `resolveForceResetLeaseConfig`
 * itself (that was round 1's shape, and review caught that it let a test pin "calls whatever it
 * was handed" while leaving the actual PRODUCTION default — `deps.resolveConfig ??
 * resolveForceResetLeaseConfig`, reached by every real invocation via `main()`'s bare
 * `forceResetLeaseFromCli(parsed)` — completely unpinned; reverting the default to the pre-fix
 * `validateBcDevConfig(configFile.bcdev)` passed the whole suite). This command ALWAYS calls the
 * real `resolveForceResetLeaseConfig`; only HOW it talks to the env tool (`makeEnvToolClient`) and
 * HOW it talks to BC (`fetchFn`) are injectable, so a test exercises the genuine resolution
 * algorithm — including its own default `EnvToolClient` construction — end to end.
 */
export async function forceResetLeaseFromCli(
  parsed: ForceResetLeaseCliConfig,
  deps: {
    readonly makeEnvToolClient?: (cfg: EnvToolConfigSection) => EnvToolClient;
    readonly fetchFn?: FetchFn;
  } = {},
): Promise<number> {
  const configFile = await loadLethalConfigFile(parsed.configPath);
  const c = await resolveForceResetLeaseConfig(configFile, {
    ...(parsed.projectDir !== undefined ? { projectDir: parsed.projectDir } : {}),
    ...(deps.makeEnvToolClient !== undefined ? { makeEnvToolClient: deps.makeEnvToolClient } : {}),
  });
  const odataCfg = {
    // R51: honours an explicit `bcdev.baseUrl` (the env-tool case — a path-routed HTTPS endpoint on
    // 443, which port-7048 injection can never reach), and refuses one that names a different tier
    // than --instance. See `recoveryBaseUrl`.
    baseUrl: recoveryBaseUrl(parsed.server, parsed.serverInstance, c.baseUrl),
    company: c.company,
    username: c.username,
    password: c.password,
    ...(c.tenant !== undefined ? { tenant: c.tenant } : {}),
  };

  console.log(
    `force-reset-lease: about to reset the "LC Lease" row on ${parsed.server} / ${parsed.serverInstance} (company "${c.company}") — this clears any op marker, bumps Epoch, mints a new Server Generation, and clears the committed "LC Mutation Active" row. Every lease credential issued before this reset becomes invalid at every fence.`,
  );

  let result: ForceResetLeaseResult;
  try {
    result = await performForceResetLease(odataCfg, deps.fetchFn ?? fetch);
  } catch (err) {
    throw new Error(
      `force-reset-lease: could not complete the reset — the HarnessInfo/ForceResetLease call failed. Is the "LethAL Control" extension deployed and the NST at ${parsed.server}/${parsed.serverInstance} reachable? If you have not already, restart the NST/container first (design §8 step 1), then retry. Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (result.outcome === "refused") {
    throw new Error(
      `force-reset-lease: server refused the reset (reason: "${result.reason}") — the serverGeneration ${result.oldGeneration} read just before the reset no longer matched the row's current one by the time the reset ran, meaning something changed it in between (another session's own recovery, or a concurrent reset). Just re-run this command — it always reads the CURRENT generation fresh, so a retry is safe.`,
    );
  }

  console.log(
    `force-reset-lease: reset OK — serverGeneration ${result.oldGeneration} -> ${result.newGeneration}, epoch -> ${result.newEpoch}. The committed "LC Mutation Active" row was cleared. Next: run a clean-state probe against the container, then \`lethal clear-quarantine --server ${parsed.server} --instance ${parsed.serverInstance}\`.`,
  );
  return 0;
}

/** R49: the release version, bundled at build time — see the import at the top of this file. */
export const LETHAL_VERSION: string = rootPackageJson.version;

async function main(): Promise<number> {
  const parsed = parseCliConfig(process.argv.slice(2));
  if (parsed.mode === "help") {
    console.log(helpText(LETHAL_VERSION));
    return 0;
  }
  if (parsed.mode === "version") {
    console.log(LETHAL_VERSION);
    return 0;
  }
  if (parsed.mode === "dry-run") {
    await printDryRun(parsed.projectDir, parsed.only, {
      dbPath: parsed.dbPath,
      configPath: parsed.configPath,
    });
    return 0;
  }
  if (parsed.mode === "clear-quarantine") {
    return await clearQuarantineFromCli(parsed);
  }
  if (parsed.mode === "clear-ceiling") {
    return await clearCeilingFromCli(parsed);
  }
  if (parsed.mode === "force-reset-lease") {
    return await forceResetLeaseFromCli(parsed);
  }
  if (parsed.mode === "doctor") {
    return await doctorFromCli(parsed);
  }
  if (parsed.mode === "explain") {
    return await explainFromCli(parsed);
  }
  const report = await runFromCli(parsed);
  console.log(renderConsole(report));
  if (parsed.outPath !== undefined) await writeJsonReport(report, parsed.outPath);
  return report.quarantined !== undefined ? QUARANTINED_EXIT_CODE : 0;
}

if (import.meta.main) {
  main()
    .then((exitCode) => {
      process.exit(exitCode);
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? (err.stack ?? String(err)) : String(err));
      process.exit(1);
    });
}
