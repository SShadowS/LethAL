/**
 * PR-340: `itest:alrunner-v3-carry`, the gate of the SingleInstance carry walk on al-runner-v3.
 * Pre-commitment `docs/superpowers/specs/2026-11-22-pr340-v3-carry-walk.md` §7; page
 * `docs/gates/alrunner-v3-carry.md`.
 *
 *   LETHAL_ITEST_ALRUNNER_V3_CARRY=1 bun run itest:alrunner-v3-carry
 *
 * One fixture (`fixtures/sandbox-carry` and `-tests`, ids 71760-71779), one lane, two sessions:
 * - `walk`: `LETHAL_V3_CARRY_WALK` on (the default). M0009-M0011 are killed by `ComputeIsPlain`, each with
 *   `[singleinstance-carry-killed]`; the counts are 8 killed, 5 survived, 0 errors. M0012 and M0013 are scored
 *   on the SAME daemon after those walks: M0012 survives and M0013 is killed, as today.
 * - `off`: `LETHAL_V3_CARRY_WALK=off`. Today's table: M0009-M0011 survived, each labelled
 *   `[singleinstance-carry-unobservable]`; nothing else moves.
 * The `walk` session is then compared per mutant with `al-runner-v3.carry.baseline.json` (R332: this gate
 * REFUSES to start while that file is missing, and prints the command that records it).
 * Needs no BC server. The build it runs against is the first line. The build must be carry-proven
 * (`batch-sequential-carry` recorded `matches` in its gate record), else the walk arm fails by name.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AlRunnerV3Backend, CARRY_WALK_ENV } from "../src/al-runner-v3-backend";
import {
  AL_RUNNER_V3_DEFAULT_PATH,
  checkGated,
  resolveV3Binary,
  sha256OfFile,
} from "../src/al-runner-v3-pin";
import { FRESH_PROBE_ENV } from "../src/al-runner-v3-probe-cache";
import { formatFailure } from "../src/format-failure";
import { type SessionConfig, runSession } from "../src/orchestrator";
import type { MutantOutcome, SessionReport } from "../src/report";
import { ResultsStore } from "../src/store";
import { v3GateBackendCfg } from "./al-runner-v3-gate";
import { judgeCarryOrder } from "./alrunner-v3-legs";
import { BaselineRecordedError, assertGateBaseline, preflightGateBaseline } from "./baseline-guard";
import { prepareFixtureSymbols, v3GateTestDir } from "./fixture-symbols";
import { emitFailed, emitPassed, emitSkipped } from "./gate-receipt";
import {
  checkGateWarnings,
  collectWarnings,
  finishGate,
  gateEndLine,
  nonPassExit,
  preflightObserve,
  settleThrown,
} from "./gate-warnings";

if (!process.env.LETHAL_ITEST_ALRUNNER_V3_CARRY) {
  console.log("al-runner-v3 carry itest: skipped (set LETHAL_ITEST_ALRUNNER_V3_CARRY=1)");
  const challenged = await emitSkipped("alrunner-v3-carry", "the leg's env var is unset");
  process.exit(challenged ? 1 : 0);
}

// R762: the probe is measured, never replayed: the carry fact must be read from this very build.
process.env[FRESH_PROBE_ENV] = "1";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const BASELINE_PATH = join(HERE, "al-runner-v3.carry.baseline.json");
const BIN = resolveV3Binary(process.env.LETHAL_ALRUNNER_V3_PATH ?? AL_RUNNER_V3_DEFAULT_PATH);
const CACHE = process.env.LETHAL_ALRUNNER_V3_CACHE ?? "/work/tools/al-runtime-rs/cache";
const ALC = join(process.env.LETHAL_ALC_DIR ?? "", "alc");
const SANDBOX_BC = "28.0.46665.47126";
const fixture = (n: string) => join(REPO, "fixtures", n);
const SELECTOR_IDS = { selectorId: 71769, controlId: 71768, tableId: 71767 };

/** §7, pre-committed per mutant code (re-stated by site key before recording). */
const CARRY_KILLED = ["M0009", "M0010", "M0011"];
const KILLED_AS_TODAY = ["M0001", "M0002", "M0003", "M0005", "M0013"];
const SURVIVE_PLAIN = ["M0004", "M0006", "M0007", "M0008", "M0012"];
const KILLER = "ComputeIsPlain";
const KILLED_TAG = "[singleinstance-carry-killed]";
const LABEL_TAG = "[singleinstance-carry-unobservable]";

class CarryFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CarryFailure";
  }
}
const must = (cond: boolean, what: string): void => {
  if (!cond) throw new CarryFailure(what);
};

const byCode = (r: SessionReport, code: string): MutantOutcome | undefined =>
  r.mutants.find((m) => m.mutantCode === code);

