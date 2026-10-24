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
 *
 * R223 (owner, 2026-10-23): it runs compile-fixtures WITH `--inventory`. Without it, a Windows
 * machine with no `alc` exits 0 without compiling, and this hook passed a fixture edit it never
 * checked. With it, a missing `alc` exits 1, and the hook blocks.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The compile command. `--inventory` turns a missing `alc` into exit 1 (R223). */
export function compileCommand(inventoryPath: string): string[] {
  return ["bun", "run", "compile:fixtures", "--inventory", inventoryPath];
}

/** Exit 0 passes the edit; anything else blocks it (exit 2). */
export function hookExit(compileExitCode: number | null): 0 | 2 {
  return compileExitCode === 0 ? 0 : 2;
}

if (import.meta.main) await main();

async function main(): Promise<void> {
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
  const scratch = mkdtempSync(join(tmpdir(), "lethal-hook-inventory-"));
  let res: ReturnType<typeof Bun.spawnSync>;
  try {
    res = Bun.spawnSync(compileCommand(join(scratch, "inventory.json")), {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  if (hookExit(res.exitCode) === 0) process.exit(0);

  // alc's diagnostics land on stdout; keep stderr too so a spawn/tooling failure is not silently
  // reported as a compile failure (and vice versa — see the AlcCompileError vs ArtifactPrepareError
  // separation this project maintains everywhere else). A missing `alc` lands here too (R223), and
  // compile-fixtures' own stderr names it.
  const out = new TextDecoder().decode(res.stdout).trim();
  const err = new TextDecoder().decode(res.stderr).trim();
  console.error(
    [
      `fixture AL was not shown to compile after editing ${normalized} (it fails, or alc is missing).`,
      "",
      "This is R56's exact shape: the live gates publish the TARGET but not the TEST APP, so a broken",
      "fixture leaves itest:tables / itest:bcdev happily measuring the previously published build.",
      "Fix the AL, or install alc, before running any gate — a green gate over a broken fixture proves nothing.",
      "",
      out,
      err,
    ]
      .filter((s) => s.length > 0)
      .join("\n"),
  );
  process.exit(hookExit(res.exitCode));
}
