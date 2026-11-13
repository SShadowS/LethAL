import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const HOOK = join(import.meta.dir, "..", ".claude", "hooks", "no-shell-edits.ts");

function runHook(command: string): number {
  const r = spawnSync("bun", [HOOK], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8",
  });
  return r.status ?? -1;
}

describe("no-shell-edits hook (owner, 2026-11-13)", () => {
  test.each([
    "sed -i 's/a/b/' file.ts",
    "sed -i.bak 's/a/b/' file.ts",
    "sed --in-place 's/a/b/' f",
    "sed -Ei 's/a/b/' f",
    "cd x && sed -i 's/a/b/' f",
    "mv a b; sed -i 's|r943|r944|' /dev/null",
    "find . -name '*.ts' | xargs sed -i 's/a/b/'",
  ])("refuses %s", (cmd) => {
    expect(runHook(cmd)).toBe(2);
  });

  test.each([
    "sed -n 1,20p file.ts",
    "free -g | sed -n 2p",
    "grep -n 'sed -i' docs/x.md",
    "echo used sed earlier",
    "git log --grep=sed",
  ])("allows %s", (cmd) => {
    expect(runHook(cmd)).toBe(0);
  });

  test("unparseable input never blocks", () => {
    const r = spawnSync("bun", [HOOK], { input: "not json", encoding: "utf8" });
    expect(r.status).toBe(0);
  });
});
