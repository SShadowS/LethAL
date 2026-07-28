#!/usr/bin/env bun
/**
 * PostToolUse(Edit|Write) hook: offline-compile the AL fixtures whenever a `fixtures/**\/*.al` file
 * is edited, and REPORT THE FAILURE BACK immediately.
 *
 * This is R56 wearing a hook. A docs-only commit (`76dfe48`) rewrote a comment inside
 * `InsertDoublesAmountWeak` and took the procedure's statements and its closing `end;` with it.
 * `fixtures/sandbox-data-tests` stopped compiling, and `itest:tables` KEPT PASSING FOR DAYS —
 * LethAL republishes the target on every run but treats publishing the TEST APP as the user's own
 * workflow, so the gate went on measuring a stale published build while the source was broken. The
 * frozen baseline it asserted described a build nobody could rebuild.
 *
 * R31's stale-test-app detector structurally cannot catch that shape (it fires when the server has
 * no result for a DISCOVERED test; here the server held an older WORKING build of every test), and
 * `bun run typecheck` covers only the TypeScript. Nothing covered the AL until `compile:fixtures`,
 * and nothing ran `compile:fixtures` until someone remembered to.
 *
 * BLOCKING on failure (exit 2), deliberately: an advisory warning is exactly what the original
 * failure looked like — information that existed and went unread. ~6.4 s measured for all six
 * fixture projects, paid only on a fixture AL edit.
 *
 * Exits 0 for every other path, and for anything unexpected: a hook that breaks the session is
 * worse than a hook that misses one edit.
 */
let raw = "";
try {
  raw = await Bun.stdin.text();
} catch {
  process.exit(0);
}

let file = "";
try {
  file = (JSON.parse(raw)?.tool_input?.file_path ?? "") as string;
} catch {
  process.exit(0);
}

const normalized = file.replace(/\\/g, "/");
const isFixtureAl = /\/fixtures\/.+\.al$/i.test(normalized);
if (!isFixtureAl) process.exit(0);

const cwd = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const res = Bun.spawnSync(["bun", "run", "compile:fixtures"], {
  cwd,
  stdout: "pipe",
  stderr: "pipe",
});

if (res.exitCode === 0) process.exit(0);

// alc's diagnostics land on stdout; keep stderr too so a spawn/tooling failure is not silently
// reported as a compile failure (and vice versa — see the AlcCompileError vs ArtifactPrepareError
// separation this project maintains everywhere else).
const out = new TextDecoder().decode(res.stdout).trim();
const err = new TextDecoder().decode(res.stderr).trim();
console.error(
  [
    `fixture AL no longer compiles after editing ${normalized}.`,
    "",
    "This is R56's exact shape: the live gates publish the TARGET but not the TEST APP, so a broken",
    "fixture leaves itest:tables / itest:bcdev happily measuring the previously published build.",
    "Fix the AL before running any gate — a green gate over a broken fixture proves nothing.",
    "",
    out,
    err,
  ]
    .filter((s) => s.length > 0)
    .join("\n"),
);
process.exit(2);
