import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// R223: the `.claude/hooks/compile-fixtures-touched.ts` hook. Loaded dynamically, because the hook
// lives outside the `scripts` project; its `import.meta.main` guard keeps the load side-effect free.
const hook = (await import(
  join(import.meta.dir, "../.claude/hooks/compile-fixtures-touched.ts")
)) as {
  compileCommand: (inventoryPath: string) => string[];
  hookExit: (code: number | null) => 0 | 2;
};

describe("R223: compile-fixtures-touched hook", () => {
  test("runs compile:fixtures WITH --inventory, so a missing alc exits 1 and blocks", () => {
    const cmd = hook.compileCommand("/tmp/x/inventory.json");
    expect(cmd.slice(0, 3)).toEqual(["bun", "run", "compile:fixtures"]);
    expect(cmd[cmd.indexOf("--inventory") + 1]).toBe("/tmp/x/inventory.json");
  });

  test("blocks (exit 2) on any non-zero compile exit, including a missing alc (exit 1)", () => {
    expect(hook.hookExit(1)).toBe(2);
    expect(hook.hookExit(null)).toBe(2);
  });

  test("passes (exit 0) when every fixture compiles", () => {
    expect(hook.hookExit(0)).toBe(0);
  });
});
