#!/usr/bin/env bun
// PostToolUse(Bash) hook: after a typecheck (`tsc --build` / `bun run typecheck`),
// delete each packages/<pkg>/dist so a following `bun test` cannot pick up stale
// compiled test copies (the recurring "dist trap" — ~21 phantom failures). Idempotent.
// Exits 0 always (a hook must not block the tool result).
// NOTE: kept as line comments, not a /* */ block — a block comment can't contain the
// packages glob (its slash-star-slash sequence would close the comment early).
//
// The directory this cleans is the one the typecheck actually RAN in, which is not
// always the session's project dir: work in a git worktree types-checks the worktree
// while CLAUDE_PROJECT_DIR still names the main checkout, so the old
// `CLAUDE_PROJECT_DIR ?? process.cwd()` cleaned the wrong tree and left the worktree's
// stale dist in place — the trap it exists to prevent, fired four times in one session.
// Resolution order: a `cd <dir>` leading the command (how every worktree command is
// written), then the hook payload's own `cwd`, then the env var, then process.cwd().
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

let raw = "";
try {
  raw = await Bun.stdin.text();
} catch {
  process.exit(0);
}
let cmd = "";
let payloadCwd: string | undefined;
try {
  const payload = JSON.parse(raw);
  cmd = (payload?.tool_input?.command ?? "") as string;
  const c = payload?.cwd;
  if (typeof c === "string" && c.length > 0) payloadCwd = c;
} catch {
  process.exit(0);
}

// A `cd <dir>` at the head of the command (or of any `&&`/`;`-separated segment before
// the typecheck) names the tree being built. Quoted and bare forms both appear.
function cdTargetOf(command: string): string | undefined {
  const m = /(?:^|&&|;|\|\|)\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/.exec(command);
  if (m === null) return undefined;
  const [, dq, sq, bare] = m;
  const dir = dq ?? sq ?? bare;
  if (dir === undefined || !isAbsolute(dir)) return undefined;
  return dir;
}

// Never `rm -rf` a directory that is not recognisably this monorepo. A mis-parsed path
// pointing anywhere else must be a no-op, not a delete.
function isMonorepoRoot(dir: string): boolean {
  return existsSync(join(dir, "package.json")) && existsSync(join(dir, "packages"));
}

if (/tsc\s+--build|run\s+typecheck/.test(cmd)) {
  const candidates = [cdTargetOf(cmd), payloadCwd, process.env.CLAUDE_PROJECT_DIR, process.cwd()];
  const target = candidates.find((d) => d !== undefined && d.length > 0 && isMonorepoRoot(d));
  if (target !== undefined) {
    // Shell glob expansion for packages/*/dist — run from the resolved repo root.
    Bun.spawnSync(["bash", "-c", "rm -rf packages/*/dist"], {
      cwd: target,
      stdout: "inherit",
      stderr: "inherit",
    });
  }
}
process.exit(0);
