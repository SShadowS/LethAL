#!/usr/bin/env bun
/**
 * R208's gate: the CHUNKED group path, live.
 *
 * Env-gated, standalone (`bun run itest:chunked`), never picked up by `bun test`. Skips cleanly
 * when LETHAL_ITEST_CHUNKED is unset.
 *
 * WHY THIS EXISTS. R198 §7/§8 pinned two "forced-chunk campaigns" as if a gate ran them; none did
 * (R208). Every other live gate runs a mutant's covering tests in ONE call, so `--max-methods-per-call`
 * was exercised by a differential UNIT test only. That gap became verdict-bearing with R206: the
 * warm confirmation replays the prefix of the CALL that produced the failure (`chunkPrefix`),
 * never the prefix of `ordered`. Unchunked the two lists are identical, so no existing gate can
 * tell them apart; chunked they differ, and the replay would then run a different session's worth
 * of tests than the mutated call did.
 *
 * WHAT MAKES THIS GATE UNABLE TO PASS FOR THE WRONG REASON. Two legs over the same narrowed slice,
 * one unbounded and one at `--max-methods-per-call 2`, and three separate jobs:
 *
 *   - THE DIFFERENTIAL: every mutant's verdict AND `killingTest` must be identical between the
 *     legs. Chunking is a cost knob; it must not move a verdict. This is what R198 §7 wanted.
 *   - THE POSITIONS: `killPosition` is CALL-relative, so chunking must MOVE it — four of the
 *     control's nine warm kills become cold (their killer heads its chunk) and five stay warm.
 *   - THE REPLAY LISTS: for each warm kill the recorded replay rows must be EXACTLY its chunk's
 *     methods. `M0015`/`M0016` are the pair to watch: their killer sits at ordered position 4, so
 *     `ordered`'s prefix is four methods starting at one test and the chunk's is two starting at
 *     another.
 *
 * WHICH ASSERTION CATCHES WHAT, RED-CHECKED 2026-09-04 by mutating `coveringRuns` and running this
 * gate, rather than asserted:
 *
 *   - Taking BOTH `groupPosition` and `chunkPrefix` from `ordered` (the coherent version of the
 *     bug R208 names) is caught HERE and only here: `warmKills` 9 instead of 5 and `groupedCalls`
 *     61 instead of 57, while THE DIFFERENTIAL STILL PASSED — every verdict and every killer was
 *     unchanged. That is the whole reason this gate exists: the bug is invisible to a verdict
 *     table, and every other live gate is unchunked, where the two prefixes are the same list.
 *   - Taking only `chunkPrefix` from `ordered` (right length, wrong methods) never reaches these
 *     assertions: `confirmWarm`'s own caller-contract check rejects it first, by name — "mutant
 *     M0015's step names position 2 but its chunk prefix has 2 method(s) ending in
 *     CategoryGuardNeedsCalcFields, not FlaggedFiresModifyTrigger". So the replay-list assertion
 *     below is NOT what stops that variant, and this comment used to claim it was. What it does
 *     pin is the residue that contract check cannot see — a prefix of the right length that ends
 *     at the right killer but began in the wrong place — and the CONTENT of a replay, which
 *     nothing else in this repo pins at all, so a refactor that weakens the contract check lands
 *     here instead of shipping.
 *
 * Every number below was PRE-COMMITTED in
 * `docs/superpowers/specs/2026-09-04-r208-chunked-gate-precommitment.md` before the chunked leg
 * had ever run: the unchunked leg was measured, and the chunked leg derived from it mechanically.
 *
 * The slice is `--only src/DataMain.Table.al`, the only file in this fixture whose kills reach
 * ordered position 5 (everything else has one or two covering tests, where chunking at 2 changes
 * nothing). 46 s per leg.
 *
 * Connection details come from the gitignored `fixtures/sandbox-data/lethal.config.local.json`,
 * the same file `itest:tables` reads, and the fixture's test app must already be published there.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ActivationConfig } from "../src/activation";
import { ArtifactCompiler, defaultArtifactIo } from "../src/artifact";
import { BcDevMcpBackend } from "../src/bcdev-backend";
import { odataBaseUrl, validateBcDevConfig } from "../src/cli";
import type { LethalConfigFile } from "../src/cli";
import { DeploymentVerifier } from "../src/deployment-verifier";
import { HarnessVerifier } from "../src/harness";
import { LeaseClient } from "../src/lease";
import { runSession } from "../src/orchestrator";
import { ContainerDeployer, defaultAlToolPaths, defaultDeployerIo } from "../src/publisher";
import type { SessionReport } from "../src/report";
import { RunMutantTransport } from "../src/run-mutant-transport";
import { ResultsStore } from "../src/store";

if (!process.env.LETHAL_ITEST_CHUNKED) {
  console.log("chunked itest: skipped (set LETHAL_ITEST_CHUNKED=1 to run against a live server)");
  process.exit(0);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const PROJECT_DIR = join(REPO_ROOT, "fixtures", "sandbox-data");
const TEST_DIR = join(REPO_ROOT, "fixtures", "sandbox-data-tests");
const LAUNCH_LOCAL_PATH = join(PROJECT_DIR, ".vscode", "launch.local.json");
const CONFIG_LOCAL_PATH = join(PROJECT_DIR, "lethal.config.local.json");
const SELECTOR_IDS = { selectorId: 79399, controlId: 79398, tableId: 79397 };

/** The slice: the only file in this fixture whose kills reach ordered position 5. */
const ONLY = ["src/DataMain.Table.al"];
const CHUNK = 2;

