import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// R423: the `.claude/hooks/biome-touched.ts` hook, run as Claude Code runs it. The file sits inside
// the repo, because the hook skips a file outside the project.
const repo = join(import.meta.dir, "..");
const dir = mkdtempSync(join(import.meta.dir, "biome-hook-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function runHook(name: string, text: string): { readonly after: string; readonly stderr: string } {
  const file = join(dir, name);
  writeFileSync(file, text);
  const p = Bun.spawnSync(["bun", join(repo, ".claude/hooks/biome-touched.ts")], {
    cwd: repo,
    env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
    stdin: Buffer.from(JSON.stringify({ tool_input: { file_path: file } })),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(p.exitCode).toBe(0);
  return { after: readFileSync(file, "utf8"), stderr: p.stderr.toString() };
}

const untidy = "export   const a  =  1\n";

describe("R423: biome-touched hook", () => {
  test.each([
    ["all three markers", `<<<<<<< HEAD\n${untidy}=======\n${untidy}>>>>>>> other\n`],
    ["a start marker alone", `<<<<<<< HEAD\n${untidy}`],
    ["a middle marker alone, CRLF", `${untidy}=======\r\n${untidy}`],
    ["an end marker alone", `${untidy}>>>>>>> other\n`],
  ])("leaves a file with %s byte-identical and says so", (_name, text) => {
    const { after, stderr } = runHook("marked.ts", text);
    expect(after).toBe(text);
    expect(stderr).toContain("merge-conflict markers");
  });

  test("still formats a clean file, as today", () => {
    const { after, stderr } = runHook("clean.ts", untidy);
    expect(after).toBe("export const a = 1;\n");
    expect(stderr).not.toContain("merge-conflict markers");
  });

  test("a marker-like text inside a line does not stop the format", () => {
    const { after } = runHook("inline.ts", 'export   const a  =  "<<<<<<< x"\n');
    expect(after).toBe('export const a = "<<<<<<< x";\n');
  });
});
