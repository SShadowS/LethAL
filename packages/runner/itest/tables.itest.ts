#!/usr/bin/env bun
/**
 * Env-gated integration test against a live bc-dev-mcp + Business Central dev server, pointed at
 * the TABLE fixture (`fixtures/sandbox-data` + `fixtures/sandbox-data-tests`) rather than the
 * codeunit one. NOT a `bun:test` file — a standalone script invoked via `bun run itest:tables`
 * (root package.json), never picked up by `bun test`.
 *
 * Skips cleanly (exit 0) when LETHAL_ITEST_TABLES is unset.
 *
 * WHY THIS EXISTS AS A COMMITTED GATE. Tier-2 Phase 0's whole claim is that a mutation living
 * inside a table trigger is generated, attributed, instrumented, executed and killed on a real
 * server. Every OTHER result in this repo is frozen per-mutant and asserted
 * (`bcdev.baseline.json`, `al-runner.baseline.json`); the table result was recorded once, by
 * hand, into `fixtures/README.md`, with no committed gate — so a regression in trigger
 * attribution, in the (objectType, objectId) coverage key, or in table selector-var injection
 * would break the one behaviour Phase 0 exists to prove and nothing would fail. `assertVerdictTable`
 * below plus `assertMatchesBaseline` close that.
 *
 * Connection details are never committed: this script reads
 *   fixtures/sandbox-data/lethal.config.local.json         (LethAL bcdev section — gitignored)
 *   fixtures/sandbox-data/.vscode/launch.local.json        (OPTIONAL — gitignored)
 * Note the config is the sandbox-data one, NOT sandbox-app's: the two fixtures target DIFFERENT
 * containers (and different .alpackages), so cross-reading would publish this app to the wrong
 * server. See fixtures/README.md for the expected shape.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MutantManifest, MutantManifestEntry } from "@lethal/schemata";
import type { ActivationConfig } from "../src/activation";
import { ArtifactCompiler, defaultArtifactIo } from "../src/artifact";
import { BcDevMcpBackend } from "../src/bcdev-backend";
import { odataBaseUrl, validateBcDevConfig } from "../src/cli";
import type { LethalConfigFile } from "../src/cli";
import { DeploymentVerifier } from "../src/deployment-verifier";
import { HarnessVerifier } from "../src/harness";
import { LeaseClient } from "../src/lease";
import { generateMutationSet, runSession } from "../src/orchestrator";
import { ContainerDeployer, defaultAlToolPaths, defaultDeployerIo } from "../src/publisher";
import type { SessionReport } from "../src/report";
import { RunMutantTransport } from "../src/run-mutant-transport";
import { ResultsStore } from "../src/store";
import { assertMatchesBaseline } from "./baseline-guard";

if (!process.env.LETHAL_ITEST_TABLES) {
  console.log(
    "skipped (set LETHAL_ITEST_TABLES=1 and populate the gitignored " +
      "fixtures/sandbox-data/lethal.config.local.json to run against a live dev server)",
  );
  process.exit(0);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const PROJECT_DIR = join(REPO_ROOT, "fixtures", "sandbox-data");
const TEST_DIR = join(REPO_ROOT, "fixtures", "sandbox-data-tests");
const LAUNCH_LOCAL_PATH = join(PROJECT_DIR, ".vscode", "launch.local.json");
const CONFIG_LOCAL_PATH = join(PROJECT_DIR, "lethal.config.local.json");
// Committed per-mutant baseline — see baseline-guard.ts. Absent on the first run: the guard
// RECORDS it and says so. Never hand-write this file; it must come from a live run.
const BASELINE_PATH = join(HERE, "tables.baseline.json");

// Must live inside sandbox-data's declared idRanges (79197-79199 + 79300-79399, see its
// app.json) — real alc.exe enforces app.json idRanges (AL0297) for the injected objects too.
const SELECTOR_IDS = { selectorId: 79199, controlId: 79198, tableId: 79197 };

/**
 * The 81-site fixture's expected aggregate result.
 *
 * 63 / 10 / 2 is the CORRECTED result. The run recorded before the object-level-coverage fix
 * reported 53 killed / 20 survived / 2 no-coverage, and 10 of those 20 survivors were FALSE. BC
 * DOES report coverage for table-trigger code, but `buildCoverageMap` (bcdev-backend.ts) dropped
 * any observation it could name neither via SymbolReference.json (which records no trigger) nor
 * via the local-procedure scan (empty for `Data Main`, whose procedures are all public), so the
 * OBJECT lost credit along with the member: `byObject["table:79300"]` held only the one test whose
 * methodId happened to resolve, `coverageFilter`'s FALLBACK 1 answered with that non-empty-but-
 * wrong set, its all-green-tests FALLBACK 2 never fired, and every table-trigger mutant ran
 * against a single irrelevant test. Each of the 10 was then driven individually through the fenced
 * path against its intended killer and KILLED. Note the shape of the old bug: a table with public
 * procedures scored WORSE than one with none (`Data No Trigger`'s empty `byObject` fell through to
 * the correct fallback and scored right).
 *
 * `mutationScore` is written as the division, not a rounded literal — `report.ts` computes
 * `killed / (killed + timeoutKilled + survived)` in full float precision and this must equal it
 * exactly.
 *
 * PER-MUTANT: the old `verdicts` map (7 entries, from the superseded 7-mutant fixture) is gone.
 * Asserting a 7-key map against 75 scored mutants cannot pass and proves nothing; the per-mutant
 * regression guard for THIS fixture is `assertMatchesBaseline` against the committed
 * `tables.baseline.json` (semantic-identity keyed, and self-recording when the file is absent).
 * The file IS committed; delete it to re-record after a deliberate fixture change, and review the
 * diff before committing — a re-record is the one operation that can silently bless a regression.
 * `assertTriggerKillAndSurvive` below independently pins the trigger claim.
 */