/** The Microsoft apps of sandbox-tests' `.alpackages` (no LethAL copy). */
async function microsoftDeps(scratch: string): Promise<string> {
  const dir = join(scratch, "ms-deps");
  await mkdir(dir, { recursive: true });
  const src = join(fixture("sandbox-tests"), ".alpackages");
  for (const f of await readdir(src)) {
    if (f.startsWith("Microsoft_")) await cp(join(src, f), join(dir, f));
  }
  return dir;
}

let testDirStage: string | undefined;
function gateTestDir(testDir: string): string {
  return v3GateTestDir(REPO, testDir, () => {
    testDirStage ??= mkdtempSync(join(tmpdir(), "lethal-v3-carry-testdirs-"));
    return join(testDirStage, basename(testDir));
  });
}

/** One lane, serve-entries: the figures are pre-committed for this shape only. */
async function runArm(
  scratch: string,
  arm: "walk" | "off",
): Promise<{
  readonly report: SessionReport;
  readonly carryOff: string | undefined;
  /** S1: the run's walks and serve requests in time order (`judgeCarryOrder`). */
  readonly order: readonly string[];
}> {
  await mkdir(scratch, { recursive: true });
  const order: string[] = [];
  const projectDir = fixture("sandbox-carry");
  const testDir = fixture("sandbox-carry-tests");
  const packagesDir = await microsoftDeps(scratch);
  const backend = new AlRunnerV3Backend(
    v3GateBackendCfg(
      {
        alRunnerPath: BIN,
        alcPath: ALC,
        cacheDir: CACHE,
        candidate: false,
        transport: { transport: "serve-entries" },
        environment: "saas",
      },
      {
        instrumentedDir: join(scratch, "backend"),
        testDir: gateTestDir(testDir),
        packagesDir,
        bcVersion: SANDBOX_BC,
        selectorObjectId: SELECTOR_IDS.selectorId,
        sourceProjectDir: projectDir,
      },
    ),
  );
  // S1: the mark of a walk that REALLY sent (a call that sends nothing, M0012's, leaves none).
  backend.setCarryWalkSink(() => order.push("walk"));
  const store = new ResultsStore(join(scratch, "lethal.sqlite"));
  const collected = collectWarnings();
  const was = process.env[CARRY_WALK_ENV];
  if (arm === "off") process.env[CARRY_WALK_ENV] = "off";
  else Reflect.deleteProperty(process.env, CARRY_WALK_ENV);
  try {
    const report = await runSession({
      backend,
      store,
      instrumentedDir: join(scratch, "instr"),
      projectDir,
      testDir,
      selectorIds: SELECTOR_IDS,
      workers: 1,
      emit: [
        collected.subscriber,
        (e: { type: string; kind?: string }) => {
          if (e.type === "serve-request-timed") order.push(`req:${e.kind}`);
          // S1 (b): a close of the lane's daemon after the last walk makes a later request prove nothing.
          if (e.type === "serve-daemon-closed") order.push("close");
        },
      ],
    } as unknown as SessionConfig).catch((e: unknown) => {
      settleThrown("al-runner-v3-carry", arm, collected);
      throw e;
    });
    checkGateWarnings("al-runner-v3-carry", arm, collected);
    return { report, carryOff: backend.carryWalkOffWhy(), order };
  } finally {
    if (was === undefined) Reflect.deleteProperty(process.env, CARRY_WALK_ENV);
    else process.env[CARRY_WALK_ENV] = was;
    store.close();
    await backend.close();
  }
}

const noCarryTag = (m: MutantOutcome | undefined): boolean =>
  !(m?.failureNote ?? "").includes("singleinstance-carry");

function assertWalkArm(r: SessionReport, carryOff: string | undefined): void {
  console.log(
    `  walk: ${r.counts.killed} killed / ${r.counts.survived} survived / ${r.counts.noCoverage} no-coverage (errors ${r.counts.errors}) over ${r.mutants.length}`,
  );
  must(carryOff === undefined, `walk: the build is not carry-proven (${carryOff ?? ""})`);
  for (const code of CARRY_KILLED) {
    const m = byCode(r, code);
    must(m?.verdict === "killed", `walk: ${code} is ${m?.verdict}, pre-committed killed`);
    must(
      m?.killingTest?.includes(KILLER) === true,
      `walk: ${code} killed by ${m?.killingTest}, pre-committed ${KILLER}`,
    );
    must(
      (m?.failureNote ?? "").includes(KILLED_TAG),
      `walk: ${code} has no ${KILLED_TAG} in its note`,
    );
    must(
      !(m?.failureNote ?? "").includes(LABEL_TAG),
      `walk: ${code} still carries the unobservable label`,
    );
  }
  // After the walks, on the same daemon: M0012 survives, M0013 is killed, as today.
  for (const code of KILLED_AS_TODAY) {
    const m = byCode(r, code);
    must(m?.verdict === "killed", `walk: ${code} is ${m?.verdict}, pre-committed killed`);
  }
  for (const code of SURVIVE_PLAIN) {
    const m = byCode(r, code);
    must(m?.verdict === "survived", `walk: ${code} is ${m?.verdict}, pre-committed survived`);
    must(noCarryTag(m), `walk: ${code} carries a carry tag, pre-committed none`);
  }
  must(
    r.counts.killed === 8 && r.counts.survived === 5 && r.counts.errors === 0,
    `walk: ${r.counts.killed} killed / ${r.counts.survived} survived / ${r.counts.errors} errors, pre-committed 8 / 5 / 0`,
  );
}

