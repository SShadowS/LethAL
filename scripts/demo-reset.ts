#!/usr/bin/env bun
/**
 * Put the gift card demo back to a known state between takes.
 *
 *   bun scripts/demo-reset.ts [--config <path>] [--clear-ceiling] [--dry-run]
 *
 * A rehearsal is a loop, and every iteration leaves something behind: a results database that makes
 * the next run resumable, a quarantine record from a deliberately-broken take, an instrumented build
 * still installed on the server. None of that is a bug — it is the tool remembering, which is the
 * point of it — but a demo wants the same starting state every time, and "which of these do I
 * clear?" is not a question to answer in front of a room.
 *
 * ORDER MATTERS and is most of the content here:
 *
 *   1. Local state first (the results database), because it needs no server and cannot fail.
 *   2. Then the quarantine record, because a quarantined tier refuses every later run before it
 *      publishes anything.
 *   3. Then `doctor`, LAST, as the CHECK rather than as a step — if it is not green the reset did
 *      not work, and running the demo anyway is how a rehearsal problem becomes a stage problem.
 *
 * THE PUBLISH CEILING IS NOT CLEARED BY DEFAULT, and that default was corrected by evidence rather
 * than chosen: clearing it during a test of this script removed three measured rows, two of them
 * `accepted` — i.e. proof that a 36-guard artifact publishes fine on that server. Those rows make
 * later runs smarter and cost a live publish each to earn. Only a `failed` row blocks anything, so
 * clearing is opt-in with `--clear-ceiling`, for the case where a deliberately-broken take recorded
 * a failure you do not want ratcheted in.
 *
 * What it deliberately does NOT do:
 *
 *   - It does not republish the target. `lethal run` republishes the instrumented target itself on
 *     every run; that is the product's own behaviour and faking it here would rehearse something the
 *     audience will not see.
 *   - It does not republish the TEST app. That stays the user's own workflow (the same division the
 *     product draws) and only needs redoing when the tests themselves change.
 *   - It does not touch the LethAL Control app. If that is stale, `doctor` says so by name and the
 *     fix is `/control-app`, not a reset.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const alsoClearCeiling = args.includes("--clear-ceiling");
const configIndex = args.indexOf("--config");
const configPath =
  configIndex >= 0 ? (args[configIndex + 1] ?? "") : "examples/gift-card/lethal.config.local.json";
if (configPath === "") throw new Error("--config needs a path");

const projectDir = "examples/gift-card";
const cli = ["bun", join("packages", "runner", "src", "cli.ts")];

if (!existsSync(configPath)) {
  // Loud, not a soft skip: without the config nothing below can reach the server, and a "reset"
  // that silently did only the local half is worse than one that refused.
  throw new Error(
    `demo-reset: no config at ${configPath}. Copy examples/gift-card/lethal.config.example.json to examples/gift-card/lethal.config.local.json and fill in your server.`,
  );
}

/** `clear-quarantine` takes the tier as `--server`/`--instance`, not as a config path — it is a
 *  recovery command that must work when the config is the thing that is wrong. Read them out here
 *  so the caller does not have to retype them. */
const cfg = JSON.parse(readFileSync(configPath, "utf8")) as {
  bcdev?: { server?: string; serverInstance?: string };
};
const server = cfg.bcdev?.server;
const instance = cfg.bcdev?.serverInstance;
if (server === undefined || instance === undefined) {
  throw new Error(
    `demo-reset: ${configPath} has no bcdev.server / bcdev.serverInstance, so the quarantine record cannot be addressed. This script is for the bcdev path.`,
  );
}

function step(label: string): void {
  console.log(`\n— ${label}`);
}

async function run(argv: readonly string[], { allowFailure = false } = {}): Promise<number> {
  console.log(`  $ ${argv.join(" ")}`);
  if (dryRun) return 0;
  const proc = Bun.spawn([...argv], { stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0 && !allowFailure) {
    throw new Error(`demo-reset: \`${argv.join(" ")}\` exited ${code}`);
  }
  return code;
}

// 1. LOCAL — the results database. Deleting it is what makes the next run a fresh one rather than a
//    resumable continuation of the last take, and it is what stops `--skip-known-survivors` from
//    quietly narrowing a demo run.
step("results database");
for (const name of ["lethal.sqlite", "lethal.sqlite-shm", "lethal.sqlite-wal"]) {
  const path = join(projectDir, name);
  if (!existsSync(path)) continue;
  console.log(`  rm ${path}`);
  if (!dryRun) rmSync(path, { force: true });
}

// 2. SERVER — the quarantine record. Sticky by design: it exists so a possibly-stranded tier cannot
//    be walked past by re-running. Exits non-zero when it removed nothing, which is right for a
//    recovery command and wrong for a reset, so "nothing to clear" is success here.
step("quarantine record (sticky: a quarantined tier refuses every later run)");
await run([...cli, "clear-quarantine", "--server", server, "--instance", instance], {
  allowFailure: true,
});

if (alsoClearCeiling) {
  step(
    "publish ceiling (opt-in: this also discards ACCEPTED measurements, which cost a publish each)",
  );
  await run([...cli, "clear-ceiling", "--project", projectDir, "--config", configPath], {
    allowFailure: true,
  });
}

// 3. CHECK — not a step. `doctor` is read-only, takes seconds, and its exit code is the answer to
//    "is this machine ready to demo".
step("doctor (read-only; this is the check, not a step)");
const code = await run([...cli, "doctor", "--config", configPath], { allowFailure: true });

if (dryRun) {
  // A dry run has checked NOTHING. Saying "ready" here would be a green light nobody earned.
  console.log("\ndemo-reset: dry run — nothing was executed, and nothing was checked.");
  process.exit(0);
}
console.log(
  code === 0
    ? "\ndemo-reset: ready. `doctor` is green."
    : "\ndemo-reset: NOT ready — `doctor` reported a failing check above. Fix it before running the " +
        "demo; a red pre-flight found now costs a minute, and found on stage costs the talk.",
);
process.exit(code === 0 ? 0 : 1);