/** MEASURED on the unbounded leg, 2026-09-04, before the chunked leg existed. */
const CONTROL = {
  killed: 17,
  survived: 7,
  noCoverage: 2,
  warmKills: 9,
  groupedCalls: 33,
  /** killPosition histogram over the 17 kills. */
  positions: { 1: 8, 2: 3, 3: 3, 4: 2, 5: 1 } as Record<number, number>,
};

/** DERIVED from the control before the chunked leg ran. See the pre-commitment spec. */
const CHUNKED = {
  warmKills: 5,
  groupedCalls: 57,
  /** Every kill whose chunk position is 2, with the replay its chunk demands, in order. */
  warm: [
    {
      code: "M0007",
      line: 31,
      operator: "lethal.empty-block",
      killer: "CategoryGuardNeedsCalcFields",
      replay: ["BlankNoValidateFails", "CategoryGuardNeedsCalcFields"],
    },
    {
      code: "M0008",
      line: 47,
      operator: "lethal.remove-calcfields",
      killer: "CategoryGuardNeedsCalcFields",
      replay: ["BlankNoValidateFails", "CategoryGuardNeedsCalcFields"],
    },
    {
      code: "M0010",
      line: 49,
      operator: "lethal.void-method-call",
      killer: "CategoryGuardNeedsCalcFields",
      replay: ["BlankNoValidateFails", "CategoryGuardNeedsCalcFields"],
    },
    // THE TWO ROWS THIS GATE EXISTS FOR: ordered position 4, chunk position 2, so the replay is
    // chunk 2's two methods and NOT `ordered`'s four. The lists even start at a different test.
    {
      code: "M0015",
      line: 69,
      operator: "lethal.empty-block",
      killer: "FlaggedFiresModifyTrigger",
      replay: ["ProcessedRequiresCategory", "FlaggedFiresModifyTrigger"],
    },
    {
      code: "M0016",
      line: 75,
      operator: "lethal.swap-modify-flag",
      killer: "FlaggedFiresModifyTrigger",
      replay: ["ProcessedRequiresCategory", "FlaggedFiresModifyTrigger"],
    },
  ],
  /** Warm in the control, COLD once chunked: the killer heads its chunk. */
  nowCold: [
    { code: "M0011", line: 55, operator: "lethal.empty-block" },
    { code: "M0012", line: 62, operator: "lethal.remove-testfield" },
    { code: "M0017", line: 75, operator: "lethal.void-method-call" },
    { code: "M0020", line: 104, operator: "lethal.empty-block" },
  ],
};

interface LaunchLocalConfig {
  readonly configurations: ReadonlyArray<{
    // The literal union `BcDevConfig` declares, not `string`: under `exactOptionalPropertyTypes`
    // a widened `string` is not assignable to it.
    readonly environmentType?: "OnPrem" | "Sandbox" | "Production";
    readonly environmentName?: string;
  }>;
}

async function readJson<T>(path: string, what: string): Promise<T> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(
      `cannot read ${what} at ${path}: ${err instanceof Error ? err.message : String(err)}. See fixtures/README.md.`,
    );
  }
  return JSON.parse(text) as T;
}

