import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findAlc, requireAll } from "./compile-fixtures";

const ext = "/h/.vscode/extensions/ms-dynamics-smb.al-18.0.2732683";
test("linux takes bin/linux/alc and never the Windows launcher", () => {
  const files = new Set([`${ext}/bin/alc.exe`, `${ext}/bin/linux/alc`]);
  expect(
    findAlc({
      platform: "linux",
      env: {},
      home: "/h",
      exists: (p) => files.has(p),
      extensionDirs: [ext],
    }),
  ).toBe(`${ext}/bin/linux/alc`);
});
test("linux with only alc.exe finds nothing", () => {
  const files = new Set([`${ext}/bin/alc.exe`]);
  expect(
    findAlc({
      platform: "linux",
      env: {},
      home: "/h",
      exists: (p) => files.has(p),
      extensionDirs: [ext],
    }),
  ).toBeNull();
});
test("LETHAL_ALC_DIR wins", () => {
  expect(
    findAlc({
      platform: "linux",
      env: { LETHAL_ALC_DIR: "/opt/al-ext/bin/linux" },
      home: "/h",
      exists: () => true,
      extensionDirs: [ext],
    }),
  ).toBe("/opt/al-ext/bin/linux/alc");
});
test("win32 keeps today's order", () => {
  const files = new Set([`${ext}/bin/win32/alc.exe`, `${ext}/bin/alc.exe`]);
  expect(
    findAlc({
      platform: "win32",
      env: {},
      home: "/h",
      exists: (p) => files.has(p),
      extensionDirs: [ext],
    }),
  ).toBe(`${ext}/bin/win32/alc.exe`);
});

test("requireAll lists every skipped project with its reason", () => {
  expect(
    requireAll([
      { project: "a", status: "compiled" },
      { project: "b", status: "skipped", why: "no .alpackages" },
    ]),
  ).toEqual(["b: no .alpackages"]);
  expect(requireAll([{ project: "a", status: "compiled" }])).toEqual([]);
});

test.skipIf(process.platform === "win32")("CLI exits 1 on Linux with no alc", () => {
  const empty = mkdtempSync(join(tmpdir(), "cf-empty-"));
  try {
    const r = spawnSync("bun", [join(import.meta.dir, "compile-fixtures.ts")], {
      encoding: "utf8",
      env: { ...process.env, LETHAL_ALC_DIR: empty, HOME: empty, USERPROFILE: empty },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no Linux alc found (set LETHAL_ALC_DIR)");
    expect(r.stderr).not.toContain("SKIPPED");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
