#!/usr/bin/env bun
/**
 * PostToolUse(Edit|Write) hook: run biome's SAFE fixes on the single .ts file just
 * edited (the repo rule is "biome only on files you touched" — `biome check .` is
 * noisy due to pre-existing debt in engine/builtin-tier1). Scoped to one file, never
 * the tree; skips dist/ and non-.ts, and files OUTSIDE this project (a session started
 * here may edit another repo, whose own biome config must decide its formatting; running
 * LethAL's config on it rewrote whole files). Exits 0 always.
 */
import { isAbsolute, relative, resolve } from "node:path";
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
const project = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const rel = relative(resolve(project), resolve(file));
// Outside = "..": a sibling folder; absolute: another drive (Windows relative() across drives).
const inProject = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
const isTs = /\.(ts|tsx)$/.test(file);
const inDist = file.includes("/dist/") || file.includes("\\dist\\");
if (isTs && !inDist && inProject) {
  // --write applies only SAFE fixes (format/organizeImports); never --unsafe.
  Bun.spawnSync(["bunx", "biome", "check", "--write", file], {
    cwd: project,
    stdout: "inherit",
    stderr: "inherit",
  });
}
process.exit(0);