const EXPECTED = {
  // R30 moved this from 81 to 93. The fixture gained its first EXTENSION objects — a
  // `tableextension` over `Data Main` and a `page`/`pageextension` pair — so that extension
  // support, which had only ever run in unit tests, is instrumented, compiled, published and
  // EXECUTED by a gate. New sites have no frozen baseline entry by construction; every
  // PRE-EXISTING mutant must keep its verdict, which is what `assertMatchesBaseline` checks.
  // R78 moved this from 93 to 96. The fixture gained `codeunit 79308 "Data Value Source"` and
  // `page 79323 "Data Value Card"` — a deliberately minimal pair whose only route in is a
  // `TestPage` test, built to answer whether a mutant covered EXCLUSIVELY by a TestPage test can be
  // scored at all. The three new sites are `empty-block` on the page's OnAction, `empty-block` on
  // `GetValue`'s body, and `return-value` on its `exit(42)`; all three flip the value the test
  // asserts, so all three are killable by that one test and by nothing else.
  // R70 moved this from 96 to 99. The fixture gained the cross-kind NAME COLLISION every gate was
  // blind to: `table 79309 "Data Scope Probe"` and `page 79324 "Data Scope Probe"`, same name,
  // different kind — the ordinary "card page named after its table" convention. The table's
  // OnInsert filters through a receiver declared in the TRIGGER'S OWN var section, invisible to the
  // symbol table (R68), so Tier 2 must REFUSE it and Tier 1 claims the statement. Under the R70 bug
  // the same-named page's `Helper: Record "Data Main"` answered for the table and Tier 2 CLAIMED
  // the site, whose §3.2 precedence then DELETED the Tier-1 mutant — measured offline on this
  // fixture as raw specs 99 -> 100 with DEPLOYED unchanged at 90. So the regression shows up as an
  // OPERATOR NAME at a fixed file:line, which `assertMatchesBaseline` compares per mutant.
  totalMutantSites: 114,
  // R36 moved this from 63/10 to 64/9, deliberately and in one direction only.
  //
  // `RequireCategoryAFails` used to assert merely that AN error occurred, so deleting
  // `DataMain.Get(MainNo)` (M0034) was invisible: with no `Get` the record is blank and
  // `TestField(Category, 'A')` still raises, just for a different reason. The mutant was correctly
  // reported survived — the fixture genuinely did not catch it — but this fixture exists so that a
  // BROKEN OPERATOR FAILS, and it was carrying the project's signature "test passes for the wrong
  // reason" inside itself. The test now asserts the error names the record it loaded, which a
  // blank record cannot do, so M0034 is killable and killed.
  // R30 moved this from 64/9/2 to 69/9/6, and the delta is entirely NEW sites — every pre-existing
  // mutant kept its verdict (checked per-mutant against the previous `tables.baseline.json`, not
  // inferred from the totals).
  //
  //   +5 killed  — `tableextension "Data Main Ext"`, all five of its deployed mutants, including
  //                `remove-testfield` on the IMPLICIT `Rec` (which claims only if `Rec` resolves to
  //                the EXTENDED table) and `remove-setrange` on a receiver declared INSIDE the
  //                extension (which claims only if extension members are indexed for scope). These
  //                are the first Tier-2 extension mutants any gate has EXECUTED.
  //   +4 no-cov  — `pageextension "Data Main List Ext"`. Its code is reachable only through a
  //                `TestPage`, and a TestPage HANGS the fenced session (measured 2026-07-31, R69),
  //                so the object is instrumented, compiled, published and installed live but never
  //                runs. Deliberately kept: no-coverage is the honest verdict for code no test
  //                reaches, and the pipeline proof is real even when the execution proof is not.
  // R70 moved this from 69 to 71. Both new killed mutants are in `table 79309 "Data Scope Probe"`'s
  // OnInsert — `empty-block` on the trigger body and `void-method-call` on the `SetRange` — and
  // `Data Tests.ScopeProbeCountsOnlyFilteredRelated` kills both by seeding out-of-filter decoys, so
  // deleting either widens the count the test asserts.
  // R73 moved this from 71 to 81, and R73's whole point is ONE of those: M0007, the first
  // `lethal.remove-commit` mutant any gate has ever KILLED. Until now the operator shipped proven
  // on its refusals and unproven on its claims — both pre-existing `Commit` sites are shadowed
  // negatives, correctly refused, so no gate had ever generated one.
  killed: 81,
  // R73 moved this from 9 to 12, and TWO of the three additions are worth reading rather than
  // accepting:
  //
  //   M0012 `remove-commit` in `CommitThenRun` SURVIVED, and that CONTRADICTS R72's premise.
  //     R72 says deleting a `Commit()` before a `Codeunit.Run` makes the platform refuse the call.
  //     Measured on `sandbox-probes` it does — write, then `Codeunit.Run`, in a test method, aborts
  //     with "An error occurred and the transaction is stopped." Measured HERE, with the write and
  //     the `Codeunit.Run` inside an ordinary codeunit called from a test, it does NOT: the call
  //     goes through, the callee flags the row, and both assertions pass. So the artifact is
  //     shape-dependent and the probe's shape did not generalise. Filed on R72; the detector is NOT
  //     built, because there is still nothing real for it to fire on.
  //
  //   M0005 / M0010 `void-method-call` on `DataMain.Init()` survive because deleting `Init()` is
  //     harmless when every field is assigned immediately after. Honest survivors, left as they
  //     are: manufacturing an assertion that kills them would test the fixture, not the operator.
  survived: 12,
  // R78 moved this from 6 to 9. The three new sites all belong to the TestPage-only pair
  // (`Data Value Source` / `Data Value Card`), and all three land `no-coverage` because the one
  // test that reaches them is refused on the fenced path. That is the measured statement of the
  // gap R69 exists for: the mutants are excluded from the score rather than scored against a test
  // that never ran. If the routed path is ever wired, THESE THREE are what must flip to scored.
  // R70 moved this from 9 to 10: `page 79324 "Data Scope Probe"`'s OnOpenPage `empty-block`. Nothing
  // opens that page — deliberately, R76 measured that a page over a trigger-carrying table can HANG
  // a fenced session — so no-coverage is the honest verdict for it.
  noCoverage: 10,
  mutationScore: 81 / (81 + 12),
  /**
   * `coverageFilter`'s FALLBACK 2 ("coverage places this table trigger nowhere, run every green
   * test") must fire for NOBODY here. This is the assertion `0a463fd` actually earns: before it,
   * member-less coverage observations were discarded, `byObject["table:79300"]` held one
   * accidental test, and trigger mutants ran against a wrong-but-non-empty set. The verdicts
   * alone cannot tell the two regimes apart on this fixture — nearly every test touches
   * `Data Main`, so precise attribution and "run everything" kill the same mutants — which is
   * exactly why the tally has to be asserted rather than admired in a stderr line.
   *
   * A future rise here is not automatically a bug (an honestly unplaceable trigger SHOULD run
   * everything), but it IS a change in what this gate proves, and must be explained before the
   * number is edited.
   */
  untargetedTriggerCount: 0,
};