function assertOffArm(r: SessionReport, walkArm: SessionReport): void {
  console.log(
    `  off: ${r.counts.killed} killed / ${r.counts.survived} survived / ${r.counts.noCoverage} no-coverage (errors ${r.counts.errors}) over ${r.mutants.length}`,
  );
  for (const code of CARRY_KILLED) {
    const m = byCode(r, code);
    must(m?.verdict === "survived", `off: ${code} is ${m?.verdict}, pre-committed survived`);
    must(
      (m?.failureNote ?? "").includes(LABEL_TAG),
      `off: ${code} has no ${LABEL_TAG} label, pre-committed labelled`,
    );
    must(
      !(m?.failureNote ?? "").includes("[singleinstance-carry-walk"),
      `off: ${code} was walked with the knob off`,
    );
  }
  for (const code of KILLED_AS_TODAY) {
    must(byCode(r, code)?.verdict === "killed", `off: ${code} is not killed, as today`);
    // L4: the killer too, not the verdict alone: as today means the walk arm's killer, test for test.
    must(
      byCode(r, code)?.killingTest !== undefined &&
        byCode(r, code)?.killingTest === byCode(walkArm, code)?.killingTest,
      `off: ${code} killed by ${byCode(r, code)?.killingTest}, the walk arm's ${byCode(walkArm, code)?.killingTest}`,
    );
  }
  for (const code of [...CARRY_KILLED, ...SURVIVE_PLAIN]) {
    must(
      byCode(r, code)?.killingTest === undefined || byCode(r, code)?.killingTest === null,
      `off: ${code} survives, yet names the killer ${byCode(r, code)?.killingTest}`,
    );
  }
  for (const code of SURVIVE_PLAIN) {
    const m = byCode(r, code);
    must(m?.verdict === "survived" && noCarryTag(m), `off: ${code} moved`);
  }
  must(
    r.counts.killed === 5 && r.counts.survived === 8 && r.counts.errors === 0,
    `off: ${r.counts.killed} killed / ${r.counts.survived} survived / ${r.counts.errors} errors, pre-committed 5 / 8 / 0`,
  );
}

async function main(): Promise<void> {
  preflightObserve();
  // R332: refuses to start while the baseline is missing, naming the record command.
  preflightGateBaseline(BASELINE_PATH, "al-runner-v3 carry itest");
  const prepared = await prepareFixtureSymbols({ worktree: REPO });
  console.log(`al-runner-v3 carry itest: fixture .alpackages ${prepared}`);
  const sha = await sha256OfFile(BIN);
  const version = (execFileSync(BIN, ["--version"], { encoding: "utf8" }) as string).trim();
  // The first line names the build, as every v3 gate does.
  console.log(`al-runner-v3 carry itest: ${version} sha256 ${sha} (${BIN})`);
  // L4: an ungated build fails this gate loudly; nothing is swallowed.
  await checkGated(BIN, version, { candidate: false });
  const root = await mkdtemp(join(tmpdir(), "lethal-itest-v3-carry-"));
  try {
    const walk = await runArm(join(root, "walk"), "walk");
    assertWalkArm(walk.report, walk.carryOff);
    // S1: the after-walk pin holds only if an ordinary request really followed the last walk.
    const orderProblem = judgeCarryOrder(walk.order);
    must(orderProblem === undefined, `walk: ${orderProblem ?? ""}`);
    console.log(`  walk: order ${walk.order.join(" ")}`);
    const off = await runArm(join(root, "off"), "off");
    assertOffArm(off.report, walk.report);
    // Last: a record run writes the walk arm once and exits 3 (R332).
    await assertGateBaseline(walk.report, BASELINE_PATH, "al-runner-v3 carry itest");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  console.log(gateEndLine("al-runner-v3 carry"));
  await finishGate(() =>
    emitPassed("alrunner-v3-carry", { sublegs: ["walk", "off"], artifacts: { reported: false } }),
  );
}

main().catch(async (err: unknown) => {
  console.error(formatFailure(err));
  await emitFailed(
    "alrunner-v3-carry",
    err instanceof BaselineRecordedError
      ? "record mode: baseline recorded, not a pass"
      : err instanceof Error
        ? err.message
        : String(err),
  );
  process.exit(err instanceof BaselineRecordedError ? 3 : nonPassExit(err, 1));
});
