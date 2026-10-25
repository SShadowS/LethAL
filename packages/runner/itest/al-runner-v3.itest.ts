/**
 * R586: `itest:alrunner-v3`, the gate of the al-runner-v3 backend (the Rust al-runner, pinned
 * alpha.2). Plan `docs/superpowers/plans/2026-10-21-r586-alrunner-v3-backend.md` §11-§12; every
 * figure is pre-committed in `docs/superpowers/specs/2026-10-21-r586-alrunner-v3-precommitment.md`
 * (dcdd1489), leg X (d) by its r5 delta
 * `docs/superpowers/specs/2026-10-21-r586-alrunner-v3-precommitment-r5-xd.md` (abe76fa6), leg C's
 * clock facts and X (d)'s baseline by r6
 * `docs/superpowers/specs/2026-10-21-r586-alrunner-v3-precommitment-r6.md` (c7c505e6), and X (d)'s
 * scratch setup by r5a
 * `docs/superpowers/specs/2026-10-21-r586-alrunner-v3-precommitment-r5a-xd-setup.md` (f32aa92a).
 * A differing verdict, killing test, note set, refusal set or Sleep index size is a BLOCK.
 *
 *   LETHAL_ITEST_ALRUNNER_V3=1 bun run itest:alrunner-v3
 *
 * Environment:
 * - `LETHAL_ALRUNNER_V3_PATH`: the binary (default `/work/tools/al-runner-v3/current/al-runner`).
 * - `LETHAL_ALRUNNER_V3_CANDIDATE=1`: the update gate's ungated candidate (relaxes the `.gated` check).
 * - `LETHAL_ALRUNNER_V3_CACHE`: `ALRUNNER_CACHE` (default `/work/tools/al-runtime-rs/cache`, the
 *   cache every R586 measurement used, so the gate runs on the artifacts the pre-commitment
 *   measured; lane ruling 2026-10-21. `/work/tools/al-runner-v3/cache` is unused).
 * - `LETHAL_ALC_DIR`: the folder holding `alc`.
 * - `LETHAL_ITEST_V3_LEGS=C,S1,...`: a subset (default every leg that is configured: C, S1, S1E,
 *   S3, N1, N1E, X, L1, Y-A, Y-B, MO, WR, K, then D1, D1c and T when configured). R761: S1E is S1's
 *   project and assertions under serve-entries by construction; on a build with no serve path it
 *   reads "not applicable" (pass). Its serve counters are printed, pinned after the R-761 observe run.
 * - `LETHAL_ITEST_V3_CDO=<Continia Document Output checkout at 5f2a71d>`: the D legs (a corpus job).
 * - `LETHAL_ITEST_V3_TABLES=1`: leg T (the update gate's tables leg).
 * - `LETHAL_V3_GATE_NONCE` + `LETHAL_V3_GATE_RECEIPT`: write the update gate's receipt.
 * - R635 (all unset: the gate is unchanged): `LETHAL_ITEST_V3_TRANSPORT=one-shot|serve-entries`,
 *   `LETHAL_ITEST_V3_SECOND_ECHO=0|1` (serve-entries only), refused by name otherwise
 *   (`v3ItestTransport`); `LETHAL_ITEST_V3_REPORT_DIR=<dir>` writes each session's report as
 *   `<dir>/<leg>.report.json` before any assertion; `LETHAL_ITEST_V3_CONTROL_DIR=<dir>` first
 *   compares each session per mutant with `<dir>/<leg>.report.json` (the edge one-shot control).
 * - R586c: a build with a per-build pin (`al-runner-v3-pins.ts`, matched on the exact version line
 *   AND sha256) is judged against it; the first line says so. `LETHAL_ITEST_V3_K_ON_CANDIDATE=1`
 *   runs K on a candidate build (K stays outside `V3_GATE_LEGS`). A record request on a pinned or
 *   candidate build is refused.
 * No leg needs a BC server.
 */
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { appendFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTROL_REGISTER_FILENAME,
  CONTROL_UPGRADE_FILENAME,
  IDENTITY_SCHEME,
  emitStaticSelector,
} from "@lethal/schemata";
import { type ServerSpawnFn, defaultServerSpawn } from "../src/al-runner-server";
import {
  AlRunnerV3Backend,
  type AlRunnerV3Config,
  AlRunnerV3ResourceSelectorRefusedError,
  AlRunnerV3UnprovenBatchError,
  V3_REFUSED_NEARBY_TAG,
  V3_STATE_NOTE_TAG,
} from "../src/al-runner-v3-backend";
import { AL_RUNNER_V3_NOT_AUTHORITATIVE } from "../src/al-runner-v3-config";
import { runV3ContractProbe, v3DefectWarnings } from "../src/al-runner-v3-contract";
import { AL_RUNNER_V3_DEFAULT_PATH, sha256OfFile } from "../src/al-runner-v3-pin";
import { type V3BuildPin, findV3Pin } from "../src/al-runner-v3-pins";
import { SLEEP_NOTE_TAG } from "../src/al-runner-v3-sleep";
import { AlcCompileError, ArtifactCompiler, defaultArtifactIo } from "../src/artifact";
import { buildBackend } from "../src/cli";
import type { EventSubscriber } from "../src/events";
import { formatFailure } from "../src/format-failure";
import { BASELINE_TIMEOUT_DEFAULT, type SessionConfig, runSession } from "../src/orchestrator";
import { effectiveBuildSymbols } from "../src/preprocessor-symbols";
import { type SpawnFn, defaultSpawn } from "../src/publisher";
import type { MutantOutcome, SessionReport } from "../src/report";
import { ResultsStore } from "../src/store";
import {
  CDO_SLICE_FILE,
  V3LegEnvironment,
  V3LegFailure,
  V3LegHeld,
  type V3LegOutcome,
  V3_DEFECT_FACTS,
  V3_LEG_C_FACTS,
  V3_WARN_FACTS,
  type XdBaselineVerdict,
  cdoCheckoutRefusal,
  classifyLegC,
  classifyLegT,
  classifyXb,
  dirtyFromStatus,
  failsClosedRefusal,
  judgeLegT,
  knownDifferencesRefusal,
  legCFactLine,
  legOutcomeOfError,
  observeWithReceiptRefusal,
  recordRefusal,
  v3ItestTransport,
  v3ReceiptOutcome,
  v3SplitLine,
  writeV3Receipt,
  xbHeldFirst,
  xdBaselineLine,
  xdFailure,
} from "./al-runner-v3-gate";
import { TABLES_KNOWN_DIFFERENCES } from "./al-runner-v3-tables-known";
import {
  type N1EReading,
  type V3RowFacts,
  V3_K_CANDIDATE_SKIP,
  V3_K_LEG,
  V3_MO_KILLERS,
  V3_N1E_LEG,
  V3_S1E_LEG,
  V3_WR_KILLERS,
  V3_WR_STATE_NOTES,
  isNoServeRefusal,
  isSessionTestCall,
  judgeKillers,
  judgeLegK,
  judgeN1Serve,
  judgeStateNotes,
  judgeWrArms,
  legKSection,
  moWrTransportRefusal,
  v3DefaultLegs,
  v3ItestFailures,
  v3KOnCandidate,
  v3RecordRunFailures,
} from "./alrunner-v3-legs";
import {
  BaselineRecordedError,
  assertGateBaseline,
  preflightGateBaseline,
  readGateBaseline,
  recordRequested,
} from "./baseline-guard";
import { prepareFixtureSymbols } from "./fixture-symbols";
import { emitFailed, emitPassed, emitSkipped } from "./gate-receipt";
import {
  checkGateWarnings,
  collectWarnings,
  finishGate,
  gateEndLine,
  isGateWarningsError,
  nonPassExit,
  observeRequested,
  preflightObserve,
  settleThrown,
} from "./gate-warnings";
import {
  LAYOUT_MAX_GUARDS,
  LAYOUT_PROJECT_DIR,
  LAYOUT_SELECTOR_IDS,
  LAYOUT_TEST_DIR,
  assertLayoutRun,
  printLayoutTable,
} from "./layout-fixture";
import { compareMutants, keyOf, normalizeForComparison } from "./mutant-equality";
import { assertSymbolBuild, printSymbolTable } from "./symbol-fixture";
import {
  ARMS_REFUSAL,
  WRAPPED_PROJECT_DIR,
  WRAPPED_SELECTOR_IDS,
  WRAPPED_SYMBOLS,
  WRAPPED_TEST_DIR,
} from "./wrapped-fixture";