interface LaunchLocalConfig {
  readonly configurations: ReadonlyArray<{
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
      `cannot read ${what} at ${path}: ${err instanceof Error ? err.message : String(err)}. See fixtures/README.md for the expected local-file setup.`,
    );
  }
  return JSON.parse(text) as T;
}

/**
 * `launch.local.json` only supplies `environmentType`/`environmentName`, both optional on the
 * backend. sandbox-data has no `.vscode/` of its own, so a missing file is normal here and must
 * not be an error — but a PRESENT-and-unreadable/corrupt one still is (never swallow that: it
 * would silently target the wrong environment).
 */
async function readOptionalLaunchConfig(): Promise<LaunchLocalConfig["configurations"][number]> {
  let text: string;
  try {
    text = await readFile(LAUNCH_LOCAL_PATH, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  const parsed = JSON.parse(text) as LaunchLocalConfig;
  return parsed.configurations[0] ?? {};
}

interface RunOnceResult {
  readonly report: SessionReport;
  readonly odataCfg: ActivationConfig;
}

async function runOnce(scratchRoot: string): Promise<RunOnceResult> {
  const launchCfg = await readOptionalLaunchConfig();
  const configFile = await readJson<LethalConfigFile>(
    CONFIG_LOCAL_PATH,
    "lethal.config.local.json",
  );
  const bcdev = validateBcDevConfig(configFile.bcdev);

  const toolPaths = await defaultAlToolPaths();
  if (!toolPaths) {
    throw new Error(
      "could not locate alc.exe/altool.exe under the AL Language VS Code extension install",
    );
  }

  const outputDir = join(scratchRoot, "publish");
  await mkdir(outputDir, { recursive: true });
  const compiler = new ArtifactCompiler(
    {
      alcPath: toolPaths.alcPath,
      packageCachePath: bcdev.packageCachePath,
      outputDir,
    },
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
  const odataCfg = {
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
    },
    undefined,
    { compiler, deployer, verifier, harnessVerifier },
    (targetAppId, artifactId) => new RunMutantTransport(odataCfg, targetAppId, artifactId),
  );

  const store = new ResultsStore(join(PROJECT_DIR, "lethal.sqlite"));
  try {
    const report = await runSession({
      backend,
      store,
      projectDir: PROJECT_DIR,
      testDir: TEST_DIR,
      instrumentedDir: join(scratchRoot, "instrumented"),
      selectorIds: SELECTOR_IDS,
      // Layer 5C-B1 (design §6): take the machine-global lease before deploying, fence the
      // publish, heartbeat it, carry the tuple into every RunMutant, release at the end —
      // identical to bcdev.itest.ts, since this drives the same fenced server path.
      lease: {
        client: new LeaseClient(odataCfg),
        serverGeneration: async () => (await harnessVerifier.verify()).serverGeneration,
      },
      resourceServer: bcdev.server,
      resourceServerInstance: bcdev.serverInstance,
      // A SCRATCH quarantine dir, deliberately NOT defaultQuarantineDir() — one transient
      // failure landing in the real ~/.lethal store poisons every later gate run until an
      // operator deletes it by hand (observed live). Same reasoning as bcdev.itest.ts.
      quarantineDir: join(scratchRoot, "quarantine"),
    });
    return { report, odataCfg };
  } finally {
    store.close();
    // Without this the spawned bc-dev MCP child keeps the event loop alive and this script never
    // exits, even on a fully successful run.
    await backend.close();
  }
}

function assertVerdictTable(report: SessionReport): void {
  // Always dump the per-mutant table BEFORE asserting. A bare "survived count mismatch 1 !== 2"
  // says nothing about which mutant moved, and this gate takes minutes to re-run against a live
  // container — so the first run has to carry its own diagnosis.
  console.log(
    `  verdicts: killed=${report.counts.killed} survived=${report.counts.survived} noCoverage=${report.counts.noCoverage} baselineGreen=${report.baselineGreen} score=${report.mutationScore} untargetedTriggers=${report.untargetedTriggerCount}`,
  );
  for (const m of report.mutants) {
    const cause = m.cause !== undefined ? ` cause=${m.cause}` : "";
    const note = m.failureNote !== undefined ? ` note=${m.failureNote}` : "";
    console.log(
      `    ${m.mutantCode} ${m.verdict}${cause} ${m.file}:${m.line} ${m.operatorName}${note}`,
    );
  }
  if (report.quarantined !== undefined) {
    console.log(`  quarantined: ${JSON.stringify(report.quarantined)}`);
  }

  // R78 turned this from a blanket `baselineGreen === true` into an EXACT statement of the one
  // expected failure. Flipping it to `false` would have been the lazy update and would have gutted
  // the guard: any newly-broken fixture test would then pass unnoticed. The fixture now contains
  // exactly one test that CANNOT run on the fenced path — `PageActionComputesNonZero` opens a
  // TestPage, which this session type refuses — so the honest assertion is "exactly that one fails,
  // by name, for that reason", which still catches every other regression.
  assert.equal(
    report.unsupportedTests.length,
    1,
    `expected exactly 1 baseline failure (the TestPage test), got ${report.unsupportedTests.length}: ${report.unsupportedTests.join(", ")}`,
  );
  assert.equal(
    report.unsupportedTests[0],
    "Data Tests.PageActionComputesNonZero",
    "the only permitted baseline failure is the TestPage test",
  );
  assert.ok(
    report.validity.caveats.includes("tests-testpage-unsupported"),
    "the TestPage refusal must be NAMED in the report, not left as an unexplained baseline failure",
  );
  assert.equal(report.counts.killed, EXPECTED.killed, "killed count mismatch");
  assert.equal(report.counts.survived, EXPECTED.survived, "survived count mismatch");
  assert.equal(report.counts.noCoverage, EXPECTED.noCoverage, "no-coverage count mismatch");
  assert.equal(report.counts.errors, 0, "no mutant may error on the healthy path");
  assert.equal(report.counts.unstable, 0, "no mutant may be unstable on the healthy path");
  assert.equal(report.mutationScore, EXPECTED.mutationScore, "mutation score mismatch");
  assert.equal(
    report.untargetedTriggerCount,
    EXPECTED.untargetedTriggerCount,
    "table trigger mutants took coverageFilter's all-green-tests FALLBACK 2 — object-level " +
      "coverage should place every trigger in this fixture (FALLBACK 1). A non-zero here with " +
      "unchanged verdicts is the signature of the pre-0a463fd bug returning: `byObject` starved, " +
      "attribution silently coarsened, every count identical",
  );
  // Per-mutant verdicts are asserted by `assertMatchesBaseline` (tables.baseline.json), not here
  // — see EXPECTED's doc comment for why the old inline 7-entry map was removed rather than
  // extended by hand.
}

/**
 * Every mutant of every artifact this run actually deployed, keyed by mutant id.
 *
 * `MutantOutcome` (report.ts) carries neither `triggerName` nor `objectType`, so the report alone
 * cannot say whether a verdict landed on a TRIGGER site — the one claim Phase 0 exists to prove.
 * The manifest can: `prepareArtifactDir` writes one `mutant-manifest.json` per artifact into
 * `<instrumentedDir>/run-<runId>-batch-<n>/`, from the same `triggerNameOf`/`objectHeaderOf`
 * attribution the coverage key uses.
 *
 * `run-…-batch-<n>-bisect` dirs are excluded by the `\d+$` anchor: those hold NARROWED subsets
 * written while searching for a compile-failure culprit, not the deployed set.
 */
async function readDeployedManifests(
  instrumentedDir: string,
): Promise<Map<string, MutantManifestEntry>> {
  const byId = new Map<string, MutantManifestEntry>();
  const entries = await readdir(instrumentedDir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory() || !/^run-.+-batch-\d+$/.test(e.name)) continue;
    const raw = await readFile(join(instrumentedDir, e.name, "mutant-manifest.json"), "utf8");
    for (const m of (JSON.parse(raw) as MutantManifest).mutants) byId.set(m.mutantId, m);
  }
  if (byId.size === 0) {
    const why =
      "cannot verify trigger attribution, and passing without verifying it is exactly the " +
      "failure this gate exists to catch";
    throw new Error(`no deployed mutant-manifest.json found under ${instrumentedDir} — ${why}`);
  }
  return byId;
}

/**
 * The exit criterion, asserted rather than described: a kill AND a survive on TRIGGER sites
 * specifically. A kill alone can come from a runtime error unrelated to any assertion, and an
 * all-survive table proves nothing about activation. Both killed trigger mutants live in a
 * field-level `OnValidate`; the surviving M0003 is the object-level `OnInsert`.
 *
 * Trigger-ness comes from the deployed manifest, not from the mutant's file name: the file-name
 * check this replaced could not fail (the fixture holds only `DataMain`/`DataNoTrigger`), so it
 * asserted nothing at all.
 */
async function assertTriggerKillAndSurvive(
  report: SessionReport,
  byId: ReadonlyMap<string, MutantManifestEntry>,
): Promise<void> {
  const sited = report.mutants.map((m) => {
    const entry = byId.get(m.mutantCode);
    if (entry === undefined) {
      // Report and deployed artifact disagree about which mutants exist — never "close enough".
      throw new Error(
        `mutant ${m.mutantCode} appears in the report but in no deployed mutant-manifest.json`,
      );
    }
    return { code: m.mutantCode, verdict: m.verdict, entry };
  });
  const triggers = sited.filter((s) => s.entry.triggerName !== undefined);
  console.log(
    `  trigger-sited mutants: ${
      triggers
        .map((t) => `${t.code}=${t.verdict} (${t.entry.objectType} ${t.entry.triggerName})`)
        .join(", ") || "(none)"
    }`,
  );

  assert.ok(
    triggers.some((t) => t.verdict === "killed"),
    "no KILLED mutant sits at a trigger site (manifest `triggerName` set) — Phase 0's claim is " +
      "that a mutation inside a table trigger is generated, attributed, executed AND killed",
  );
  assert.ok(
    triggers.some((t) => t.verdict === "survived"),
    "no SURVIVED mutant sits at a trigger site — without one, an all-kill table could equally " +
      "be explained by the whole tier erroring out rather than by real activation",
  );
  // R30: the fixture now also holds a `pageextension` whose `OnOpenPage` is a trigger site, so
  // "every trigger here is a table trigger" is no longer true and asserting it would only pin the
  // fixture's file list. What this loop is FOR is narrower — a trigger mutant must be attributed to
  // the object that declares it, because a mis-keyed `(objectType, objectId)` sends it at the wrong
  // object's tests (R29's shape, and the reason `6e89948` keyed coverage on the pair rather than on
  // the bare id). So the check is now per-mutant: the manifest's objectType must equal the kind the
  // mutant's own SOURCE FILE declares.
  //
  // Read from the source HEADER, not from the file NAME. A name-suffix map (`.PageExt.al` ->
  // pageextension, everything else -> table) was written first and is wrong in a way that only
  // shows up later: a codeunit `OnRun` or a plain page trigger is a trigger site too, and the map
  // would call it `table` and fail a correct run. Reading the header keeps the check independent of
  // the manifest (which comes from the AL parse) while surviving any object kind the fixture grows.
  for (const t of triggers) {
    const source = await readFile(join(PROJECT_DIR, "src", basename(t.entry.file)), "utf8");
    const header = /^\s*(table|codeunit|page|report|tableextension|pageextension)\s+\d+/im.exec(
      source,
    );
    assert.ok(
      header !== null,
      `${t.code}: cannot read an object header out of ${t.entry.file}, so its attribution cannot be checked — and passing without checking is what this assertion exists to prevent`,
    );
    assert.equal(
      t.entry.objectType,
      header[1]?.toLowerCase(),
      `${t.code}: trigger site attributed to objectType ${t.entry.objectType}, but ${t.entry.file} declares a ${header[1]}`,
    );
  }
}

async function main(): Promise<void> {
  // PROJECT_DIR, not `<PROJECT_DIR>/src` — `runSession` generates from `cfg.projectDir`, so
  // scanning anything else would let this header describe a different file set than the run
  // below it actually executes.
  const { files } = await generateMutationSet(PROJECT_DIR);
  const total = files.reduce((n, f) => n + f.specs.length, 0);
  assert.equal(
    total,
    EXPECTED.totalMutantSites,
    `expected ${EXPECTED.totalMutantSites} mutant sites across the table fixture, generated ${total} — either the fixture changed or a tier-1 operator's targeting changed; update fixtures/README.md`,
  );

  // R9: runs the session TWICE and asserts verdict-identity, matching itest:bcdev/itest:alrunner
  // — a single run left cross-run nondeterminism here indistinguishable from a confusing
  // per-mutant baseline mismatch instead of an explicit determinism failure.
  const scratchA = await mkdtemp(join(tmpdir(), "lethal-itest-tables-a-"));
  const scratchB = await mkdtemp(join(tmpdir(), "lethal-itest-tables-b-"));
  try {
    const first = await runOnce(scratchA);
    assertVerdictTable(first.report);
    // The trigger claim itself, read off the manifests the run actually deployed (the scratch
    // dir is still on disk here — it is removed in the `finally` below).
    await assertTriggerKillAndSurvive(
      first.report,
      await readDeployedManifests(join(scratchA, "instrumented")),
    );
    // Per-mutant regression guard against the committed baseline, keyed on semantic identity
    // (astHash/codeunitName/operatorName/operatorMajor) rather than mutant code — so it survives
    // renumbering that the EXPECTED.verdicts map above deliberately does not.
    await assertMatchesBaseline(first.report, BASELINE_PATH, "tables itest");

    const second = await runOnce(scratchB);
    assertVerdictTable(second.report);
    await assertTriggerKillAndSurvive(
      second.report,
      await readDeployedManifests(join(scratchB, "instrumented")),
    );

    const shape = (r: SessionReport) =>
      [...r.mutants]
        .map((m) => ({ mutantCode: m.mutantCode, verdict: m.verdict, killingTest: m.killingTest }))
        .sort((a, b) => a.mutantCode.localeCompare(b.mutantCode));
    assert.deepEqual(
      shape(first.report),
      shape(second.report),
      "two consecutive runs must be 100% verdict-identical (determinism exit criterion) — R9: " +
        "cross-run nondeterminism here must surface as an explicit determinism failure, not a " +
        "confusing per-mutant baseline mismatch",
    );
  } finally {
    await rm(scratchA, { recursive: true, force: true });
    await rm(scratchB, { recursive: true, force: true });
  }

  console.log("tables itest: PASS");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
