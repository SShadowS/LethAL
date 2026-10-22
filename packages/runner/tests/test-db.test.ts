import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_TMPFS_ROOT,
  MIN_FREE_MB,
  type RootFacts,
  TestDbDirMissingError,
  chooseDbDir,
  dbDirPrefix,
  probeRoot,
  sweepDeadDbDirs,
  testDbPath,
} from "./helpers/test-db";

/**
 * R616: scratch test databases go on a tmpfs (a RAM disk) when it can take them, else on disk, and
 * the choice always carries its reason. `chooseDbDir` is pure: the root's facts are injected.
 */
const OK: RootFacts = { isDir: true, writable: true, freeMb: 2000 };
const facts =
  (f: RootFacts, seen: string[] = []) =>
  (root: string): RootFacts => {
    seen.push(root);
    return f;
  };

describe("R616 chooseDbDir", () => {
  test("a writable tmpfs root with room is chosen, named tmpfs", () => {
    expect(chooseDbDir({}, facts(OK))).toEqual({ tmpfsRoot: "/dev/shm", why: "tmpfs" });
  });
  test("the root is one setting: LETHAL_TEST_TMPFS_ROOT moves it, and the probe looks there", () => {
    expect(DEFAULT_TMPFS_ROOT).toBe("/dev/shm");
    const seen: string[] = [];
    expect(chooseDbDir({ LETHAL_TEST_TMPFS_ROOT: "/work/tmpfs" }, facts(OK, seen))).toEqual({
      tmpfsRoot: "/work/tmpfs",
      why: "tmpfs",
    });
    expect(seen).toEqual(["/work/tmpfs"]);
  });
  test("a missing root falls back to disk, named", () => {
    expect(chooseDbDir({}, facts({ isDir: false, writable: false, freeMb: 0 }))).toEqual({
      tmpfsRoot: undefined,
      why: "fallback: /dev/shm missing",
    });
  });
  test("a root that is not writable falls back to disk, named", () => {
    expect(chooseDbDir({}, facts({ isDir: true, writable: false, freeMb: 2000 }))).toEqual({
      tmpfsRoot: undefined,
      why: "fallback: /dev/shm not writable",
    });
  });
  test("a root under the 16 MB floor falls back to disk, naming its free space; at the floor it is chosen", () => {
    expect(MIN_FREE_MB).toBe(16);
    expect(chooseDbDir({}, facts({ isDir: true, writable: true, freeMb: 15 }))).toEqual({
      tmpfsRoot: undefined,
      why: "fallback: /dev/shm has 15 MB free (under 16)",
    });
    expect(chooseDbDir({}, facts({ isDir: true, writable: true, freeMb: 16 })).why).toBe("tmpfs");
  });
  test("LETHAL_TEST_DB_ON_DISK=1 keeps the DBs on disk without probing, named", () => {
    const seen: string[] = [];
    expect(chooseDbDir({ LETHAL_TEST_DB_ON_DISK: "1" }, facts(OK, seen))).toEqual({
      tmpfsRoot: undefined,
      why: "fallback: LETHAL_TEST_DB_ON_DISK=1",
    });
    expect(seen).toEqual([]);
  });
});

describe("R616 the real probe", () => {
  test("a writable folder is a writable dir with free space; a missing path is not a dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "r616-probe-"));
    try {
      const f = probeRoot(dir);
      expect(f.isDir).toBe(true);
      expect(f.writable).toBe(true);
      expect(f.freeMb).toBeGreaterThan(0);
      expect(probeRoot(join(dir, "missing")).isDir).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("R616 one DB folder per worker, and the dead-worker sweep", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });
  const scratchRoot = (): string => {
    const r = mkdtempSync(join(tmpdir(), "r616-root-"));
    roots.push(r);
    return r;
  };

  test("two workers get different folders, both inside the root, each naming its pid", () => {
    const root = scratchRoot();
    const a = mkdtempSync(dbDirPrefix(root, 101));
    const b = mkdtempSync(dbDirPrefix(root, 102));
    expect(a).not.toBe(b);
    expect(dirname(a)).toBe(root);
    expect(dirname(b)).toBe(root);
    expect(a.slice(root.length + 1)).toStartWith("lethal-unit-db-101-");
    expect(b.slice(root.length + 1)).toStartWith("lethal-unit-db-102-");
  });

  test("the sweep removes a dead worker's folder and keeps a live one's and anything else", () => {
    const root = scratchRoot();
    const dead = mkdtempSync(dbDirPrefix(root, 4_000_001));
    const live = mkdtempSync(dbDirPrefix(root, process.pid));
    const other = join(root, "someone-else-4000001");
    mkdirSync(other);
    const removed = sweepDeadDbDirs(root, (pid) => pid === process.pid);
    expect(removed).toEqual([dead.slice(root.length + 1)]);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });
});

describe("R616 testDbPath", () => {
  test("a fresh path inside LETHAL_TEST_DB_DIR on every call, with the name kept", () => {
    const dir = process.env.LETHAL_TEST_DB_DIR;
    expect(dir, "the preload sets LETHAL_TEST_DB_DIR").toBeDefined();
    const a = testDbPath("lethal.sqlite");
    const b = testDbPath("lethal.sqlite");
    expect(a).not.toBe(b);
    for (const p of [a, b]) {
      expect(p.startsWith(`${dir}`)).toBe(true);
      expect(p.endsWith("lethal.sqlite")).toBe(true);
      expect(existsSync(dirname(p))).toBe(true);
    }
  });
  test("it throws by name when the variable is missing or empty, never falling back", () => {
    expect(() => testDbPath("x.sqlite", {})).toThrow(TestDbDirMissingError);
    expect(() => testDbPath("x.sqlite", { LETHAL_TEST_DB_DIR: "" })).toThrow(TestDbDirMissingError);
  });
  test("under the preload, the folder is the one its reason names", () => {
    const dir = process.env.LETHAL_TEST_DB_DIR ?? "";
    const why = process.env.LETHAL_TEST_DB_DIR_WHY;
    if (why === "tmpfs") {
      const root = process.env.LETHAL_TEST_TMPFS_ROOT || DEFAULT_TMPFS_ROOT;
      expect(dirname(dir)).toBe(root);
      expect(dir.slice(root.length + 1)).toStartWith(`lethal-unit-db-${process.pid}-`);
    } else {
      expect(why).toStartWith("fallback: ");
      expect(dir.startsWith(DEFAULT_TMPFS_ROOT)).toBe(false);
    }
  });
});