if (!process.env.LETHAL_ITEST_ALRUNNER_V3) {
  console.log("al-runner-v3 itest: skipped (set LETHAL_ITEST_ALRUNNER_V3=1)");
  // R654 S2: an agentflow-challenged skip is a failed receipt, never a pass (R223).
  const challenged = await emitSkipped("alrunner-v3", "the leg's env var is unset");
  process.exit(challenged ? 1 : 0);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const TABLES_BASELINE_PATH = join(HERE, "al-runner-v3.tables.baseline.json");
// R654 S2: legs L1, Y-A and Y-B (pre-commitment 43115c78), each recorded once under R332.
const LAYOUT_BASELINE_PATH = join(HERE, "al-runner-v3.layout.baseline.json");
const SYMBOLS_A_BASELINE_PATH = join(HERE, "al-runner-v3.symbols-lethala.baseline.json");
const SYMBOLS_B_BASELINE_PATH = join(HERE, "al-runner-v3.symbols-lethalb.baseline.json");
// R602: legs MO (multi-object files) and WR (`#if`-wrapped files), each recorded once under R332.
const MULTIOBJECT_BASELINE_PATH = join(HERE, "al-runner-v3.multiobject.baseline.json");
const WRAPPED_BASELINE_PATH = join(HERE, "al-runner-v3.wrapped.baseline.json");
const BIN = process.env.LETHAL_ALRUNNER_V3_PATH ?? AL_RUNNER_V3_DEFAULT_PATH;
const CANDIDATE = process.env.LETHAL_ALRUNNER_V3_CANDIDATE === "1";
/** R586c: run K on a candidate build too (the CLI-built backend gets the test-only seam). */
const K_ON_CANDIDATE = v3KOnCandidate(process.env);
/** R586c: the per-build pin of the binary under test, set in `main` once its version and sha are known. */
let activePin: V3BuildPin | undefined;
const CACHE = process.env.LETHAL_ALRUNNER_V3_CACHE ?? "/work/tools/al-runtime-rs/cache";
const ALC = join(process.env.LETHAL_ALC_DIR ?? "", "alc");
const CDO = process.env.LETHAL_ITEST_V3_CDO;
const TABLES = process.env.LETHAL_ITEST_V3_TABLES === "1";
/** R635: `{}` unless the transport flags are set (`v3ItestTransport`). */
const TRANSPORT = v3ItestTransport(process.env);
const REPORT_DIR = process.env.LETHAL_ITEST_V3_REPORT_DIR;
const CONTROL_DIR = process.env.LETHAL_ITEST_V3_CONTROL_DIR;
const SANDBOX_BC = "28.0.46665.47126";
const CDO_BC = "28.4.53241.53758";
const fixture = (n: string) => join(REPO, "fixtures", n);
/** r10 (c): X (d)'s baseline stop. The leg sets no `baselineTimeoutMs`, so the default applies. */
const BASELINE_STOP_S = Math.ceil(BASELINE_TIMEOUT_DEFAULT / 1000);
const PROBE = join(REPO, "scripts", "r586-probe");

// R654 S2: L1, Y-A, Y-B and K join the default set (`v3DefaultLegs`). On a candidate build K is
// skipped with its stated summary (`V3_K_CANDIDATE_SKIP`), never silently.
const configured = v3DefaultLegs({ cdo: CDO !== undefined, tables: TABLES });
const LEGS = (process.env.LETHAL_ITEST_V3_LEGS ?? configured.join(","))
  .split(",")
  .map((s) => s.trim());

/** Oracle server BC builds, recorded beside v3's `--bc-version` (F8). */
const ORACLE_BC_BUILD: Record<string, string> = {
  S1: "bc1 BC 28.4.53241.56590 W1 (bcdev.baseline.json reproduced live, cited)",
  S1E: "bc1 BC 28.4.53241.56590 W1 (bcdev.baseline.json reproduced live, cited)",
  N1: "bc1 BC 28.4.53241.56590 W1 (bcdev.names.baseline.json reproduced live, cited)",
  D1: "bc3 BC 28.4 W1, Microsoft apps 28.4.53241.56646 (docs/measurements/r594/bc3-A)",
  D1c: "bc3 BC 28.4 W1, Microsoft apps 28.4.53241.56646 (docs/measurements/r594/bc3-B)",
  T: "none (own baseline; BC cross-check suspended)",
};

/** A pre-committed figure differs (gate-fail); `V3LegEnvironment` is the environment (infra-fail, M2). */
const LegFailure = V3LegFailure;
const must = (cond: boolean, what: string): void => {
  if (!cond) throw new LegFailure(what);
};

/** The Microsoft apps of sandbox-tests' `.alpackages` (no LethAL copy): `<deps>` for names and the probes. */
async function microsoftDeps(scratch: string): Promise<string> {
  const dir = join(scratch, "ms-deps");
  await mkdir(dir, { recursive: true });
  const src = join(fixture("sandbox-tests"), ".alpackages");
  for (const f of await readdir(src)) {
    if (f.startsWith("Microsoft_")) await cp(join(src, f), join(dir, f));
  }
  return dir;
}

function backendCfg(
  o: Partial<AlRunnerV3Config> &
    Pick<
      AlRunnerV3Config,
      "instrumentedDir" | "testDir" | "packagesDir" | "bcVersion" | "selectorObjectId"
    >,
): AlRunnerV3Config {
  return {
    alRunnerPath: BIN,
    alcPath: ALC,
    cacheDir: CACHE,
    coverage: "al-runner",
    ...(CANDIDATE ? { candidate: true } : {}),
    ...TRANSPORT,
    ...o,
  };
}

/** r9 §2: this leg's sessions' `unlike-bc` warnings, drained into the receipt after each leg. */
const sessionUnlikeBc: string[] = [];

async function session(
  scratch: string,
  backend: AlRunnerV3Backend,
  cfg: Pick<SessionConfig, "projectDir" | "testDir" | "selectorIds"> & Partial<SessionConfig>,
  onEvent?: EventSubscriber,
): Promise<SessionReport> {
  const store = new ResultsStore(join(scratch, "lethal.sqlite"));
  let r: SessionReport;
  // R651: the orchestrator's phase walls, summed per phase, for the split line (timing only).
  const phases: Record<string, number> = {};
  const gateWarnings = collectWarnings();
  try {
    r = await runSession({
      backend,
      store,
      instrumentedDir: join(scratch, "instr"),
      ...cfg,
      emit: [
        gateWarnings.subscriber,
        (e) => {
          if (e.type === "warning") console.log(`  warn ${e.code}: ${e.message.slice(0, 300)}`);
          if (e.type === "phase-left") phases[e.phase] = (phases[e.phase] ?? 0) + e.elapsedMs;
        },
        ...(onEvent !== undefined ? [onEvent] : []),
      ],
    });
  } catch (e) {
    // R736 rule: the session's own error wins; its codes are printed, never asserted.
    settleThrown("al-runner-v3", basename(scratch), gateWarnings);
    throw e;
  } finally {
    store.close();
    await backend.close();
    // r9 §2 (R639): a candidate session warns on `unlike-bc` instead of refusing; the warning goes
    // into the receipt under EVERY leg that ran under it, so the D figures are read knowing it.
    const c = backend.contractResult();
    if (c !== undefined)
      sessionUnlikeBc.push(
        ...v3DefectWarnings(c, { candidate: CANDIDATE }).filter((l) =>
          l.includes("al-runner-v3-defect-unlike-bc"),
        ),
      );
  }
  // R635: all of it only when a flag asks, so the unflagged gate is unchanged.
  const leg = basename(scratch);
  checkGateWarnings("al-runner-v3", leg, gateWarnings);
  if (TRANSPORT.transport !== undefined) {
    console.log(`  ${leg}: entries ${JSON.stringify(backend.entriesStats())}`);
    console.log(`  ${leg}: ${v3SplitLine(phases, backend.entriesStats())}`);
  }
  if (TRANSPORT.transport !== undefined || REPORT_DIR !== undefined) {
    console.log(`  ${leg}: timings ${JSON.stringify(r.timings)}`);
  }
  if (REPORT_DIR !== undefined) {
    await mkdir(REPORT_DIR, { recursive: true });
    await writeFile(join(REPORT_DIR, `${leg}.report.json`), `${JSON.stringify(r, null, 2)}\n`);
  }
  if (CONTROL_DIR !== undefined) {
    const control = join(CONTROL_DIR, `${leg}.report.json`);
    must(
      existsSync(control),
      `al-runner-v3-itest-control-missing: ${control} (run the edge one-shot control first)`,
    );
    await assertPerMutant(r, control, `${leg} vs the edge one-shot control`);
  }
  return r;
}

const counts = (r: SessionReport) =>
  `${r.counts.killed} / ${r.counts.survived} / ${r.counts.noCoverage} (errors ${r.counts.errors}, timeout-killed ${r.counts.timeoutKilled})`;
const tagged = (r: SessionReport, tag: string) =>
  r.mutants
    .filter((m) => (m.failureNote ?? "").startsWith(tag))
    .map((m) => `${m.batchIndex}/${m.mutantCode}`)
    .sort();
const refusedCause = (r: SessionReport) =>
  r.mutants
    .filter((m) => m.cause === "runner-refused" || m.cause === "runner-test-error")
    .map((m) => `${m.batchIndex}/${m.mutantCode}`);

/** Every kill reproduced (R577), and none `kill-not-reproduced`. */
function assertReproduced(r: SessionReport, leg: string): void {
  const kills = r.mutants.filter((m) => m.verdict === "killed" || m.verdict === "timeout-killed");
  const bare = kills.filter((m) => m.killReproduced !== true).map((m) => m.mutantCode);
  must(bare.length === 0, `${leg}: kills without killReproduced: ${bare.join(", ")}`);
  const nr = r.mutants.filter((m) => m.cause === "kill-not-reproduced").map((m) => m.mutantCode);
  must(nr.length === 0, `${leg}: kill-not-reproduced: ${nr.join(", ")}`);
}

/** Per mutant against an oracle (gate baseline or report): 0 differences. */
async function assertPerMutant(r: SessionReport, oraclePath: string, leg: string): Promise<void> {
  const raw = JSON.parse(await readFile(oraclePath, "utf8")) as { mutants?: unknown };
  const now = normalizeForComparison(r);
  let cmp: ReturnType<typeof compareMutants>;
  if (Array.isArray(raw.mutants)) {
    const o = raw as unknown as SessionReport;
    cmp = compareMutants(normalizeForComparison(o), now, {
      sameScheme: o.identityScheme === r.identityScheme,
    });
  } else {
    const base = await readGateBaseline(oraclePath);
    cmp = compareMutants(base.entries, now, {
      sameScheme: base.identityScheme === r.identityScheme,
    });
  }
  console.log(
    `  ${leg}: vs ${oraclePath}: ${cmp.differences.length} difference(s), text verified ${cmp.textVerified}, unverified ${cmp.textUnverified}`,
  );
  for (const d of cmp.differences) console.log(`    - ${d}`);
  must(
    cmp.differences.length === 0,
    `${leg}: ${cmp.differences.length} per-mutant difference(s) from ${oraclePath}`,
  );
}

function assertCounts(
  r: SessionReport,
  leg: string,
  k: number,
  s: number,
  n: number,
  total: number,
): void {
  console.log(`  ${leg}: ${counts(r)} over ${r.mutants.length}`);
  must(
    r.counts.killed === k &&
      r.counts.survived === s &&
      r.counts.noCoverage === n &&
      r.mutants.length === total,
    `${leg}: ${counts(r)} over ${r.mutants.length}, pre-committed ${k} / ${s} / ${n} over ${total}`,
  );
}

function assertIndex(b: AlRunnerV3Backend, leg: string, target: number, test: number): void {
  const s = b.sleepIndexSize();
  console.log(`  ${leg}: Sleep index ${s?.target} + ${s?.test}`);
  must(
    s?.target === target && s.test === test,
    `${leg}: Sleep index ${JSON.stringify(s)}, pre-committed ${target} + ${test}`,
  );
}

// ---------------------------------------------------------------------------------------------

/** R612 M-2: leg C's warn-fact readings, for the receipt. */
let legCWarnFacts: Record<string, string> | undefined;

/** Returns the warn lines (R612 `serve-keep-reasons`) of a passing leg, for the receipt. */
async function legC(scratch: string): Promise<readonly string[]> {
  // R667 (r12): `message-has-no-type-prefix`'s Assert half needs Microsoft's Library Assert, which
  // only the tables fixture's packages hold. Absent, the fact reads unmeasurable (infra-fail).
  const dataPkgs = join(fixture("sandbox-data-tests"), ".alpackages");
  const assertApps = (await readdir(dataPkgs)).filter((f) =>
    f.startsWith("Microsoft_Library Assert_"),
  );
  const [libraryAssert] = assertApps;
  const r = await runV3ContractProbe({
    alRunnerPath: BIN,
    expectedVersion: (execFileSync(BIN, ["--version"], { encoding: "utf8" }) as string).trim(),
    packagesDir: await microsoftDeps(scratch),
    bcVersion: SANDBOX_BC,
    alcPath: ALC,
    cacheDir: CACHE,
    tasksetPath: "/usr/bin/taskset",
    ...(assertApps.length === 1 && libraryAssert !== undefined
      ? { libraryAssertApp: join(dataPkgs, libraryAssert) }
      : {}),
  });
  // F4 (R639): the measured rows whole, so the kept gate.log shows every field.
  for (const f of r.facts) console.log(legCFactLine(f));
  // R612 M-2: the warn readings go into the receipt, and from there into `.gated`.
  legCWarnFacts = Object.fromEntries(
    r.facts.filter((f) => V3_WARN_FACTS.includes(f.fact)).map((f) => [f.fact, f.verdict]),
  );
  // RC-2 (I-2): a defect fact moving to `gone` is held; any diverged is gate-fail. 28 facts (r13,
  // R590: 9 defect, 18 contract, 1 warn); a warn fact (V3_WARN_FACTS) only adds its line.
  const c = classifyLegC(r.facts, V3_DEFECT_FACTS, V3_LEG_C_FACTS, V3_WARN_FACTS, activePin?.legC);
  for (const l of c.lines) console.log(`  C: ${l}`);
  if (c.outcome === "gate-fail") throw new LegFailure(`C: ${c.lines.join("; ")}`);
  if (c.outcome === "infra-fail") throw new V3LegEnvironment(`C: ${c.lines.join("; ")}`);
  if (c.outcome === "held") throw new V3LegHeld(c.lines);
  return c.lines;
}

/**
 * R761: the serve counters R-653 E1 recorded for S1 under entries (P 3; live 3 = 6 - 3; bound 5 =
 * 8 - 3; warm-ups 1; entriesSent 44). NOT asserted yet: S1E prints them, and the numbers below are
 * pinned after the R-761 observe run. Echo mismatches 0 IS asserted (a mismatch is a verdict risk).
 */
const S1E_PENDING_PINS = {
  pairRequests: 3,
  liveRequests: 3,
  boundChecks: 5,
  warmups: 1,
  entriesSent: 44,
} as const;

/** S1 one-shot (`entries` off) or S1E (same project and assertions under serve-entries). */
async function legS1(scratch: string, leg: "S1" | "S1E" = "S1", version = ""): Promise<void> {
  const serve = leg === "S1E";
  const b = new AlRunnerV3Backend(
    backendCfg({
      instrumentedDir: join(scratch, "backend"),
      testDir: fixture("sandbox-tests"),
      packagesDir: join(fixture("sandbox-tests"), ".alpackages"),
      bcVersion: SANDBOX_BC,
      selectorObjectId: 79199,
      ...(serve ? { transport: "serve-entries" as const } : {}),
    }),
  );
  let r: SessionReport;
  try {
    r = await session(scratch, b, {
      projectDir: fixture("sandbox-app"),
      testDir: fixture("sandbox-tests"),
      selectorIds: { selectorId: 79199, controlId: 79198, tableId: 79197 },
    });
  } catch (e) {
    // A build with no serve path refuses `entries` by name: not applicable, as N1E reads it.
    if (serve && !isGateWarningsError(e) && isNoServeRefusal(version, String(e))) {
      console.log("  S1E: not applicable: this build has no serve-entries path");
      return;
    }
    throw e;
  }
  assertCounts(r, leg, 3, 12, 4, 19);
  await assertPerMutant(r, join(HERE, "bcdev.baseline.json"), leg);
  must(
    r.baselineGreen && r.unsupportedTests.length === 0,
    `${leg}: baseline not green or a refused test`,
  );
  must(
    tagged(r, V3_STATE_NOTE_TAG).length === 0,
    `${leg}: state notes ${tagged(r, V3_STATE_NOTE_TAG)}`,
  );
  must(tagged(r, V3_REFUSED_NEARBY_TAG).length === 0, `${leg}: refused-nearby notes`);
  must(
    tagged(r, SLEEP_NOTE_TAG).length === 0 && refusedCause(r).length === 0,
    `${leg}: a §6 or runner refusal`,
  );
  // The Sleep index is built from the deployed source text, not by the transport, so 0 + 0 holds
  // under serve-entries too (backend `deploy` -> `buildSleepIndex`).
  assertIndex(b, leg, 0, 0);
  assertReproduced(r, leg);
  must(
    r.validity.executionContexts.some((c) => c.runnerBuild !== undefined),
    `${leg}: no runnerBuild recorded`,
  );
  if (serve) {
    const s = b.entriesStats();
    // Printed for the R-761 observe run; the pins are not asserted until it has reported them.
    console.log(
      `  S1E: serve counters ${JSON.stringify({
        pairRequests: s.pairRequests,
        liveRequests: s.liveRequests,
        boundChecks: s.boundChecks,
        warmups: s.warmups,
        entriesSent: s.entriesSent,
        echoMismatches: s.echoMismatches,
      })}; E1 (R-653) recorded ${JSON.stringify(S1E_PENDING_PINS)}`,
    );
    must(s.echoMismatches === 0, `S1E: ${s.echoMismatches} echo mismatches, pre-committed 0`);
  }
}

async function legS3(scratch: string): Promise<void> {
  let refused = "";
  try {
    new AlRunnerV3Backend(
      backendCfg({
        instrumentedDir: join(scratch, "backend"),
        testDir: fixture("sandbox-tests"),
        packagesDir: join(fixture("sandbox-tests"), ".alpackages"),
        bcVersion: SANDBOX_BC,
        selectorObjectId: 79199,
        selectorMode: "resource",
      }),
    );
  } catch (err) {
    refused =
      err instanceof AlRunnerV3ResourceSelectorRefusedError ? err.message : `other: ${String(err)}`;
  }
  console.log(`  S3: ${refused}`);
  must(
    refused.startsWith("al-runner-v3-resource-selector-refused"),
    `S3: not refused by name (${refused})`,
  );
}

async function legN1(scratch: string): Promise<void> {
  const deps = await microsoftDeps(scratch);
  const b = new AlRunnerV3Backend(
    backendCfg({
      instrumentedDir: join(scratch, "backend"),
      testDir: fixture("sandbox-names-tests"),
      packagesDir: deps,
      bcVersion: SANDBOX_BC,
      selectorObjectId: 78849,
    }),
  );
  const r = await session(scratch, b, {
    projectDir: fixture("sandbox-names"),
    testDir: fixture("sandbox-names-tests"),
    selectorIds: { selectorId: 78849, controlId: 78848, tableId: 78847 },
  });
  assertCounts(r, "N1", 36, 0, 0, 36);
  await assertPerMutant(r, join(HERE, "bcdev.names.baseline.json"), "N1");
  must(
    r.baselineGreen && r.unsupportedTests.length === 0,
    "N1: baseline not green or a refused test",
  );
  must(
    tagged(r, V3_STATE_NOTE_TAG).length === 0 && tagged(r, V3_REFUSED_NEARBY_TAG).length === 0,
    "N1: notes",
  );
  must(
    tagged(r, SLEEP_NOTE_TAG).length === 0 && refusedCause(r).length === 0,
    "N1: a §6 or runner refusal",
  );
  assertIndex(b, "N1", 0, 0);
  assertReproduced(r, "N1");
}

/**
 * R722 (pre-commitment r19): N1's project under serve-entries, whatever the run's own transport is.
 * The reading is `judgeN1Serve`'s: on alpha.5 the session fails closed by name (#5798); anything
 * else is `held` (re-pre-commit) or `gate-fail`, never a silent pass.
 */
async function legN1E(scratch: string, version: string): Promise<void> {
  const deps = await microsoftDeps(scratch);
  const b = new AlRunnerV3Backend(
    backendCfg({
      instrumentedDir: join(scratch, "backend"),
      testDir: fixture("sandbox-names-tests"),
      packagesDir: deps,
      bcVersion: SANDBOX_BC,
      selectorObjectId: 78849,
      transport: "serve-entries",
    }),
  );
  let reading: N1EReading;
  try {
    await session(scratch, b, {
      projectDir: fixture("sandbox-names"),
      testDir: fixture("sandbox-names-tests"),
      selectorIds: { selectorId: 78849, controlId: 78848, tableId: 78847 },
    });
    reading = { completed: true };
  } catch (e) {
    // R736: the judge sees only the session's own error, never the warning check's.
    if (isGateWarningsError(e)) throw e;
    reading = { threw: e instanceof Error ? e.message : String(e) };
  }
  const j = judgeN1Serve(reading, version);
  for (const l of j.lines) console.log(`  N1E: ${l}`);
  if (j.outcome === "held") throw new V3LegHeld(j.lines);
  if (j.outcome === "gate-fail") throw new LegFailure(j.lines.join("; "));
}

// --- R654 S2: L1, Y-A, Y-B and K (pre-commitment docs/superpowers/specs/2026-10-22-r654-v3-gate-legs-precommitment.md, 43115c78)

/** A pre-committed table's own assertion error is a figure that differs (gate-fail), never infra. */
function asLegFailure(leg: string, check: () => void): void {
  try {
    check();
  } catch (e) {
    throw new LegFailure(`${leg}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** §1's checks every new leg makes: a clean baseline, no note, no refusal, Sleep index 0 + 0. */
function assertCleanLeg(
  r: SessionReport,
  b: AlRunnerV3Backend,
  leg: string,
  /** R602: the leg's pre-committed state notes (`batch/code`); every other leg pre-commits none. */
  stateNotes: readonly string[] = [],
): void {
  must(
    r.baselineGreen && r.unsupportedTests.length === 0,
    `${leg}: baseline not green or a refused test`,
  );
  const stateDiff = judgeStateNotes(tagged(r, V3_STATE_NOTE_TAG), stateNotes);
  must(stateDiff.length === 0, `${leg}: ${stateDiff.join("; ")}`);
  must(tagged(r, V3_REFUSED_NEARBY_TAG).length === 0, `${leg}: refused-nearby notes`);
  must(
    tagged(r, SLEEP_NOTE_TAG).length === 0 && refusedCause(r).length === 0,
    `${leg}: a §6 or runner refusal`,
  );
  assertIndex(b, leg, 0, 0);
  assertReproduced(r, leg);
}

/**
 * L1 (R353's table): multi-batch layout, figures equal v2's. sandbox-layout at maxGuardsPerBatch 7,
 * two batches, EXPECTED_LAYOUT per ref. It is R349's stale-layout check on v3 (R666): v3 reports a
 * target file's coverage in the batch's EMITTED line numbers, so batch 1 must read it through its own
 * coverage index. It proves both index guards together, `resetLayoutState()` clearing the index AND
 * `deploy()` assigning the new one; removing both (L-R3) turns 1/M0006 and 1/M0007 survived, covered
 * by GrowAboveTen. Removing either alone stays green (R-654 S2 L-R1, L-R2). See
 * docs/gates/alrunner-v3.md.
 */
async function legL1(scratch: string): Promise<SessionReport> {
  const b = new AlRunnerV3Backend(
    backendCfg({
      instrumentedDir: join(scratch, "backend"),
      testDir: LAYOUT_TEST_DIR,
      packagesDir: await microsoftDeps(scratch),
      bcVersion: SANDBOX_BC,
      selectorObjectId: LAYOUT_SELECTOR_IDS.selectorId,
    }),
  );
  const r = await session(scratch, b, {
    projectDir: LAYOUT_PROJECT_DIR,
    testDir: LAYOUT_TEST_DIR,
    selectorIds: LAYOUT_SELECTOR_IDS,
    maxGuardsPerBatch: LAYOUT_MAX_GUARDS,
  });
  printLayoutTable(r, "L1");
  assertCounts(r, "L1", 7, 3, 0, 10);
  asLegFailure("L1", () => assertLayoutRun(r, "L1"));
  assertCleanLeg(r, b, "L1");
  return r;
}

/** Y-A / Y-B (R321): sandbox-symbols under one set, EXPECTED_BY_SET per mutant. */
async function legY(scratch: string, leg: "Y-A" | "Y-B"): Promise<SessionReport> {
  const symbols = leg === "Y-A" ? ["LETHALA"] : ["LETHALB"];
  const ids = { selectorId: 79649, controlId: 79648, tableId: 79647 };
  const b = new AlRunnerV3Backend(
    backendCfg({
      instrumentedDir: join(scratch, "backend"),
      testDir: fixture("sandbox-symbols-tests"),
      packagesDir: await microsoftDeps(scratch),
      bcVersion: SANDBOX_BC,
      selectorObjectId: ids.selectorId,
      preprocessorSymbols: symbols,
    }),
  );
  const r = await session(scratch, b, {
    projectDir: fixture("sandbox-symbols"),
    testDir: fixture("sandbox-symbols-tests"),
    selectorIds: ids,
    preprocessorSymbols: symbols,
  });
  printSymbolTable(r, symbols, leg);
  assertCounts(r, leg, 5, 4, 0, 9);
  asLegFailure(leg, () => assertSymbolBuild(r, symbols, leg));
  assertCleanLeg(r, b, leg);
  return r;
}

// --- R602: MO and WR (pre-commitment: docs/superpowers/specs/2026-10-24-r602-alrunner-v3-mo-wr-precommitment.md, c2f67f0a)

/** The report's rows as the pure judges read them. */
function rowFacts(r: SessionReport): V3RowFacts[] {
  return r.mutants.map((m) => ({
    mutantCode: m.mutantCode,
    file: m.file,
    line: m.line,
    operatorName: m.operatorName,
    verdict: m.verdict,
    ...(m.killingTest !== undefined ? { killingTest: m.killingTest } : {}),
    ...(m.failureNote !== undefined ? { failureNote: m.failureNote } : {}),
  }));
}

/**
 * The durable killer check, BEFORE the own-baseline compare so that a record run (which writes the
 * baseline from whatever it measured) can never absorb a lost kill: every mutant `--mode none` kills
 * (`killers`, in code) must be killed by the same test with coverage on.
 */
function assertKillers(
  r: SessionReport,
  b: AlRunnerV3Backend,
  leg: string,
  killers: typeof V3_MO_KILLERS,
): void {
  must(b.capabilities().coverage === "al-runner", `${leg}: coverage is not on`);
  const lost = judgeKillers(rowFacts(r), killers);
  for (const l of lost) console.log(`    - ${l}`);
  must(lost.length === 0, `${leg}: ${lost.length} of ${killers.length} \`none\` kills lost`);
  console.log(`  ${leg}: all ${killers.length} \`none\` kills killed by the same test`);
}

/**
 * MO (R602): `sandbox-multiobject` with coverage ON, run as the other legs run (`runSession`, the v3
 * backend, one-shot). Two codeunits in one file (`MultiPair`), so v3's per-object frame is what the
 * index places. Pre-committed 6 / 1 / 5 over 12: the 5 no-coverage are in procedures no test calls.
 */
async function legMO(scratch: string): Promise<SessionReport> {
  const refused = moWrTransportRefusal("MO", TRANSPORT.transport);
  if (refused !== undefined) throw new LegFailure(refused);
  const projectDir = fixture("sandbox-multiobject");
  const testDir = fixture("sandbox-multiobject-tests");
  const ids = { selectorId: 79849, controlId: 79848, tableId: 79847 };
  const b = new AlRunnerV3Backend(
    backendCfg({
      instrumentedDir: join(scratch, "backend"),
      testDir,
      packagesDir: await microsoftDeps(scratch),
      bcVersion: SANDBOX_BC,
      selectorObjectId: ids.selectorId,
      sourceProjectDir: projectDir,
    }),
  );
  const r = await session(scratch, b, { projectDir, testDir, selectorIds: ids });
  assertKillers(r, b, "MO", V3_MO_KILLERS);
  assertCounts(r, "MO", 6, 1, 5, 12);
  assertCleanLeg(r, b, "MO");
  return r;
}

/**
 * WR (R602): `sandbox-wrapped` whole, config symbol WRAPDEF, coverage ON. 98 mutants: the 8
 * single-wrapper files score as `none` does (killer constant), and the three `WrappedArms` mutants
 * (the two-arm control, which the index has no rule for) read no-coverage with the refusal sentence.
 * That refusal costs 2 kills `none` finds (M0001, M0003), named, not hidden. Pre-committed 58 / 37 / 3.
 */
async function legWR(scratch: string): Promise<SessionReport> {
  const refused = moWrTransportRefusal("WR", TRANSPORT.transport);
  if (refused !== undefined) throw new LegFailure(refused);
  const b = new AlRunnerV3Backend(
    backendCfg({
      instrumentedDir: join(scratch, "backend"),
      testDir: WRAPPED_TEST_DIR,
      packagesDir: await microsoftDeps(scratch),
      bcVersion: SANDBOX_BC,
      selectorObjectId: WRAPPED_SELECTOR_IDS.selectorId,
      preprocessorSymbols: WRAPPED_SYMBOLS,
      sourceProjectDir: WRAPPED_PROJECT_DIR,
    }),
  );
  const r = await session(scratch, b, {
    projectDir: WRAPPED_PROJECT_DIR,
    testDir: WRAPPED_TEST_DIR,
    selectorIds: WRAPPED_SELECTOR_IDS,
    preprocessorSymbols: WRAPPED_SYMBOLS,
  });
  assertKillers(r, b, "WR", V3_WR_KILLERS);
  const arms = judgeWrArms(rowFacts(r), ARMS_REFUSAL);
  for (const l of arms) console.log(`    - ${l}`);
  must(arms.length === 0, `WR: the WrappedArms refusal differs: ${arms.join("; ")}`);
  assertCounts(r, "WR", 58, 37, 3, 98);
  assertCleanLeg(r, b, "WR", V3_WR_STATE_NOTES);
  return r;
}

/**
 * K (R387, R394): the backend the CLI builds from an `alRunnerV3` section with no `coverage` and
 * no `transport` key. Its spawns are wrapped, so the leg sees which transport ran. Never on a
 * candidate build (main skips it there with `V3_K_CANDIDATE_SKIP`): the CLI's config cannot name
 * a candidate, and the CLI-built backend refuses an ungated build.
 */
async function legK(scratch: string): Promise<void> {
  let oneShotTestCalls = 0;
  let serveSpawns = 0;
  // Build review M3: only the backend's own calls on the session's test folder count, never the
  // contract probe's or the predefined-symbol probe's (their own scratch projects).
  const sessionTests = [fixture("sandbox-tests"), realpathSync(fixture("sandbox-tests"))];
  const spawn: SpawnFn = (argv, opts) => {
    if (isSessionTestCall(argv, sessionTests)) oneShotTestCalls += 1;
    return defaultSpawn(argv, opts);
  };
  const serverSpawn: ServerSpawnFn = (argv, opts) => {
    serveSpawns += 1;
    return defaultServerSpawn(argv, opts);
  };
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => {
    warned.push(a.map(String).join(" "));
    warn(...a);
  };
  let built: Awaited<ReturnType<typeof buildBackend>>;
  try {
    built = await buildBackend(
      {
        mode: "run",
        projectDir: fixture("sandbox-app"),
        testDir: fixture("sandbox-tests"),
        backendKind: "al-runner-v3",
        dbPath: join(scratch, "cli.sqlite"),
        configPath: join(scratch, "lethal.config.json"),
        skipKnownSurvivors: false,
        workers: 1,
        keepEnv: false,
        allowExpiringEnv: false,
      } as Parameters<typeof buildBackend>[0],
      {
        alRunnerV3: legKSection({
          path: BIN,
          packagesDir: join(fixture("sandbox-tests"), ".alpackages"),
          bcVersion: SANDBOX_BC,
          alcPath: ALC,
          cacheDir: CACHE,
        }),
      },
      join(scratch, "cli-scratch"),
      undefined,
      {
        alRunnerSpawn: spawn,
        alRunnerServerSpawn: serverSpawn,
        // R586c: the test-only seam, for K on a candidate build and nowhere else.
        ...(CANDIDATE ? { alRunnerCandidate: true as const } : {}),
      },
      { selectorId: 79199, controlId: 79198, tableId: 79197 },
    );
  } finally {
    console.warn = warn;
  }
  if (!(built instanceof AlRunnerV3Backend)) {
    throw new LegFailure("K: buildBackend did not build an AlRunnerV3Backend");
  }
  const b = built;
  const r = await session(scratch, b, {
    projectDir: fixture("sandbox-app"),
    testDir: fixture("sandbox-tests"),
    selectorIds: { selectorId: 79199, controlId: 79198, tableId: 79197 },
  });
  assertCounts(r, "K", 3, 12, 4, 19);
  await assertPerMutant(r, join(HERE, "bcdev.baseline.json"), "K");
  const facts = {
    coverage: b.capabilities().coverage,
    inRunStopIsBudget: b.inRunStopIsBudget,
    serveSpawns,
    oneShotTestCalls,
    warned: warned.includes(AL_RUNNER_V3_NOT_AUTHORITATIVE),
    noCoverageFiles: r.mutants.filter((m) => m.verdict === "no-coverage").map((m) => m.file),
  };
  console.log(
    `  K: ${JSON.stringify({ ...facts, noCoverageFiles: facts.noCoverageFiles.length })}`,
  );
  const problems = judgeLegK(facts);
  must(problems.length === 0, problems.join("; "));
  assertCleanLeg(r, b, "K");
}

/** The sandbox-app batch as runSession built it (S1's instrumented batch folder). */
async function sandboxBatch(scratch: string): Promise<string> {
  const b = new AlRunnerV3Backend(
    backendCfg({
      instrumentedDir: join(scratch, "s1-backend"),
      testDir: fixture("sandbox-tests"),
      packagesDir: join(fixture("sandbox-tests"), ".alpackages"),
      bcVersion: SANDBOX_BC,
      selectorObjectId: 79199,
    }),
  );
  await session(join(scratch, "x-s1"), b, {
    projectDir: fixture("sandbox-app"),
    testDir: fixture("sandbox-tests"),
    selectorIds: { selectorId: 79199, controlId: 79198, tableId: 79197 },
  }).catch(async (e: unknown) => {
    // R736: a warning-set error is a gate failure, never swallowed with the session's own one.
    if (isGateWarningsError(e)) throw e;
    await mkdir(join(scratch, "x-s1"), { recursive: true });
    return undefined;
  });
  const instr = join(scratch, "x-s1", "instr");
  for (const e of await readdir(instr, { withFileTypes: true, recursive: true })) {
    if (e.isFile() && e.name === "mutant-manifest.json") return e.parentPath;
  }
  throw new V3LegEnvironment("X: no instrumented sandbox-app batch was written");
}

async function legX(scratch: string, push: (line: string) => void): Promise<void> {
  await mkdir(join(scratch, "x-s1"), { recursive: true });
  const batch = await sandboxBatch(scratch);
  const sb = fixture("sandbox-tests");
  const deps = join(sb, ".alpackages");
  const mk = (dir: string, testDir = sb) =>
    new AlRunnerV3Backend(
      backendCfg({
        instrumentedDir: dir,
        testDir,
        packagesDir: deps,
        bcVersion: SANDBOX_BC,
        selectorObjectId: 79199,
      }),
    );
  // (a) a broken batch: AlcCompileError naming AL0118, v3 spawned 0 times.
  const broken = join(scratch, "broken");
  await cp(batch, broken, { recursive: true });
  const logic = join(broken, "SandboxLogic.Codeunit.al");
  const text = await readFile(logic, "utf8");
  must(text.includes("begin"), "X: SandboxLogic has no begin");
  await writeFile(logic, text.replace("begin", "begin NoSuchVar := 1;"));
  const ba = mk(join(scratch, "xa"));
  const errA = await ba.deploy(broken).catch((e: unknown) => e);
  console.log(
    `  X (a): ${errA instanceof AlcCompileError ? "AlcCompileError" : String(errA)}; v3 spawns ${ba.spawnCount}`,
  );
  must(
    errA instanceof AlcCompileError && /AL0118/.test(errA.message) && ba.spawnCount === 0,
    "X (a)",
  );
  // (b) v3 alone on that folder: exit 7, 1 pass, 1 not run.
  const bDir = join(scratch, "xb");
  await cp(broken, bDir, { recursive: true });
  for (const f of [CONTROL_REGISTER_FILENAME, CONTROL_UPGRADE_FILENAME])
    await rm(join(bDir, f), { force: true });
  const man = JSON.parse(await readFile(join(bDir, "mutant-manifest.json"), "utf8")) as {
    artifactId: string;
  };
  await writeFile(
    join(bDir, "MutationSelector.Codeunit.al"),
    emitStaticSelector({
      objectId: 79199,
      activeId: "",
      artifactId: man.artifactId,
      targetAppId: "",
    }),
  );
  let b7 = "";
  let xb: Parameters<typeof classifyXb>[0] = {
    exitCode: 0,
    passed: 0,
    notRun: 0,
    parsed: false,
    compileError: false,
  };
  try {
    execFileSync(
      BIN,
      [
        "test",
        "--output-json",
        "--isolation",
        "test",
        "--package-cache",
        deps,
        "--bc-version",
        SANDBOX_BC,
        "--no-download",
        bDir,
        sb,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, ALRUNNER_CACHE: CACHE },
      },
    );
    b7 = "exit 0";
  } catch (e) {
    const x = e as { status?: number | null; stdout?: string; stderr?: string };
    let doc: {
      passed?: number;
      notRun?: number;
      failed?: number;
      tests?: unknown;
      compilationErrors?: unknown;
    } = {};
    let parsed = false;
    try {
      doc = JSON.parse(x.stdout ?? "") as typeof doc;
      parsed = typeof doc === "object" && doc !== null;
    } catch {
      doc = {};
    }
    // F3: held only for the parsed compile-refusal shape, never for a crash or a signal.
    const compileError =
      (Array.isArray(doc.compilationErrors) && doc.compilationErrors.length > 0) ||
      /\bAL0118\b/.test(`${x.stdout ?? ""}\n${x.stderr ?? ""}`);
    xb = {
      exitCode: typeof x.status === "number" ? x.status : -1,
      passed: doc.passed ?? 0,
      notRun: doc.notRun ?? 0,
      parsed,
      compileError,
      // R586c: read only with a pin; an absent field is not 0.
      passedPresent: typeof doc.passed === "number",
      notRunPresent: typeof doc.notRun === "number",
      ...(typeof doc.failed === "number" ? { failed: doc.failed } : {}),
      ...(Array.isArray(doc.tests) ? { rowCount: doc.tests.length } : {}),
      compilationErrorsCount: Array.isArray(doc.compilationErrors)
        ? doc.compilationErrors.length
        : 0,
    };
    b7 = `exit ${x.status} passed ${doc.passed} notRun ${doc.notRun}`;
    // R586c: the document's shape, before judging, so a changed shape shows in the kept log.
    console.log(
      `  X (b) document: keys [${parsed ? Object.keys(doc).join(",") : "unparsed"}], passed ${doc.passed}, notRun ${doc.notRun}, failed ${doc.failed}, rows ${xb.rowCount}, compilationErrors ${xb.compilationErrorsCount}`,
    );
  }
  console.log(`  X (b): ${b7}`);
  // I-2: v3 refusing the broken target is #5602's fix, a move toward BC: held, not gate-fail.
  const xbOutcome = classifyXb(xb, activePin?.xb);
  must(xbOutcome !== "gate-fail", `X (b): ${b7}`);
  const xHeld: string[] =
    xbOutcome === "held"
      ? [
          activePin !== undefined
            ? `X (b): pin-mismatch: pinned exit 3, passed 0, notRun 0, no rows, compilationErrors non-empty; read ${b7}`
            : `X (b): ${b7}: v3 now refuses the broken target (#5602 fixed)`,
        ]
      : [];
  for (const l of xHeld) console.log(`  ${l}`);
  if (activePin !== undefined && xbOutcome === "pass")
    push(`X: pinned X (b) = ${b7} (pin ${activePin.id}, as BC)`);
  // r10 M5: the held line is in the receipt before (c)-(f) run, so a later gate-fail cannot hide it.
  await xbHeldFirst(xHeld, push, () => legXRest(scratch, batch, man.artifactId));
}

/** X (c)-(f), after X (b). */
async function legXRest(scratch: string, batch: string, artifactId: string): Promise<void> {
  const sb = fixture("sandbox-tests");
  const deps = join(sb, ".alpackages");
  const man = { artifactId };
  // (c1-c5) after a good deploy and activate("M0002").
  const tamper: [string, (active: string, tests: string, d: string) => Promise<void>][] = [
    ["c1", (a) => appendFile(join(a, "SandboxLogic.Codeunit.al"), " ")],
    [
      "c2",
      async (_a, t) => {
        const f = (await readdir(t)).find((n) => n.endsWith(".al"));
        if (f === undefined) throw new V3LegEnvironment("X: no test .al");
        await appendFile(join(t, f), " ");
      },
    ],
    [
      "c3",
      (a) =>
        writeFile(
          join(a, "MutationSelector.Codeunit.al"),
          emitStaticSelector({
            objectId: 79199,
            activeId: "M9999",
            artifactId: man.artifactId,
            targetAppId: "",
          }),
        ),
    ],
    [
      "c4",
      (a) =>
        writeFile(
          join(a, "MutationSelector.Codeunit.al"),
          emitStaticSelector({
            objectId: 79199,
            activeId: "M0001",
            artifactId: man.artifactId,
            targetAppId: "",
          }),
        ),
    ],
    ["c5 app.json", (a) => appendFile(join(a, "app.json"), " ")],
    ["c5 deps", async (_a, _t, d) => writeFile(join(d, "Extra.app"), "x")],
  ];
  for (const [name, fn] of tamper) {
    const dir = join(scratch, `x-${name.replace(" ", "-")}`);
    const tests = join(dir, "tests");
    const d = join(dir, "deps");
    await cp(sb, tests, { recursive: true });
    await cp(deps, d, { recursive: true });
    const b = new AlRunnerV3Backend(
      backendCfg({
        instrumentedDir: join(dir, "b"),
        testDir: tests,
        packagesDir: d,
        bcVersion: SANDBOX_BC,
        selectorObjectId: 79199,
      }),
    );
    // (c) runs in the production configuration, v3 with coverage on, so `deploy()` builds its
    // coverage index. That needs the session's build symbols, which `runSession` hands over
    // (`handBuildSymbols`); without this call R-300b's guard refuses the deploy (measured
    // 2026-10-21, X.log on 581bba4b). The set is exactly what `runSession` computes for the
    // sandbox-app session that built `batch`: no config symbols, alc's build (no predefined).
    b.useBuildSymbols(
      await effectiveBuildSymbols(fixture("sandbox-app"), [], undefined, { kind: "al-runner-v3" }),
    );
    await b.deploy(batch);
    await b.activate("M0002");
    const before = b.spawnCount;
    await fn(join(dir, "b", "active"), join(tests, "src"), d);
    const err = await b
      .run(
        { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "OverBudgetDetected" },
        { coverage: "none", timeoutMs: 30000 },
      )
      .catch((e: unknown) => e);
    console.log(
      `  X (${name}): ${err instanceof AlRunnerV3UnprovenBatchError ? "AlRunnerV3UnprovenBatchError" : String(err)}; spawns ${b.spawnCount - before}`,
    );
    must(err instanceof AlRunnerV3UnprovenBatchError && b.spawnCount === before, `X (${name})`);
  }
  await legXSleep(scratch);
}

/**
 * r5a: a leg's scratch target AND test app are compiled with alc against the leg's deps during
 * setup, before any session starts. A setup gap is then refused by name here
 * (`al-runner-v3-itest-setup-does-not-compile`) instead of surfacing inside `deploy()`.
 */
async function assertSetupCompiles(
  leg: string,
  app: string,
  tests: string,
  deps: string,
  work: string,
): Promise<void> {
  const pc = join(work, "packages");
  await mkdir(join(work, "out"), { recursive: true });
  await cp(deps, pc, { recursive: true });
  const compiler = new ArtifactCompiler(
    { alcPath: ALC, packageCachePath: deps, outputDir: join(work, "out") },
    defaultArtifactIo,
  );
  try {
    const target = await compiler.compileProject({
      projectDir: app,
      packageCachePath: deps,
      name: "target",
    });
    await cp(target.appPath, join(pc, "Target.app"));
    await compiler.compileProject({ projectDir: tests, packageCachePath: pc, name: "tests" });
  } catch (err) {
    if (!(err instanceof AlcCompileError)) throw err;
    throw new V3LegEnvironment(
      `${leg}: al-runner-v3-itest-setup-does-not-compile: the scratch target or test app does not compile against the leg's deps (${deps}): ${err.message.slice(0, 600)}`,
    );
  }
  console.log(`  ${leg}: setup compiles (target and test app, alc, against ${deps})`);
}

/** X (d)-(f): the Sleep rule live through the backend, on the probe target `Probe Sleeper`. */
async function legXSleep(scratch: string): Promise<void> {
  const app = join(scratch, "probe-app");
  const tests = join(scratch, "probe-tests");
  await cp(join(PROBE, "probe-app"), app, { recursive: true });
  await cp(join(PROBE, "probe-tests"), tests, { recursive: true });
  await cp(
    join(PROBE, "extras", "ProbeSleeper.Codeunit.al"),
    join(app, "src", "ProbeSleeper.Codeunit.al"),
  );
  await cp(
    join(PROBE, "extras", "ProbeSleep.Codeunit.al"),
    join(tests, "src", "ProbeSleep.Codeunit.al"),
  );
  // The multi-object file and its test leave the scratch copy. Since R602 the v3 index places a
  // multi-object file (leg MO measures that), so this is no longer needed for coverage; the `rm`
  // stays so that X (d)'s pre-committed predictions do not move.
  await rm(join(app, "src", "ProbePair.Codeunit.al"));
  await rm(join(tests, "src", "ProbeCoverage.Codeunit.al"));
  // r5a (f32aa92a): `TestPermissions = Restricted` does not compile against X (d)'s deps
  // (AL0169). The file has no Sleep line and is outside --tests-only, so no prediction moves.
  await rm(join(tests, "src", "ProbePermissions.Codeunit.al"));
  const deps = await microsoftDeps(join(scratch, "x-d"));
  await assertSetupCompiles("X (d)", app, tests, deps, join(scratch, "x-d-setup"));
  const run = async (tag: string, tamper?: (p: string) => Promise<void>) => {
    const dir = join(scratch, `xd-${tag}`);
    // The results store opens `<dir>/lethal.sqlite`, so the folder must exist first.
    await mkdir(dir, { recursive: true });
    const b = new AlRunnerV3Backend(
      backendCfg({
        instrumentedDir: join(dir, "b"),
        testDir: tests,
        packagesDir: deps,
        bcVersion: SANDBOX_BC,
        selectorObjectId: 50649,
      }),
    );
    if (tamper !== undefined) b.coverageTamper = tamper;
    // r10 (c): SleeperDoubles's baseline verdict, from the session's event stream.
    let sleeper: XdBaselineVerdict | undefined;
    const r = await session(
      dir,
      b,
      {
        projectDir: app,
        testDir: tests,
        selectorIds: { selectorId: 50649, controlId: 50648, tableId: 50647 },
        only: ["src/ProbeSleeper.Codeunit.al"],
        testsOnly: ["src/ProbeSleep.Codeunit.al"],
      },
      (e) => {
        if (e.type !== "baseline-batch-finished") return;
        const v = e.verdicts.find((t) => t.name.endsWith(".SleeperDoubles"));
        if (v !== undefined)
          sleeper = {
            outcome: v.outcome,
            ...(v.failureMessage !== undefined ? { failureMessage: v.failureMessage } : {}),
          };
      },
    );
    for (const m of r.mutants) {
      console.log(
        `  X (${tag}): ${m.mutantCode} ${m.operatorName} ${m.verdict} ${m.killingTest ?? "-"} ${(m.failureNote ?? "").slice(0, 120)}`,
      );
    }
    return { r, b, sleeper };
  };
  // r5 (precommitment-r5-xd): per mutant call, SleeperDoubles' raw per-test hits on the instrumented
  // ProbeSleeper's Sleep lines, read from the very --coverage-json the backend then reads.
  const hitsByMutant = new Map<string, Map<number, number>>();
  const recordHits = async (p: string): Promise<void> => {
    const sel = await readFile(
      join(dirname(p), "..", "active", "MutationSelector.Codeunit.al"),
      "utf8",
    );
    const id = /MutantId = '([^']+)'/.exec(sel)?.[1] ?? "";
    const doc = JSON.parse(await readFile(p, "utf8")) as {
      perTestCoverage: {
        test: string;
        coverage: { file: string; statements: { line: number; hits: number }[] }[];
      }[];
    };
    const own = doc.perTestCoverage.find((t) => t.test.endsWith(".SleeperDoubles"));
    const m = new Map<number, number>();
    for (const f of own?.coverage ?? []) {
      if (!f.file.endsWith("ProbeSleeper.Codeunit.al")) continue;
      for (const s of f.statements)
        if (SLEEP_LINES.includes(s.line)) m.set(s.line, (m.get(s.line) ?? 0) + s.hits);
    }
    hitsByMutant.set(id, m);
  };
  const SLEEP_LINES = [25, 31, 37, 43];
  const { r, b, sleeper } = await run("d", recordHits);
  // r10 (c), I4/M7: the baseline facts, printed before any (d) check. No verdict rule changes.
  console.log(`  ${xdBaselineLine(sleeper)}`);
  console.log(`  X (d): baselineGreen ${r.baselineGreen}`);
  for (const m of r.mutants)
    console.log(`  X (d): ${m.mutantCode} coveringTests ${JSON.stringify(m.coveringTests ?? [])}`);
  console.log(
    `  X (d): stop ${BASELINE_STOP_S} s (computed from \`BASELINE_TIMEOUT_DEFAULT\`, not read from the call)`,
  );
  const mustD = (cond: boolean, what: string): void => must(cond, xdFailure(what, sleeper));
  const idx = b.sleepIndexSize();
  console.log(`  X (d): Sleep index ${idx?.target} + ${idx?.test}`);
  must(idx?.target === 4 && idx?.test === 5, `X (d): Sleep index ${JSON.stringify(idx)}, r5 4 + 5`);
  // r6 (c), restated by r11 (b): on alpha.2 every ProbeSleep test passes; on edge the three 600 s
  // siblings are timeout rows. A timeout is not a refusal, so no ProbeSleep test is unsupported on either.
  must(
    !r.unsupportedTests.some((t) => t.includes("Sleep")),
    `X (d): a Sleep test refused at baseline: ${r.unsupportedTests.join(", ")}`,
  );
  // The r5 table, by operator (codes as generated: M0001..M0005).
  const R5: Record<string, { code: string; verdict: string; line?: number }> = {
    "lethal.empty-block": { code: "M0001", verdict: "killed" },
    "lethal.void-method-call": { code: "M0002", verdict: "survived" },
    "lethal.remove-assignment": { code: "M0003", verdict: "error", line: 25 },
    "lethal.shift-integer": { code: "M0004", verdict: "error", line: 37 },
    "lethal.return-value": { code: "M0005", verdict: "killed" },
  };
  mustD(r.mutants.length === 5, `X (d): ${r.mutants.length} mutants, r5 5`);
  for (const m of r.mutants) {
    const want = R5[m.operatorName];
    const hits = hitsByMutant.get(m.mutantCode);
    console.log(`  X (d): ${m.mutantCode} hits ${JSON.stringify([...(hits ?? new Map())])}`);
    mustD(
      want !== undefined && want.code === m.mutantCode && want.verdict === m.verdict,
      `X (d): ${m.mutantCode} ${m.operatorName} ${m.verdict}`,
    );
    if (want?.verdict === "error") {
      must(
        (hits?.get(want.line ?? -1) ?? 0) > 0,
        `X (d): ${m.mutantCode}: no raw hit on Sleep line ${want.line}`,
      );
      must(
        m.cause === "runner-refused" &&
          (m.failureNote ?? "").startsWith(`${SLEEP_NOTE_TAG} covered Sleep at`) &&
          (m.failureNote ?? "").includes(`ProbeSleeper.Codeunit.al:${want.line}:`),
        `X (d): ${m.mutantCode}: not the Sleep rule's refusal at :${want.line} (${m.cause} ${m.failureNote})`,
      );
    } else {
      must(
        !(m.failureNote ?? "").includes(SLEEP_NOTE_TAG),
        `X (d): ${m.mutantCode} carries a Sleep note`,
      );
    }
    if (m.verdict === "killed")
      must(
        m.killingTest === "SleeperDoubles" && m.killReproduced === true,
        `X (d): ${m.mutantCode} killer`,
      );
  }
  // The negative twin: no hit on any indexed Sleep line, a passing row, survived, no note.
  const twin = hitsByMutant.get("M0002");
  must(
    twin !== undefined && [...twin.values()].every((h) => h === 0),
    `X (d): M0002 hit a Sleep line ${JSON.stringify([...(twin ?? new Map())])}`,
  );
  // M6 (RC-5): `failsClosedRefusal` (al-runner-v3-gate.ts, unit-tested): the same five mutants,
  // none survived, and the (d) control M0002 reading error.
  const failsClosed = (tag: string, rep: SessionReport): void => {
    const why = failsClosedRefusal(rep.mutants);
    must(why === undefined, `${tag}: ${why}`);
  };
  // (e) the coverage document removed under every mutant: no pass survives.
  const e = await run("e", async (p) => {
    await rm(p, { force: true });
  });
  failsClosed("X (e)", e.r);
  must(
    e.r.mutants
      .filter((m) => m.verdict === "error")
      .every((m) => (m.failureNote ?? "").includes("coverage unavailable")),
    "X (e): an error without the unavailable note",
  );
  // (f) a missing per-test entry; an absent indexed line; an unowned hit. The Sleep lines are read
  // from the instrumented file v3 reported (a text match, as close to the index as a hook needs).
  type Cov = { file: string; statements: { line: number; hits: number }[] };
  type Doc = { coverage: Cov[]; perTestCoverage: { test: string; coverage: Cov[] }[] };
  const edit =
    (fn: (j: Doc, sleepLines: (f: Cov) => Promise<Set<number>>) => Promise<void>) =>
    async (p: string) => {
      const j = JSON.parse(await readFile(p, "utf8")) as Doc;
      const sleepLines = async (f: Cov) =>
        new Set(
          (await readFile(f.file, "utf8"))
            .split("\n")
            .flatMap((l, i) => (/\bSleep\s*\(/i.test(l) ? [i + 1] : [])),
        );
      await fn(j, sleepLines);
      await writeFile(p, JSON.stringify(j));
    };
  const isSleeper = (f: Cov) => f.file.endsWith("ProbeSleeper.Codeunit.al");
  const f1 = await run(
    "f1",
    edit(async (j) => {
      j.perTestCoverage = j.perTestCoverage.filter((t) => !t.test.endsWith(".SleeperDoubles"));
    }),
  );
  failsClosed("X (f1)", f1.r);
  const f2 = await run(
    "f2",
    edit(async (j, sleepLines) => {
      for (const f of j.coverage.filter(isSleeper)) {
        const lines = await sleepLines(f);
        f.statements = f.statements.filter((s) => !lines.has(s.line));
      }
    }),
  );
  failsClosed("X (f2)", f2.r);
  const f3 = await run(
    "f3",
    edit(async (j, sleepLines) => {
      for (const f of j.coverage.filter(isSleeper)) {
        const lines = await sleepLines(f);
        for (const s of f.statements) if (lines.has(s.line)) s.hits = Math.max(1, s.hits);
        for (const t of j.perTestCoverage) {
          for (const g of t.coverage.filter(isSleeper))
            g.statements = g.statements.filter((s) => !lines.has(s.line));
        }
      }
    }),
  );
  failsClosed("X (f3)", f3.r);
}

