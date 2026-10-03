import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findAlc, inventoryReport, requireAll } from "./compile-fixtures";

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

test("LETHAL_ALC_DIR set but missing falls through to the extension", () => {
  const files = new Set([`${ext}/bin/linux/alc`]);
  expect(
    findAlc({
      platform: "linux",
      env: { LETHAL_ALC_DIR: "/nope" },
      home: "/h",
      exists: (p) => files.has(p),
      extensionDirs: [ext],
    }),
  ).toBe(`${ext}/bin/linux/alc`);
});
test("LETHAL_ALC_DIR on win32 means alc.exe", () => {
  expect(
    findAlc({
      platform: "win32",
      env: { LETHAL_ALC_DIR: "C:/x/bin" },
      home: "/h",
      exists: () => true,
      extensionDirs: [ext],
    }),
  ).toBe("C:/x/bin/alc.exe");
});
test("win32 falls back to bin/alc.exe", () => {
  const files = new Set([`${ext}/bin/alc.exe`]);
  expect(
    findAlc({
      platform: "win32",
      env: {},
      home: "/h",
      exists: (p) => files.has(p),
      extensionDirs: [ext],
    }),
  ).toBe(`${ext}/bin/alc.exe`);
});
test("newest extension dir wins", () => {
  const old = "/h/.vscode/extensions/ms-dynamics-smb.al-17.0.1";
  expect(
    findAlc({
      platform: "linux",
      env: {},
      home: "/h",
      exists: () => true,
      extensionDirs: [ext, old],
    }),
  ).toBe(`${ext}/bin/linux/alc`);
  expect(
    findAlc({
      platform: "linux",
      env: {},
      home: "/h",
      exists: (p) => p.startsWith(old),
      extensionDirs: [ext, old],
    }),
  ).toBe(`${old}/bin/linux/alc`);
});

test("inventoryReport labels and counts compiled, skipped and failed apart", () => {
  const r = inventoryReport([
    { project: "a", status: "compiled" },
    { project: "b", status: "skipped", why: "no alc" },
    { project: "c", status: "failed" },
  ]);
  expect([r.compiled, r.skipped, r.failed]).toEqual([1, 1, 1]);
  expect(r.lines[0]).toContain("compiled 1, skipped 1, failed 1");
  expect(r.lines[1]).toContain("COMPILED");
  expect(r.lines[2]).toContain("SKIPPED");
  expect(r.lines[3]).toContain("FAILED");
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
    const all = spawnSync("bun", [join(import.meta.dir, "compile-fixtures.ts"), "--require-all"], {
      encoding: "utf8",
      env: { ...process.env, LETHAL_ALC_DIR: empty, HOME: empty, USERPROFILE: empty },
    });
    expect(all.status).toBe(1);
    expect(all.stdout).toContain("compiled 0, skipped ");
    expect(all.stdout).toContain("SKIPPED  fixtures/sandbox-app");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
