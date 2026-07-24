#!/usr/bin/env bun
/**
 * PostToolUse(Edit|Write) hook: run biome's SAFE fixes on the single .ts file just
 * edited (the repo rule is "biome only on files you touched" — `biome check .` is
 * noisy due to pre-existing debt in engine/builtin-tier1). Scoped to one file, never
 * the tree; skips dist/ and non-.ts. Exits 0 always.
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
const isTs = /\.(ts|tsx)$/.test(file);
const inDist = file.includes("/dist/") || file.includes("\\dist\\");
if (isTs && !inDist) {
  // --write applies only SAFE fixes (format/organizeImports); never --unsafe.
  Bun.spawnSync(["bunx", "biome", "check", "--write", file], {
    cwd: process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
    stdout: "inherit",
    stderr: "inherit",
  });
}
process.exit(0);