async function legD(scratch: string, leg: "D1" | "D1c"): Promise<void> {
  if (CDO === undefined) throw new V3LegEnvironment(`${leg}: LETHAL_ITEST_V3_CDO unset`);
  const git = (...a: string[]) => execFileSync("git", ["-C", CDO, ...a], { encoding: "utf8" });
  // `scripts/corpus-fingerprint.ts` (R187), run as a script: packages/ cannot import scripts/.
  const fpOut = execFileSync("bun", [join(REPO, "scripts", "corpus-fingerprint.ts"), CDO], {
    encoding: "utf8",
  });
  const fp = /^full sha256: ([0-9a-f]{64})$/m.exec(fpOut)?.[1];
  if (fp === undefined) throw new Error(`${leg}: corpus-fingerprint printed no sha256: ${fpOut}`);
  const head = git("rev-parse", "HEAD").trim();
  console.log(`  ${leg}: CDO ${CDO} at ${head}, corpus fingerprint ${fp.slice(0, 16)}`);
  // M14: the slice's file under .dependencies and every Test/.alpackages app, by sha256.
  const alpDir = join(CDO, "Test", ".alpackages");
  const alpackages = existsSync(alpDir)
    ? await Promise.all(
        (await readdir(alpDir))
          .filter((n) => n.toLowerCase().endsWith(".app"))
          .map(async (name) => ({ name, sha256: await sha256OfFile(join(alpDir, name)) })),
      )
    : [];
  const sliceFile = join(CDO, CDO_SLICE_FILE);
  const refused = cdoCheckoutRefusal({
    head,
    porcelain: git("status", "--porcelain"),
    fingerprint: fp,
    sliceSha256: existsSync(sliceFile) ? await sha256OfFile(sliceFile) : "(missing)",
    alpackages,
  });
  console.log(
    `  ${leg}: slice file and ${alpackages.length} Test/.alpackages app(s) checked by sha256`,
  );
  if (refused !== undefined) throw new V3LegEnvironment(`${leg}: ${refused}`);
  const b = new AlRunnerV3Backend(
    backendCfg({
      instrumentedDir: join(scratch, "backend"),
      testDir: join(CDO, "Test"),
      packagesDir: join(CDO, "Test", ".alpackages"),
      bcVersion: CDO_BC,
      selectorObjectId: 6175460,
      coverage: leg === "D1" ? "none" : "al-runner",
    }),
  );
  const r = await session(scratch, b, {
    projectDir: join(CDO, "Cloud"),
    testDir: join(CDO, "Test"),
    selectorIds: { selectorId: 6175460, controlId: 6175459, tableId: 6175458 },
    only: [".dependencies/CDO/Codeunit/CDORecipientMgt.Codeunit.al"],
    testsOnly: ["Src/Recipients/CDORecipientMgtTests.Codeunit.al"],
    dependencyPackageDirs: [join(CDO, "Test", ".alpackages")],
  });
  if (leg === "D1") assertCounts(r, leg, 51, 12, 0, 63);
  else assertCounts(r, leg, 51, 8, 4, 63);
  await assertPerMutant(
    r,
    join(
      REPO,
      "docs",
      "measurements",
      "r594",
      leg === "D1" ? "bc3-A.report.json" : "bc3-B.report.json",
    ),
    leg,
  );
  const STATE = [
    ...Array.from({ length: 30 }, (_, i) => `0/M${String(i + 1).padStart(4, "0")}`),
    ...[35, 36, 37, 39, 42, 43, 44, 45, 46, 47, 49, 50, 51, 52, 53, 54, 56, 58, 59, 60, 61].map(
      (n) => `0/M${String(n).padStart(4, "0")}`,
    ),
  ].sort();
  const got = tagged(r, V3_STATE_NOTE_TAG);
  console.log(`  ${leg}: state notes ${got.length}`);
  must(
    JSON.stringify(got) === JSON.stringify(STATE),
    `${leg}: state-note set differs: ${got.join(",")}`,
  );
  must(tagged(r, V3_REFUSED_NEARBY_TAG).length === 0, `${leg}: refused-nearby notes`);
  must(
    tagged(r, SLEEP_NOTE_TAG).length === 0 && refusedCause(r).length === 0,
    `${leg}: a §6 or runner refusal`,
  );
  must(r.baselineGreen && r.unsupportedTests.length === 0, `${leg}: baseline not green`);
  assertIndex(b, leg, 3, 0);
  assertReproduced(r, leg);
}

