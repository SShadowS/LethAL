#!/usr/bin/env bun
/**
 * Run the R7/R8 canary against the CONFIGURED al-runner binary and print both verdicts.
 *
 * `runAlRunnerCanary` already runs at the start of every `--backend al-runner` session, but its
 * result is announced inside a full run. This exposes it on its own so the two BC-semantics probes
 * can be re-measured against a new al-runner release in ~3 seconds, which is what makes them useful
 * as a parity report rather than as a startup warning.
 *
 *   LETHAL_ALRUNNER_PATH="C:/Users/SShadowS/.dotnet/tools/al-runner.exe" \
 *     bun run scripts/probe-alrunner-canary.ts
 */
import { runAlRunnerCanary } from "../packages/runner/src/al-runner-canary";

const alRunnerPath = process.env.LETHAL_ALRUNNER_PATH;
if (alRunnerPath === undefined) {
  console.error("set LETHAL_ALRUNNER_PATH to the al-runner executable");
  process.exit(2);
}

const version = Bun.spawnSync([alRunnerPath, "--version"]);
console.log(`binary under test: ${new TextDecoder().decode(version.stdout).trim()}`);

const result = await runAlRunnerCanary(alRunnerPath);

const LEGEND: Record<string, string> = {
  "defect-confirmed": "DEFECT REPRODUCES on this build",
  "defect-not-reproduced": "fixed / not reproduced",
  inconclusive: "INCONCLUSIVE — the probe could not decide",
};

console.log(`
R7  asserterror        : ${result.asserterror.padEnd(22)} ${LEGEND[result.asserterror] ?? ""}`);
if (result.asserterrorDetail !== undefined) console.log(`    detail: ${result.asserterrorDetail}`);
console.log(
  `R8  table global var   : ${result.tableGlobalVar.padEnd(22)} ${LEGEND[result.tableGlobalVar] ?? ""}`,
);
if (result.tableGlobalVarDetail !== undefined) {
  console.log(`    detail: ${result.tableGlobalVarDetail}`);
}
console.log(
  `R183 transaction rollback: ${result.transactionRollback.padEnd(22)} ${LEGEND[result.transactionRollback] ?? ""}`,
);
if (result.transactionRollbackDetail !== undefined) {
  console.log(`    detail: ${result.transactionRollbackDetail}`);
}
