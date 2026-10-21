/**
 * R586: `itest:alrunner-v3`, the gate of the al-runner-v3 backend (the Rust al-runner, pinned
 * alpha.2). Plan `docs/superpowers/plans/2026-10-21-r586-alrunner-v3-backend.md` §11-§12; every
 * figure is pre-committed in `docs/superpowers/specs/2026-10-21-r586-alrunner-v3-precommitment.md`
 * (dcdd1489), leg X (d) by its r5 delta
 * `docs/superpowers/specs/2026-10-21-r586-alrunner-v3-precommitment-r5-xd.md` (abe76fa6), leg C's
 * clock facts and X (d)'s baseline by r6
 * `docs/superpowers/specs/2026-10-21-r586-alrunner-v3-precommitment-r6.md` (c7c505e6).
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
 * - `LETHAL_ITEST_V3_LEGS=C,S1,...`: a subset (default every leg that is configured).
 * - `LETHAL_ITEST_V3_CDO=<Continia Document Output checkout at 5f2a71d>`: the D legs (a corpus job).
 * - `LETHAL_ITEST_V3_TABLES=1`: leg T (the update gate's tables leg).
 * - `LETHAL_V3_GATE_NONCE` + `LETHAL_V3_GATE_RECEIPT`: write the update gate's receipt.
 * No leg needs a BC server.
 */
import { execFileSync } from "node:child_process";
import { appendFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTROL_REGISTER_FILENAME,
  CONTROL_UPGRADE_FILENAME,
  emitStaticSelector,
} from "@lethal/schemata";
import {
  AlRunnerV3Backend,
  type AlRunnerV3Config,
  AlRunnerV3ResourceSelectorRefusedError,
  AlRunnerV3UnprovenBatchError,
  V3_REFUSED_NEARBY_TAG,
  V3_STATE_NOTE_TAG,
} from "../src/al-runner-v3-backend";
import { runV3ContractProbe } from "../src/al-runner-v3-contract";
import { AL_RUNNER_V3_DEFAULT_PATH, sha256OfFile } from "../src/al-runner-v3-pin";
import { SLEEP_NOTE_TAG } from "../src/al-runner-v3-sleep";
import { AlcCompileError } from "../src/artifact";
import { formatFailure } from "../src/format-failure";
import { type SessionConfig, runSession } from "../src/orchestrator";
import { effectiveBuildSymbols } from "../src/preprocessor-symbols";
import type { MutantOutcome, SessionReport } from "../src/report";
import { ResultsStore } from "../src/store";
import {
  type V3LegOutcome,
  cdoCheckoutRefusal,
  classifyLegT,
  gateOutcome,
  knownDifferenceKeys,
  writeV3Receipt,
} from "./al-runner-v3-gate";
import {
  BaselineRecordedError,
  assertGateBaseline,
  preflightGateBaseline,
  readGateBaseline,
  recordRequested,
} from "./baseline-guard";
import { compareMutants, normalizeForComparison } from "./mutant-equality";