async function readOptionalLaunchConfig(): Promise<LaunchLocalConfig["configurations"][number]> {
  let text: string;
  try {
    text = await readFile(LAUNCH_LOCAL_PATH, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  return (JSON.parse(text) as LaunchLocalConfig).configurations[0] ?? {};
}

/** One mutant's replay: the methods recorded with `mutant_code IS NULL` and `op_kind = 'many'`. */
interface LegResult {
  readonly report: SessionReport;
  /** mutantCode -> the replay's method names, in recorded order (absent when none ran). */
  readonly replays: ReadonlyMap<string, readonly string[]>;
  /** mutantCode -> how many methods each covering call ran, in call order. */
  readonly callSizes: ReadonlyMap<string, readonly number[]>;
}

async function runLeg(scratchRoot: string, maxMethodsPerCall?: number): Promise<LegResult> {
  const launchCfg = await readOptionalLaunchConfig();
  const configFile = await readJson<LethalConfigFile>(
    CONFIG_LOCAL_PATH,
    "lethal.config.local.json",
  );
  const bcdev = validateBcDevConfig(configFile.bcdev);
  const toolPaths = await defaultAlToolPaths();
  if (!toolPaths) {
    throw new Error("could not locate alc.exe/altool.exe under the AL Language extension install");
  }

  const outputDir = join(scratchRoot, "publish");
  await mkdir(outputDir, { recursive: true });
  const compiler = new ArtifactCompiler(
    { alcPath: toolPaths.alcPath, packageCachePath: bcdev.packageCachePath, outputDir },
    defaultArtifactIo,
  );
  const deployer = new ContainerDeployer(
    {
      altoolPath: toolPaths.altoolPath,
      server: bcdev.server,
      serverInstance: bcdev.serverInstance,
      username: bcdev.username,
      password: bcdev.password,
      ...(bcdev.tenant !== undefined ? { tenant: bcdev.tenant } : {}),
    },
    defaultDeployerIo,
  );
  const odataCfg: ActivationConfig = {
    baseUrl: odataBaseUrl(bcdev.server, bcdev.serverInstance),
    company: bcdev.company,
    username: bcdev.username,
    password: bcdev.password,
    ...(bcdev.tenant !== undefined ? { tenant: bcdev.tenant } : {}),
  };
  const verifier = new DeploymentVerifier(odataCfg);
  const harnessVerifier = new HarnessVerifier(odataCfg);
  const backend = new BcDevMcpBackend(
    {
      mcpCommand: bcdev.mcpCommand,
      project: PROJECT_DIR,
      server: bcdev.server,
      serverInstance: bcdev.serverInstance,
      company: bcdev.company,
      packageCachePath: bcdev.packageCachePath,
      controlSymbolPath: bcdev.controlSymbolPath,
      ...(bcdev.tenant !== undefined ? { tenant: bcdev.tenant } : {}),
      ...(launchCfg.environmentType !== undefined
        ? { environmentType: launchCfg.environmentType }
        : {}),
      ...(launchCfg.environmentName !== undefined
        ? { environmentName: launchCfg.environmentName }
        : {}),
      ...(bcdev.env !== undefined ? { env: bcdev.env } : {}),
      ...(bcdev.coverageMode !== undefined ? { coverageMode: bcdev.coverageMode } : {}),
    },
    undefined,
    { compiler, deployer, verifier, harnessVerifier },
    (targetAppId, artifactId) => new RunMutantTransport(odataCfg, targetAppId, artifactId),
  );

  // A SCRATCH store, not the fixture's own lethal.sqlite: this gate runs a NARROWED slice twice
  // and must not disturb `itest:tables`' resume history in fixtures/sandbox-data/lethal.sqlite.
  const store = new ResultsStore(join(scratchRoot, "chunked.sqlite"));
  try {
    const report = await runSession({
      backend,
      store,
      projectDir: PROJECT_DIR,
      testDir: TEST_DIR,
      instrumentedDir: join(scratchRoot, "instrumented"),
      selectorIds: SELECTOR_IDS,
      only: ONLY,
      ...(maxMethodsPerCall !== undefined ? { groupRuns: { maxMethodsPerCall } } : {}),
      lease: {
        client: new LeaseClient(odataCfg),
        serverGeneration: async () => (await harnessVerifier.verify()).serverGeneration,
      },
      resourceServer: bcdev.server,
      resourceServerInstance: bcdev.serverInstance,
      quarantineDir: join(scratchRoot, "quarantine"),
    });

    const runId = (store.db.query("SELECT MAX(id) AS id FROM runs").get() as { id: number }).id;
    const codeOf = new Map<number, string>();
    for (const r of store.db
      .query("SELECT id, mutant_code FROM mutants WHERE run_id = ?")
      .all(runId) as Array<{ id: number; mutant_code: string }>) {
      codeOf.set(r.id, r.mutant_code);
    }
    const replays = new Map<string, string[]>();
    const callSizes = new Map<string, number[]>();
    let lastSession: number | null = null;
    let lastCode: string | null = null;
    for (const r of store.db
      .query(
        "SELECT mutant_row_id, mutant_code, method, op_kind, session_id FROM test_results " +
          "WHERE run_id = ? AND op_kind = 'many' ORDER BY id",
      )
      .all(runId) as Array<{
      mutant_row_id: number | null;
      mutant_code: string | null;
      method: string;
      op_kind: string;
      session_id: number | null;
    }>) {
      const owner = r.mutant_row_id === null ? undefined : codeOf.get(r.mutant_row_id);
      if (owner === undefined) continue;
      if (r.mutant_code === null) {
        // A replay row: `mutantCode` null, still attributed to the mutant it confirms.
        const list = replays.get(owner) ?? [];
        list.push(r.method);
        replays.set(owner, list);
      } else {
        // A covering row. One call is one session, so a change of session id starts a new call.
        const sizes = callSizes.get(owner) ?? [];
        if (r.session_id !== lastSession || owner !== lastCode || sizes.length === 0) {
          sizes.push(0);
        }
        sizes[sizes.length - 1] = (sizes[sizes.length - 1] ?? 0) + 1;
        callSizes.set(owner, sizes);
        lastSession = r.session_id;
        lastCode = owner;
      }
    }
    return { report, replays, callSizes };
  } finally {
    store.close();
    await backend.close();
  }
}

function verdictTable(report: SessionReport) {
  return new Map(
    report.mutants.map((m) => [
      `${m.line}:${m.operatorName}:${m.mutantCode}`,
      { verdict: m.verdict, killingTest: m.killingTest ?? null },
    ]),
  );
}

function find(report: SessionReport, code: string, line: number, operator: string) {
  const m = report.mutants.find(
    (x) => x.mutantCode === code && x.line === line && x.operatorName === operator,
  );
  assert.ok(m !== undefined, `no mutant ${code} at line ${line} for ${operator}`);
  return m;
}

function assertNoNewCauses(report: SessionReport, leg: string): void {
  for (const cause of [
    "session-reused",
    "warm-prefix-unstable",
    "warm-timeout-unconfirmed",
    "warm-confirmation-incomplete",
    "unstable",
  ] as const) {
    const hit = report.mutants.filter((m) => m.cause === cause);
    assert.equal(
      hit.length,
      0,
      `${leg}: ${hit.length} mutant(s) with cause ${cause} — ${hit
        .map((m) => `${m.mutantCode} ${m.failureNote ?? ""}`)
        .join(" | ")
        .slice(0, 400)}`,
    );
  }
  assert.equal(report.counts.errors, 0, `${leg}: no mutant may error on the healthy path`);
}

function dump(leg: string, r: SessionReport): void {
  console.log(
    `  [${leg}] killed=${r.counts.killed} survived=${r.counts.survived} ` +
      `noCoverage=${r.counts.noCoverage} errors=${r.counts.errors} ` +
      `warmKills=${r.warmKills} groupedCalls=${r.groupedCalls}`,
  );
}

async function main(): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), "lethal-itest-chunked-"));
  try {
    console.log("chunked itest: leg 1 of 2 — unbounded (the control)");
    const control = await runLeg(join(scratch, "control"));
    dump("unbounded", control.report);

    console.log(`chunked itest: leg 2 of 2 — --max-methods-per-call ${CHUNK}`);
    const chunked = await runLeg(join(scratch, "chunked"), CHUNK);
    dump(`chunked ${CHUNK}`, chunked.report);

    // 1. The control's own numbers, so a change in the FIXTURE is caught here rather than being
    //    absorbed as a change in what chunking does.
    assert.equal(control.report.counts.killed, CONTROL.killed, "control: killed");
    assert.equal(control.report.counts.survived, CONTROL.survived, "control: survived");
    assert.equal(control.report.counts.noCoverage, CONTROL.noCoverage, "control: no-coverage");
    assert.equal(control.report.warmKills, CONTROL.warmKills, "control: warmKills");
    assert.equal(control.report.groupedCalls, CONTROL.groupedCalls, "control: groupedCalls");
    const controlPositions: Record<number, number> = {};
    for (const m of control.report.mutants) {
      if (m.verdict !== "killed" && m.verdict !== "timeout-killed") continue;
      assert.ok(m.killPosition !== undefined, `control: ${m.mutantCode} kill without a position`);
      controlPositions[m.killPosition] = (controlPositions[m.killPosition] ?? 0) + 1;
    }
    assert.deepEqual(
      controlPositions,
      CONTROL.positions,
      "control: killPosition histogram (the ORDERED positions chunking will move)",
    );
    assertNoNewCauses(control.report, "control");

    // 2. THE DIFFERENTIAL. Chunking is a cost knob and must not move a verdict or a killer.
    //    This is the assertion R198 §7 promised and never had.
    const a = verdictTable(control.report);
    const b = verdictTable(chunked.report);
    assert.equal(a.size, b.size, "the two legs scored a different number of mutants");
    for (const [key, want] of a) {
      const got = b.get(key);
      assert.ok(got !== undefined, `chunked leg is missing ${key}`);
      assert.deepEqual(
        got,
        want,
        `${key}: chunking moved a verdict or its killer (unbounded ${JSON.stringify(want)}, ` +
          `chunked ${JSON.stringify(got)}) — chunking is a cost knob, never a semantic one`,
      );
    }
    assertNoNewCauses(chunked.report, "chunked");

    // 3. The chunked leg's own counts, pre-committed.
    assert.equal(chunked.report.warmKills, CHUNKED.warmKills, "chunked: warmKills");
    assert.equal(chunked.report.groupedCalls, CHUNKED.groupedCalls, "chunked: groupedCalls");

    // 4. No call ran more than the cap. Read from the store, so a build that ignored the flag
    //    entirely (and matched every verdict) still fails.
    for (const [code, sizes] of chunked.callSizes) {
      for (const n of sizes) {
        assert.ok(
          n <= CHUNK,
          `chunked: ${code} had a covering call of ${n} methods, over the cap of ${CHUNK} ` +
            `(sizes ${JSON.stringify(sizes)}) — --max-methods-per-call was not honoured`,
        );
      }
    }
    assert.ok(
      [...chunked.callSizes.values()].some((s) => s.length > 1),
      "chunked: no mutant took more than one covering call — nothing was actually chunked",
    );

    // 5. THE POSITIONS. `killPosition` is CALL-relative, so chunking MOVES it: five kills stay
    //    warm at chunk position 2, and four that were warm become cold.
    for (const w of CHUNKED.warm) {
      const m = find(chunked.report, w.code, w.line, w.operator);
      assert.equal(m.verdict, "killed", `chunked: ${w.code} verdict`);
      assert.equal(m.killingTest, w.killer, `chunked: ${w.code} killer`);
      assert.equal(
        m.killPosition,
        2,
        `chunked: ${w.code} killPosition ${m.killPosition}, expected 2 (chunk-relative)`,
      );
    }
    for (const c of CHUNKED.nowCold) {
      const m = find(chunked.report, c.code, c.line, c.operator);
      const before = find(control.report, c.code, c.line, c.operator);
      assert.ok(
        (before.killPosition ?? 1) > 1,
        `${c.code} must be WARM in the control for this row to mean anything (was ${before.killPosition})`,
      );
      assert.equal(
        m.killPosition,
        1,
        `chunked: ${c.code} killPosition ${m.killPosition}, expected 1 — chunking puts its killer at the head of its chunk, so it takes the COLD confirmation`,
      );
      assert.equal(
        chunked.replays.get(c.code),
        undefined,
        `chunked: ${c.code} is cold and must have written NO replay rows`,
      );
    }

    // 6. THE REPLAY LISTS — the assertion this gate exists for. A replay must be its CHUNK's
    //    prefix; `ordered`'s prefix is a different list (four methods, starting at a different
    //    test, for M0015/M0016) and would put the confirmation in a session the mutated call
    //    never had.
    for (const w of CHUNKED.warm) {
      const got = chunked.replays.get(w.code);
      assert.ok(
        got !== undefined,
        `chunked: ${w.code} is warm (killPosition 2) but wrote no replay rows`,
      );
      assert.deepEqual(
        [...got],
        w.replay,
        `chunked: ${w.code}'s replay ran ${JSON.stringify(got)}, expected exactly its CHUNK's methods ${JSON.stringify(w.replay)}. A replay built from \`ordered\` instead of \`chunkPrefix\` fails HERE and nowhere else in this repo (R208)`,
      );
    }

    // 7. And the control's own replays are the longer, ordered-prefix ones — so the two legs
    //    disagree about replay length exactly where the design says they must.
    const controlReplay = control.replays.get("M0015");
    assert.ok(controlReplay !== undefined, "control: M0015 must be warm and replay");
    assert.equal(
      controlReplay.length,
      4,
      `control: M0015's replay ran ${controlReplay.length} method(s), expected 4 (its killer is at ORDERED position 4 when nothing is chunked). If this is 2, the two legs are not actually running different chunkings and the gate proves nothing`,
    );

    console.log("chunked itest: PASS");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