/**
 * r10 (a) (R647): leg T runs its session, prints, and throws; `judgeLegT` judges. Outside record
 * mode the rows are classified, compared and printed (each its own receipt line) BEFORE any check.
 * The record branch keeps the counts first: a baseline is recorded only from a run matching them.
 * `main` then runs `assertGateBaseline` on a `pass` (R332's wiring test reads that call in main).
 */
async function legT(
  scratch: string,
  push: (line: string) => void,
): Promise<{
  readonly outcome: "pass" | "held";
  readonly r: SessionReport;
  /** R586c: the pin made this a pass; `main` skips the alpha.2 baseline compare. */
  readonly pinned?: true;
}> {
  const b = new AlRunnerV3Backend(
    backendCfg({
      instrumentedDir: join(scratch, "backend"),
      testDir: fixture("sandbox-data-tests"),
      packagesDir: join(fixture("sandbox-data-tests"), ".alpackages"),
      bcVersion: SANDBOX_BC,
      selectorObjectId: 79399,
    }),
  );
  const r = await session(scratch, b, {
    projectDir: fixture("sandbox-data"),
    testDir: fixture("sandbox-data-tests"),
    selectorIds: { selectorId: 79399, controlId: 79398, tableId: 79397 },
  });
  const bc = (await readGateBaseline(join(HERE, "tables.baseline.json"))).entries;
  const now = normalizeForComparison(r);
  const notes = () =>
    console.log(
      `  T: notes state ${tagged(r, V3_STATE_NOTE_TAG).length}, refused-nearby ${tagged(r, V3_REFUSED_NEARBY_TAG).length}, §6 ${tagged(r, SLEEP_NOTE_TAG).length} (recorded, not predicted)`,
    );
  if (recordRequested(TABLES_BASELINE_PATH)) {
    assertCounts(r, "T", 290, 57, 59, 406);
    must(
      r.unsupportedTests.length === 3,
      `T: ${r.unsupportedTests.length} refused tests, pre-committed 3`,
    );
    assertIndex(b, "T", 0, 0);
    notes();
    // I-3 and M5 before anything is written: this run's rows differ from BC's on exactly
    // the pinned 52, by key and transition (41 Commit, 7 duplicate key, 4 TestPage).
    const why = knownDifferencesRefusal(bc, now, TABLES_KNOWN_DIFFERENCES);
    console.log(`  T: differences from BC's tables baseline: ${why ?? "the pinned 52"}`);
    must(why === undefined, `T: ${why}`);
    return { outcome: "pass", r };
  }
  const ownBase = await readGateBaseline(TABLES_BASELINE_PATH);
  const own = ownBase.entries;
  console.log(`  T: ${counts(r)} over ${r.mutants.length} (judged after the rows)`);
  const idx = b.sleepIndexSize();
  console.log(`  T: Sleep index ${idx?.target} + ${idx?.test}`);
  // As `assertGateBaseline` computes it (baseline-guard's `throwOnRowDiff`).
  const sameScheme =
    ownBase.identityScheme !== undefined && ownBase.identityScheme === IDENTITY_SCHEME;
  const legTPin = activePin?.legT;
  const j = judgeLegT({
    classification: classifyLegT(own, now, bc),
    // As `assertGateBaseline` computes it (baseline-guard's `throwOnRowDiff`).
    compare: compareMutants(own, now, { sameScheme }),
    own,
    now,
    counts: r.counts,
    total: r.mutants.length,
    unsupportedTests: r.unsupportedTests.length,
    sleepIndex: idx,
    knownRefusal: knownDifferencesRefusal(bc, own, TABLES_KNOWN_DIFFERENCES),
    codes: new Map(r.mutants.map((m) => [keyOf(m), m.mutantCode])),
    ...(activePin !== undefined && legTPin !== undefined
      ? { pin: { id: activePin.id, legT: legTPin, bc, sameScheme } }
      : {}),
  });
  for (const l of j.lines) {
    console.log(`  ${l}`);
    push(l);
  }
  notes();
  if (j.outcome === "gate-fail") throw new LegFailure(j.failure ?? "T: gate-fail");
  return { outcome: j.outcome, r, ...(j.pinned === true ? { pinned: true as const } : {}) };
}

// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  preflightObserve();
  const observeRefused = observeWithReceiptRefusal(
    observeRequested(),
    process.env.LETHAL_V3_GATE_RECEIPT,
  );
  if (observeRefused !== undefined) throw new Error(observeRefused);
  if (LEGS.includes("T")) preflightGateBaseline(TABLES_BASELINE_PATH, "al-runner-v3 itest leg T");
  // R654 S2: refused before any leg runs while a baseline is missing (R332).
  if (LEGS.includes("L1")) preflightGateBaseline(LAYOUT_BASELINE_PATH, "al-runner-v3 itest leg L1");
  if (LEGS.includes("Y-A"))
    preflightGateBaseline(SYMBOLS_A_BASELINE_PATH, "al-runner-v3 itest leg Y-A");
  if (LEGS.includes("Y-B"))
    preflightGateBaseline(SYMBOLS_B_BASELINE_PATH, "al-runner-v3 itest leg Y-B");
  // R602: the same, for MO and WR.
  if (LEGS.includes("MO"))
    preflightGateBaseline(MULTIOBJECT_BASELINE_PATH, "al-runner-v3 itest leg MO");
  if (LEGS.includes("WR"))
    preflightGateBaseline(WRAPPED_BASELINE_PATH, "al-runner-v3 itest leg WR");
  // R614: the fixture .alpackages, from the pinned tar (a fresh worktree extracts them itself).
  // M9: every leg selection needs them, CDO-only legs included (or the tar to extract them from).
  const prepared = await prepareFixtureSymbols({ worktree: REPO });
  console.log(`al-runner-v3 itest: fixture .alpackages ${prepared}`);
  const sha = await sha256OfFile(BIN);
  const version = (execFileSync(BIN, ["--version"], { encoding: "utf8" }) as string).trim();
  const lethalHead = execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  // G5: tracked changes, plus untracked files under fixtures/ and packages/ (`dirtyFromStatus`).
  const statusNow = () =>
    execFileSync("git", ["-C", REPO, "status", "--porcelain", "--untracked-files=all"], {
      encoding: "utf8",
    });
  const dirty = dirtyFromStatus(statusNow());
  console.log(`al-runner-v3 itest: LethAL ${lethalHead}${dirty ? " (DIRTY)" : ""}`);
  console.log(
    `al-runner-v3 itest: ${version} sha256 ${sha} (${BIN})${CANDIDATE ? " CANDIDATE" : ""}; legs ${LEGS.join(",")}`,
  );
  // R586c: a per-build pin applies only when the version line AND the sha256 are both equal.
  const PIN = findV3Pin(version, sha);
  activePin = PIN;
  if (PIN !== undefined)
    console.log(`al-runner-v3 itest: PIN ${PIN.id} applies (version and sha256 equal)`);
  // M5: no leg records a baseline from a pinned or candidate build.
  const recordBaselines = new Map<string, string>([
    ["T", TABLES_BASELINE_PATH],
    ["L1", LAYOUT_BASELINE_PATH],
    ["Y-A", SYMBOLS_A_BASELINE_PATH],
    ["Y-B", SYMBOLS_B_BASELINE_PATH],
    ["MO", MULTIOBJECT_BASELINE_PATH],
    ["WR", WRAPPED_BASELINE_PATH],
  ]);
  const refusedRecord = recordRefusal(
    PIN !== undefined,
    CANDIDATE,
    LEGS.flatMap((l) => {
      const p = recordBaselines.get(l);
      return p !== undefined && recordRequested(p) ? [p] : [];
    }),
  );
  if (refusedRecord !== undefined) throw new V3LegEnvironment(refusedRecord);
  const legs: Record<string, V3LegOutcome> = {};
  const lines: string[] = [];
  const root = await mkdtemp(join(tmpdir(), "lethal-itest-v3-"));
  let recorded: BaselineRecordedError | undefined;
  /** Build review M4: the legs whose baseline this run wrote. */
  const recordedLegs = new Set<string>();
  try {
    for (const leg of LEGS) {
      const scratch = join(root, leg);
      await mkdir(scratch, { recursive: true });
      const t0 = Date.now();
      console.log(`leg ${leg}:`);
      // R654 S2, ruling condition 1: on a candidate K never runs, and says so in the summary.
      if (leg === V3_K_LEG && CANDIDATE && !K_ON_CANDIDATE) {
        legs[leg] = V3_K_CANDIDATE_SKIP;
        const why = `${leg}: ${V3_K_CANDIDATE_SKIP}: the CLI's alRunnerV3 config cannot name a candidate, and a CLI-built backend runs gated builds only`;
        console.log(`leg ${why}`);
        lines.push(why);
        continue;
      }
      try {
        if (leg === "C") lines.push(...(await legC(scratch)).map((l) => `C: ${l}`));
        else if (leg === "S1") await legS1(scratch);
        else if (leg === V3_S1E_LEG) await legS1(scratch, V3_S1E_LEG, version);
        else if (leg === "S3") await legS3(scratch);
        else if (leg === "N1") await legN1(scratch);
        else if (leg === V3_N1E_LEG) await legN1E(scratch, version);
        else if (leg === "X") await legX(scratch, (l) => lines.push(l));
        else if (leg === "D1" || leg === "D1c") await legD(scratch, leg);
        // R654 S2: each leg checks its pre-committed table FIRST (gate-fail on a difference, and
        // nothing is written), then the own-baseline compare, which a record run writes (R332).
        else if (leg === "L1") {
          const r = await legL1(scratch);
          try {
            await assertGateBaseline(r, LAYOUT_BASELINE_PATH, "al-runner-v3 itest leg L1");
          } catch (e) {
            if (e instanceof BaselineRecordedError) throw e;
            throw new LegFailure(`L1: ${e instanceof Error ? e.message : String(e)}`);
          }
        } else if (leg === "Y-A") {
          const r = await legY(scratch, leg);
          try {
            await assertGateBaseline(r, SYMBOLS_A_BASELINE_PATH, "al-runner-v3 itest leg Y-A");
          } catch (e) {
            if (e instanceof BaselineRecordedError) throw e;
            throw new LegFailure(`Y-A: ${e instanceof Error ? e.message : String(e)}`);
          }
        } else if (leg === "Y-B") {
          const r = await legY(scratch, leg);
          try {
            await assertGateBaseline(r, SYMBOLS_B_BASELINE_PATH, "al-runner-v3 itest leg Y-B");
          } catch (e) {
            if (e instanceof BaselineRecordedError) throw e;
            throw new LegFailure(`Y-B: ${e instanceof Error ? e.message : String(e)}`);
          }
        } else if (leg === "MO") {
          // R602: the killer check and the counts ran inside the leg (nothing is written on a
          // difference); then the own-baseline compare, which a record run writes (R332).
          const r = await legMO(scratch);
          try {
            await assertGateBaseline(r, MULTIOBJECT_BASELINE_PATH, "al-runner-v3 itest leg MO");
          } catch (e) {
            if (e instanceof BaselineRecordedError) throw e;
            throw new LegFailure(`MO: ${e instanceof Error ? e.message : String(e)}`);
          }
        } else if (leg === "WR") {
          const r = await legWR(scratch);
          try {
            await assertGateBaseline(r, WRAPPED_BASELINE_PATH, "al-runner-v3 itest leg WR");
          } catch (e) {
            if (e instanceof BaselineRecordedError) throw e;
            throw new LegFailure(`WR: ${e instanceof Error ? e.message : String(e)}`);
          }
        } else if (leg === V3_K_LEG) await legK(scratch);
        else if (leg === "T") {
          const t = await legT(scratch, (l) => lines.push(l));
          if (t.outcome === "held") {
            legs[leg] = "held";
            console.log(`leg ${leg}: HELD (${Math.round((Date.now() - t0) / 1000)} s)`);
            continue;
          }
          // r10: after the judge's pass (or the record branch's checks), the own-baseline compare.
          // A baseline row difference is a figure that differs (gate-fail), never infra (M2).
          // R586c: a pinned pass was judged against the pin's table (same compare, same R556
          // check) in `judgeLegT`; alpha.2's baseline would fail on the seven moved rows.
          if (!t.pinned) {
            try {
              await assertGateBaseline(t.r, TABLES_BASELINE_PATH, "al-runner-v3 itest leg T");
            } catch (e) {
              if (e instanceof BaselineRecordedError) throw e;
              throw new LegFailure(`T: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        } else throw new V3LegEnvironment(`unknown leg ${leg}`);
        legs[leg] = "pass";
        console.log(`leg ${leg}: PASS (${Math.round((Date.now() - t0) / 1000)} s)`);
      } catch (err) {
        if (err instanceof BaselineRecordedError) {
          recorded = err;
          recordedLegs.add(leg);
          legs[leg] = "gate-fail";
          console.log(`leg ${leg}: RECORDED (not a pass)`);
          continue;
        }
        const msg = err instanceof Error ? err.message : String(err);
        // M2: by the error's TYPE only (legOutcomeOfError), never by its text.
        legs[leg] = legOutcomeOfError(err, leg);
        if (err instanceof V3LegHeld) lines.push(...err.lines.map((l) => `${leg}: ${l}`));
        else lines.push(`${leg}: ${msg.slice(0, 1000)}`);
        console.log(`leg ${leg}: ${legs[leg]?.toUpperCase()} ${formatFailure(err).slice(0, 2000)}`);
      } finally {
        // r9 §2: every leg that ran under an `unlike-bc` warning names it in the receipt.
        for (const l of new Set(sessionUnlikeBc.splice(0))) {
          console.log(`  ${leg}: ${l}`);
          lines.push(`${leg}: ${l}`);
        }
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
  const outcome = v3ReceiptOutcome(legs, observeRequested());
  console.log(
    `al-runner-v3 itest: legs ${JSON.stringify(legs)}; ${observeRequested() ? `observe run, receipt outcome ${outcome}, not a pass` : `update-gate outcome ${outcome}`}`,
  );
  const nonce = process.env.LETHAL_V3_GATE_NONCE;
  const receipt = process.env.LETHAL_V3_GATE_RECEIPT;
  if (nonce !== undefined && receipt !== undefined) {
    await writeV3Receipt(receipt, {
      nonce,
      binarySha256: sha,
      version,
      lethalCommit: (
        execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }) as string
      ).trim(),
      // F5: checked again at the end, so a file changed during the run counts too.
      dirty: dirty || dirtyFromStatus(statusNow()),
      outcome,
      legs,
      lines,
      ...(legCWarnFacts !== undefined ? { warnFacts: legCWarnFacts } : {}),
      oracleBcBuild: ORACLE_BC_BUILD,
      writtenAt: new Date().toISOString(),
    });
  }
  if (recorded !== undefined) {
    // Build review M4: exit 3 ("recorded, not a pass") only when every leg the run did not record
    // passed. A leg that failed its table (and so wrote nothing) makes the run exit 1, by name.
    // Shared with leg T's record run, where it changes nothing unless another selected leg failed.
    const failedBeside = v3RecordRunFailures(legs, recordedLegs, CANDIDATE, LEGS);
    if (failedBeside.length > 0) {
      throw new Error(
        `al-runner-v3 itest: FAIL: a record run with failed leg(s) ${failedBeside.join(", ")}; recorded ${[...recordedLegs].join(", ")} (delete those files before the next record run)`,
      );
    }
    throw recorded;
  }
  // R654 S2, ruling condition 2: every selected leg must pass, K included on a gated build (a
  // skip there fails); only a candidate's K may read `V3_K_CANDIDATE_SKIP` (`v3ItestFailures`).
  const bad = v3ItestFailures(legs, CANDIDATE, LEGS, K_ON_CANDIDATE);
  if (bad.length > 0) throw new Error(`al-runner-v3 itest: FAIL: ${bad.join(", ")}`);
  console.log(gateEndLine("al-runner-v3"));
  // R654 S2: agentflow's receipt (only when challenged), naming every leg that ran and passed.
  await finishGate(() =>
    emitPassed("alrunner-v3", {
      sublegs: Object.entries(legs)
        .filter(([, v]) => v === "pass")
        .map(([l]) => l),
      artifacts: { reported: false },
    }),
  );
}

main().catch(async (err: unknown) => {
  console.error(formatFailure(err));
  await emitFailed(
    "alrunner-v3",
    err instanceof BaselineRecordedError
      ? "record mode: baselines recorded, not a pass"
      : err instanceof Error
        ? err.message
        : String(err),
  );
  process.exit(err instanceof BaselineRecordedError ? 3 : nonPassExit(err, 1));
});