if (!process.env.LETHAL_ITEST_ALRUNNER_V3) {
  console.log("al-runner-v3 itest: skipped (set LETHAL_ITEST_ALRUNNER_V3=1)");
  process.exit(0);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const TABLES_BASELINE_PATH = join(HERE, "al-runner-v3.tables.baseline.json");
const BIN = process.env.LETHAL_ALRUNNER_V3_PATH ?? AL_RUNNER_V3_DEFAULT_PATH;
const CANDIDATE = process.env.LETHAL_ALRUNNER_V3_CANDIDATE === "1";
const CACHE = process.env.LETHAL_ALRUNNER_V3_CACHE ?? "/work/tools/al-runtime-rs/cache";
const ALC = join(process.env.LETHAL_ALC_DIR ?? "", "alc");
const CDO = process.env.LETHAL_ITEST_V3_CDO;
const TABLES = process.env.LETHAL_ITEST_V3_TABLES === "1";
const SANDBOX_BC = "28.0.46665.47126";
const CDO_BC = "28.4.53241.53758";
const fixture = (n: string) => join(REPO, "fixtures", n);
const PROBE = join(REPO, "scripts", "r586-probe");

const configured = [
  "C",
  "S1",
  "S3",
  "N1",
  "X",
  ...(CDO !== undefined ? ["D1", "D1c"] : []),
  ...(TABLES ? ["T"] : []),
];
const LEGS = (process.env.LETHAL_ITEST_V3_LEGS ?? configured.join(","))
  .split(",")
  .map((s) => s.trim());

/** Oracle server BC builds, recorded beside v3's `--bc-version` (F8). */
const ORACLE_BC_BUILD: Record<string, string> = {
  S1: "bc1 BC 28.4.53241.56590 W1 (bcdev.baseline.json reproduced live, cited)",
  N1: "bc1 BC 28.4.53241.56590 W1 (bcdev.names.baseline.json reproduced live, cited)",
  D1: "bc3 BC 28.4 W1, Microsoft apps 28.4.53241.56646 (docs/measurements/r594/bc3-A)",
  D1c: "bc3 BC 28.4 W1, Microsoft apps 28.4.53241.56646 (docs/measurements/r594/bc3-B)",
  T: "none (own baseline; BC cross-check suspended)",
};

class LegFailure extends Error {}
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
    ...o,
  };
}

