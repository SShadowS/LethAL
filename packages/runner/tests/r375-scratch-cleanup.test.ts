import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeScratchDir, scratchDirs } from "./helpers/scratch";

const tmp = scratchDirs();

/** A Windows-style lock, simulated so the test runs on Linux too: the folder and one file refuse. */
function lockedRm(lockedName: string): typeof rmSync {
  return ((p: string, opts?: Parameters<typeof rmSync>[1]) => {
    if (opts?.recursive === true || p.endsWith(lockedName)) {
      throw Object.assign(new Error(`EBUSY: resource busy or locked, rm '${p}'`), {
        code: "EBUSY",
      });
    }
    rmSync(p, opts);
  }) as typeof rmSync;
}

function runFolder(): string {
  const dir = tmp("lethal-r375-");
  mkdirSync(join(dir, "store"));
  writeFileSync(join(dir, "report.json"), "{}");
  writeFileSync(join(dir, "store", "lethal.sqlite-wal"), "");
  return dir;
}

describe("R375: removeScratchDir", () => {
  test("a folder that cannot be removed still fails with the R358 prefix (verdict unchanged)", () => {
    const dir = runFolder();
    expect(() => removeScratchDir(dir, lockedRm("lethal.sqlite-wal"))).toThrow(
      `R358: could not remove ${dir}: EBUSY`,
    );
  });

  test("the failure names the file still locked, with its error code", () => {
    const dir = runFolder();
    let message = "";
    try {
      removeScratchDir(dir, lockedRm("lethal.sqlite-wal"));
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain(`still locked: ${join("store", "lethal.sqlite-wal")} (EBUSY)`);
    expect(message).not.toContain("report.json");
  });

  test("a folder that can be removed is removed, silently", () => {
    const dir = runFolder();
    removeScratchDir(dir);
    expect(existsSync(dir)).toBe(false);
  });
});
