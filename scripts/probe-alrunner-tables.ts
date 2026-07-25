#!/usr/bin/env bun
/**
 * Tier-2 Phase 0 exit criterion (7): al-runner's behaviour on TABLE TRIGGERS is unestablished.
 * The frozen al-runner baseline (3 killed / 13 survived / 0 no-coverage) only exercises the
 * codeunit fixture, so nothing yet says whether the offline backend can compile, publish and
 * execute a mutant that lives inside an OnInsert / field OnValidate trigger.
 *
 * Same shape as packages/runner/itest/al-runner.itest.ts's runOnce(), pointed at
 * fixtures/sandbox-data (+ sandbox-data-tests). No assertions and no baseline — this is a probe:
 * it prints the per-mutant verdict table so the behaviour can be recorded as a fact rather than
 * assumed. Compare against the bcdev live gate on the same fixture.
 *
 * MEASURED 2026-07-25: 0 killed / 7 survived / 0 no-coverage, against bcdev's 3 killed / 2
 * survived / 2 no-coverage. NOT a trigger-support gap — al-runner does execute table triggers and
 * the injected selector guard does fire inside table code (both probed directly). The whole
 * difference is that al-runner reports `pass` for an `asserterror` that raised no error, and all
 * three bcdev kills come from asserterror tests. Full write-up: fixtures/README.md §Tier-2
 * Phase 0. The CLI now warns on every al-runner session because of it.
 *
 *   LETHAL_ALRUNNER_PATH="C:/Users/SShadowS/.dotnet/tools/al-runner.exe" \
 *     bun run scripts/probe-alrunner-tables.ts
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AlRunnerBackend } from "../packages/runner/src/al-runner-backend";
import { generateMutationSet, runSession } from "../packages/runner/src/orchestrator";
import { ResultsStore } from "../packages/runner/src/store";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const PROJECT_DIR = join(REPO_ROOT, "fixtures", "sandbox-data");
const TEST_DIR = join(REPO_ROOT, "fixtures", "sandbox-data-tests");
// Same ids the bcdev gate used on this fixture; both live inside sandbox-data's idRanges.
const SELECTOR_IDS = { selectorId: 79199, controlId: 79198, tableId: 79197 };

const alRunnerPath = process.env.LETHAL_ALRUNNER_PATH;
if (alRunnerPath === undefined) {
  console.error("set LETHAL_ALRUNNER_PATH to the al-runner executable");
  process.exit(1);
}

// PROJECT_DIR, not `<PROJECT_DIR>/src`: `runSession` below generates its own set from
// `projectDir`, so scanning a different root here would print a header that is not guaranteed to
// describe the run underneath it (different roots also yield different relative `path` values).
const files = await generateMutationSet(PROJECT_DIR);
console.log(`mutant sites: ${files.reduce((n, f) => n + f.specs.length, 0)}`);
for (const f of files) {
  console.log(`  ${f.path}: ${f.specs.length}`);
}

const scratch = await mkdtemp(join(tmpdir(), "lethal-probe-alrunner-tables-"));
const store = new ResultsStore(":memory:");
try {
  const backend = new AlRunnerBackend({
    alRunnerPath,
    instrumentedDir: join(scratch, "instrumented"),
    testDir: TEST_DIR,
    selectorObjectId: SELECTOR_IDS.selectorId,
  });
  const report = await runSession({
    backend,
    store,
    projectDir: PROJECT_DIR,
    testDir: TEST_DIR,
    instrumentedDir: join(scratch, "instrumented"),
    selectorIds: SELECTOR_IDS,
  });
  console.log(
    `verdicts: killed=${report.counts.killed} survived=${report.counts.survived} noCoverage=${report.counts.noCoverage} baselineGreen=${report.baselineGreen}`,
  );
  for (const m of report.mutants) {
    const cause = m.cause !== undefined ? ` cause=${m.cause}` : "";
    const note = m.failureNote !== undefined ? ` note=${m.failureNote}` : "";
    console.log(
      `  ${m.mutantCode} ${m.verdict}${cause} ${m.file}:${m.line} ${m.operatorName}${note}`,
    );
  }
  if (report.quarantined !== undefined) {
    console.log(`quarantined: ${JSON.stringify(report.quarantined)}`);
  }
} finally {
  store.close();
  await rm(scratch, { recursive: true, force: true });
}