async function session(
  scratch: string,
  backend: AlRunnerV3Backend,
  cfg: Pick<SessionConfig, "projectDir" | "testDir" | "selectorIds"> & Partial<SessionConfig>,
): Promise<SessionReport> {
  const store = new ResultsStore(join(scratch, "lethal.sqlite"));
  try {
    return await runSession({
      backend,
      store,
      instrumentedDir: join(scratch, "instr"),
      ...cfg,
      emit: [
        (e) => {
          if (e.type === "warning") console.log(`  warn ${e.code}: ${e.message.slice(0, 300)}`);
        },
      ],
    });
  } finally {
    store.close();
    await backend.close();
  }
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

async function legC(scratch: string): Promise<void> {
  const r = await runV3ContractProbe({
    alRunnerPath: BIN,
    expectedVersion: (execFileSync(BIN, ["--version"], { encoding: "utf8" }) as string).trim(),
    packagesDir: await microsoftDeps(scratch),
    bcVersion: SANDBOX_BC,
    alcPath: ALC,
    cacheDir: CACHE,
    tasksetPath: "/usr/bin/taskset",
  });
  const DEFECTS = [
    "upstream-compile-errors",
    "duplicate-key-insert-raises",
    "sleep-is-noop",
    "refusal-cascade",
    "codeunit-runs-whole",
    "quoted-name-unselectable",
    "commit-under-test-isolation",
  ];
  for (const f of r.facts)
    console.log(`  C: ${f.fact} = ${f.verdict} | ${f.measured.slice(0, 200)}`);
  const off = r.facts.filter(
    (f) => f.verdict !== (DEFECTS.includes(f.fact) ? "defect-present" : "matches"),
  );
  must(off.length === 0, `C: ${off.map((f) => `${f.fact}=${f.verdict}`).join(", ")}`);
  must(r.facts.length === 23, `C: ${r.facts.length} facts, expected 23`);
}

async function legS1(scratch: string): Promise<void> {
  const b = new AlRunnerV3Backend(
    backendCfg({
      instrumentedDir: join(scratch, "backend"),
      testDir: fixture("sandbox-tests"),
      packagesDir: join(fixture("sandbox-tests"), ".alpackages"),
      bcVersion: SANDBOX_BC,
      selectorObjectId: 79199,
    }),
  );
  const r = await session(scratch, b, {
    projectDir: fixture("sandbox-app"),
    testDir: fixture("sandbox-tests"),
    selectorIds: { selectorId: 79199, controlId: 79198, tableId: 79197 },
  });
  assertCounts(r, "S1", 3, 12, 4, 19);
  await assertPerMutant(r, join(HERE, "bcdev.baseline.json"), "S1");
  must(
    r.baselineGreen && r.unsupportedTests.length === 0,
    "S1: baseline not green or a refused test",
  );
  must(
    tagged(r, V3_STATE_NOTE_TAG).length === 0,
    `S1: state notes ${tagged(r, V3_STATE_NOTE_TAG)}`,
  );
  must(tagged(r, V3_REFUSED_NEARBY_TAG).length === 0, "S1: refused-nearby notes");
  must(
    tagged(r, SLEEP_NOTE_TAG).length === 0 && refusedCause(r).length === 0,
    "S1: a §6 or runner refusal",
  );
  assertIndex(b, "S1", 0, 0);
  assertReproduced(r, "S1");
  must(
    r.validity.executionContexts.some((c) => c.runnerBuild !== undefined),
    "S1: no runnerBuild recorded",
  );
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
  await session(join(scratch, "s1"), b, {
    projectDir: fixture("sandbox-app"),
    testDir: fixture("sandbox-tests"),
    selectorIds: { selectorId: 79199, controlId: 79198, tableId: 79197 },
  }).catch(async () => {
    await mkdir(join(scratch, "s1"), { recursive: true });
    return undefined;
  });
  const instr = join(scratch, "s1", "instr");
  for (const e of await readdir(instr, { withFileTypes: true, recursive: true })) {
    if (e.isFile() && e.name === "mutant-manifest.json") return e.parentPath;
  }
  throw new LegFailure("X: no instrumented sandbox-app batch was written");
}

async function legX(scratch: string): Promise<void> {
  await mkdir(join(scratch, "s1"), { recursive: true });
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
    const x = e as { status?: number; stdout?: string };
    const doc = JSON.parse(x.stdout ?? "{}") as { passed?: number; notRun?: number };
    b7 = `exit ${x.status} passed ${doc.passed} notRun ${doc.notRun}`;
  }
  console.log(`  X (b): ${b7}`);
  must(b7 === "exit 7 passed 1 notRun 1", `X (b): ${b7}`);
  // (c1-c5) after a good deploy and activate("M0002").
  const tamper: [string, (active: string, tests: string, d: string) => Promise<void>][] = [
    ["c1", (a) => appendFile(join(a, "SandboxLogic.Codeunit.al"), " ")],
    [
      "c2",
      async (_a, t) => {
        const f = (await readdir(t)).find((n) => n.endsWith(".al"));
        if (f === undefined) throw new LegFailure("X: no test .al");
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
  // The multi-object file and its test leave the scratch copy: with coverage on, the v3 index
  // refuses a multi-object file (its frame is not measured on v3).
  await rm(join(app, "src", "ProbePair.Codeunit.al"));
  await rm(join(tests, "src", "ProbeCoverage.Codeunit.al"));
  const deps = await microsoftDeps(join(scratch, "x-d"));
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
    const r = await session(dir, b, {
      projectDir: app,
      testDir: tests,
      selectorIds: { selectorId: 50649, controlId: 50648, tableId: 50647 },
      only: ["src/ProbeSleeper.Codeunit.al"],
      testsOnly: ["src/ProbeSleep.Codeunit.al"],
    });
    for (const m of r.mutants) {
      console.log(
        `  X (${tag}): ${m.mutantCode} ${m.operatorName} ${m.verdict} ${m.killingTest ?? "-"} ${(m.failureNote ?? "").slice(0, 120)}`,
      );
    }
    return { r, b };
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
  const { r, b } = await run("d", recordHits);
  const idx = b.sleepIndexSize();
  console.log(`  X (d): Sleep index ${idx?.target} + ${idx?.test}`);
  must(idx?.target === 4 && idx?.test === 5, `X (d): Sleep index ${JSON.stringify(idx)}, r5 4 + 5`);
  // r6 (c): v3's virtual clock makes LongSleepThenAssert PASS, so the baseline is green and no
  // ProbeSleep test is unsupported.
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
  must(r.mutants.length === 5, `X (d): ${r.mutants.length} mutants, r5 5`);
  for (const m of r.mutants) {
    const want = R5[m.operatorName];
    const hits = hitsByMutant.get(m.mutantCode);
    console.log(`  X (d): ${m.mutantCode} hits ${JSON.stringify([...(hits ?? new Map())])}`);
    must(
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
  // (e) the coverage document removed under every mutant: no pass survives.
  const e = await run("e", async (p) => {
    await rm(p, { force: true });
  });
  must(
    e.r.mutants.every((m) => m.verdict !== "survived"),
    "X (e): a survivor with no coverage document",
  );
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
  must(
    f1.r.mutants.every((m) => m.verdict !== "survived"),
    "X (f1): a survivor with no per-test entry",
  );
  const f2 = await run(
    "f2",
    edit(async (j, sleepLines) => {
      for (const f of j.coverage.filter(isSleeper)) {
        const lines = await sleepLines(f);
        f.statements = f.statements.filter((s) => !lines.has(s.line));
      }
    }),
  );
  must(
    f2.r.mutants.every((m) => m.verdict !== "survived"),
    "X (f2): a survivor with an indexed line absent",
  );
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
  must(
    f3.r.mutants.every((m) => m.verdict !== "survived"),
    "X (f3): a survivor with an unowned Sleep hit",
  );
}

async function legD(scratch: string, leg: "D1" | "D1c"): Promise<void> {
  if (CDO === undefined) throw new LegFailure(`${leg}: LETHAL_ITEST_V3_CDO unset`);
  const git = (...a: string[]) => execFileSync("git", ["-C", CDO, ...a], { encoding: "utf8" });
  // `scripts/corpus-fingerprint.ts` (R187), run as a script: packages/ cannot import scripts/.
  const fpOut = execFileSync("bun", [join(REPO, "scripts", "corpus-fingerprint.ts"), CDO], {
    encoding: "utf8",
  });
  const fp = /^full sha256: ([0-9a-f]{64})$/m.exec(fpOut)?.[1];
  if (fp === undefined) throw new Error(`${leg}: corpus-fingerprint printed no sha256: ${fpOut}`);
  const head = git("rev-parse", "HEAD").trim();
  console.log(`  ${leg}: CDO ${CDO} at ${head}, corpus fingerprint ${fp.slice(0, 16)}`);
  const refused = cdoCheckoutRefusal({
    head,
    porcelain: git("status", "--porcelain"),
    fingerprint: fp,
  });
  if (refused !== undefined) throw new LegFailure(`${leg}: ${refused}`);
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

async function legT(scratch: string): Promise<SessionReport> {
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
  assertCounts(r, "T", 290, 57, 59, 406);
  must(
    r.unsupportedTests.length === 3,
    `T: ${r.unsupportedTests.length} refused tests, pre-committed 3`,
  );
  assertIndex(b, "T", 0, 0);
  console.log(
    `  T: notes state ${tagged(r, V3_STATE_NOTE_TAG).length}, refused-nearby ${tagged(r, V3_REFUSED_NEARBY_TAG).length}, §6 ${tagged(r, SLEEP_NOTE_TAG).length} (recorded, not predicted)`,
  );
  return r;
}

// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  if (LEGS.includes("T")) preflightGateBaseline(TABLES_BASELINE_PATH, "al-runner-v3 itest leg T");
  const sha = await sha256OfFile(BIN);
  const version = (execFileSync(BIN, ["--version"], { encoding: "utf8" }) as string).trim();
  const lethalHead = execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const dirty = execFileSync("git", ["-C", REPO, "status", "--porcelain", "--untracked-files=no"], {
    encoding: "utf8",
  }).trim();
  console.log(`al-runner-v3 itest: LethAL ${lethalHead}${dirty === "" ? "" : " (DIRTY)"}`);
  console.log(
    `al-runner-v3 itest: ${version} sha256 ${sha} (${BIN})${CANDIDATE ? " CANDIDATE" : ""}; legs ${LEGS.join(",")}`,
  );
  const legs: Record<string, V3LegOutcome> = {};
  const lines: string[] = [];
  const root = await mkdtemp(join(tmpdir(), "lethal-itest-v3-"));
  let recorded: BaselineRecordedError | undefined;
  try {
    for (const leg of LEGS) {
      const scratch = join(root, leg);
      await mkdir(scratch, { recursive: true });
      const t0 = Date.now();
      console.log(`leg ${leg}:`);
      try {
        if (leg === "C") await legC(scratch);
        else if (leg === "S1") await legS1(scratch);
        else if (leg === "S3") await legS3(scratch);
        else if (leg === "N1") await legN1(scratch);
        else if (leg === "X") await legX(scratch);
        else if (leg === "D1" || leg === "D1c") await legD(scratch, leg);
        else if (leg === "T") {
          const r = await legT(scratch);
          const record = recordRequested(TABLES_BASELINE_PATH);
          if (record) {
            // I-3 before anything is written: this run's rows differ from BC's on exactly the
            // pre-committed 52 (41 Commit, 7 duplicate key, 4 TestPage), or nothing is recorded.
            const bc = (await readGateBaseline(join(HERE, "tables.baseline.json"))).entries;
            const known = knownDifferenceKeys(bc, normalizeForComparison(r)).size;
            console.log(
              `  T: differs from BC's tables baseline on ${known} rows (pre-committed 52)`,
            );
            must(known === 52, `T: this run differs from BC's on ${known} rows, pre-committed 52`);
            await assertGateBaseline(r, TABLES_BASELINE_PATH, "al-runner-v3 itest leg T");
          } else {
            const own = (await readGateBaseline(TABLES_BASELINE_PATH)).entries;
            const bc = (await readGateBaseline(join(HERE, "tables.baseline.json"))).entries;
            // I-3: the known differences are the pre-committed 52 (41 Commit, 7 duplicate key, 4 TestPage).
            const known = knownDifferenceKeys(bc, own).size;
            must(
              known === 52,
              `T: v3's own baseline differs from BC's on ${known} rows, pre-committed 52`,
            );
            const t = classifyLegT(own, normalizeForComparison(r), bc);
            for (const l of t.lines) console.log(`  T: ${l}`);
            lines.push(...t.lines);
            if (t.outcome === "held") {
              legs[leg] = "held";
              continue;
            }
            await assertGateBaseline(r, TABLES_BASELINE_PATH, "al-runner-v3 itest leg T");
          }
        } else throw new LegFailure(`unknown leg ${leg}`);
        legs[leg] = "pass";
        console.log(`leg ${leg}: PASS (${Math.round((Date.now() - t0) / 1000)} s)`);
      } catch (err) {
        if (err instanceof BaselineRecordedError) {
          recorded = err;
          legs[leg] = "gate-fail";
          console.log(`leg ${leg}: RECORDED (not a pass)`);
          continue;
        }
        const msg = err instanceof Error ? err.message : String(err);
        legs[leg] =
          err instanceof LegFailure || /difference|BLOCK|differs/.test(msg)
            ? "gate-fail"
            : "infra-fail";
        lines.push(`${leg}: ${msg.slice(0, 1000)}`);
        console.log(`leg ${leg}: ${legs[leg]?.toUpperCase()} ${formatFailure(err).slice(0, 2000)}`);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
  const outcome = gateOutcome(legs);
  console.log(`al-runner-v3 itest: legs ${JSON.stringify(legs)}; update-gate outcome ${outcome}`);
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
      outcome,
      legs,
      lines,
      oracleBcBuild: ORACLE_BC_BUILD,
      writtenAt: new Date().toISOString(),
    });
  }
  if (recorded !== undefined) throw recorded;
  const bad = Object.entries(legs).filter(([, v]) => v !== "pass");
  if (bad.length > 0)
    throw new Error(`al-runner-v3 itest: FAIL: ${bad.map(([l, v]) => `${l}=${v}`).join(", ")}`);
  console.log("al-runner-v3 itest: PASS");
}

main().catch((err: unknown) => {
  console.error(formatFailure(err));
  process.exit(err instanceof BaselineRecordedError ? 3 : 1);
});
