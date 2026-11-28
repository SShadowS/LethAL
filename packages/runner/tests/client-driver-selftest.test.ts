import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * PR-479: the client driver's own `--self-test` (pure helpers: the Line Type ordinal rule and the repeater page merge).
 * It needs the built driver dll and dotnet; CI has neither, so it skips with the reason named.
 */
const DLL = join(import.meta.dir, "..", "client-driver", "out", "client-driver.dll");
const dotnet = Bun.which("dotnet");
const skipReason = !existsSync(DLL)
  ? `built driver missing: ${DLL}`
  : dotnet === null
    ? "dotnet not on PATH"
    : undefined;
if (skipReason !== undefined) console.log(`client-driver --self-test SKIPPED: ${skipReason}`);

describe("client driver --self-test", () => {
  test.skipIf(skipReason !== undefined)("every case passes and the exit code is 0", () => {
    const r = Bun.spawnSync([dotnet ?? "dotnet", DLL, "--self-test"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = r.stdout.toString();
    expect(out).not.toContain("FAIL");
    expect(out).toContain('PASS IsFunctionLine "1" is true');
    expect(out).toContain("self-test ok");
    expect(r.exitCode).toBe(0);
  });
});
