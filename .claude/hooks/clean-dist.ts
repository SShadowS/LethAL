#!/usr/bin/env bun
// PostToolUse(Bash) hook: after a typecheck (`tsc --build` / `bun run typecheck`),
// delete each packages/<pkg>/dist so a following `bun test` cannot pick up stale
// compiled test copies (the recurring "dist trap" — ~21 phantom failures). Idempotent.
// Exits 0 always (a hook must not block the tool result).
// NOTE: kept as line comments, not a /* */ block — a block comment can't contain the
// packages glob (its slash-star-slash sequence would close the comment early).
let raw = "";
try {
  raw = await Bun.stdin.text();
} catch {
  process.exit(0);
}
let cmd = "";
try {
  cmd = (JSON.parse(raw)?.tool_input?.command ?? "") as string;
} catch {
  process.exit(0);
}
if (/tsc\s+--build|run\s+typecheck/.test(cmd)) {
  // Shell glob expansion for packages/*/dist — run from the repo root.
  Bun.spawnSync(["bash", "-c", "rm -rf packages/*/dist"], {
    cwd: process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
    stdout: "inherit",
    stderr: "inherit",
  });
}
process.exit(0);
