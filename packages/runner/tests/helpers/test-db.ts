import {
  constants,
  accessSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  statfsSync,
} from "node:fs";
import { join } from "node:path";

/**
 * R616: where a test's scratch SQLite databases go. On this machine's shared disk one `fsync` took
 * up to 5 s under other jobs' writes, and the tests that open a file database timed out at 5000 ms.
 * On a tmpfs (a RAM disk) an `fsync` costs nothing, so the preload (`scripts/test-preload.ts`) puts
 * one DB folder per test process there when it can, and on disk otherwise, always with a named
 * reason. Only the DB files go there: project folders and artifacts are MBs and stay in `tmpdir()`.
 * Production stores (`lethal.sqlite`) never come here; this is test code only.
 */

/** The ONE setting for the tmpfs root: this variable, else /dev/shm. */
export const TMPFS_ROOT_ENV = "LETHAL_TEST_TMPFS_ROOT";
export const DEFAULT_TMPFS_ROOT = "/dev/shm";
/** `1` keeps the DBs on disk (the proof's control arm). */
export const ON_DISK_ENV = "LETHAL_TEST_DB_ON_DISK";
/** Set by the preload: the folder, and why it is where it is. */
export const DB_DIR_ENV = "LETHAL_TEST_DB_DIR";
export const DB_DIR_WHY_ENV = "LETHAL_TEST_DB_DIR_WHY";
/**
 * Below this much free space the root is not used. A fast path only: the DBs are KB-sized, and a
 * root that fills anyway gives SQLITE_FULL in a test, a loud failure.
 */
export const MIN_FREE_MB = 16;

export interface RootFacts {
  readonly isDir: boolean;
  readonly writable: boolean;
  readonly freeMb: number;
}

/** `tmpfsRoot` undefined means on disk. */
export interface DbDirChoice {
  readonly tmpfsRoot: string | undefined;
  readonly why: string;
}

/** The choice, from the env and the root's facts (injected, so a test needs no real /dev/shm). */
export function chooseDbDir(
  env: Record<string, string | undefined>,
  facts: (root: string) => RootFacts,
): DbDirChoice {
  if (env[ON_DISK_ENV] === "1") return { tmpfsRoot: undefined, why: `fallback: ${ON_DISK_ENV}=1` };
  const root = env[TMPFS_ROOT_ENV] || DEFAULT_TMPFS_ROOT;
  const f = facts(root);
  if (!f.isDir) return { tmpfsRoot: undefined, why: `fallback: ${root} missing` };
  if (!f.writable) return { tmpfsRoot: undefined, why: `fallback: ${root} not writable` };
  if (f.freeMb < MIN_FREE_MB) {
    return {
      tmpfsRoot: undefined,
      why: `fallback: ${root} has ${f.freeMb} MB free (under ${MIN_FREE_MB})`,
    };
  }
  return { tmpfsRoot: root, why: "tmpfs" };
}

/** The real facts of a root. Anything that cannot be read counts as missing or not writable. */
export function probeRoot(root: string): RootFacts {
  try {
    if (!statSync(root).isDirectory()) return { isDir: false, writable: false, freeMb: 0 };
  } catch {
    return { isDir: false, writable: false, freeMb: 0 };
  }
  let writable = true;
  try {
    accessSync(root, constants.W_OK);
  } catch {
    writable = false;
  }
  const s = statfsSync(root);
  return { isDir: true, writable, freeMb: Math.floor((s.bavail * s.bsize) / (1024 * 1024)) };
}

const PREFIX = "lethal-unit-db-";

/** The `mkdtemp` prefix of one test process's DB folder: the pid makes it findable by the sweep. */
export function dbDirPrefix(root: string, pid: number): string {
  return join(root, `${PREFIX}${pid}-`);
}

/**
 * Removes the DB folders of processes that are gone. A worker killed by verify's watchdog skips
 * its `afterAll`, and the tmpfs is shared by every lane in the container. A live pid's folder is
 * kept. Returns the names removed.
 */
export function sweepDeadDbDirs(root: string, alive: (pid: number) => boolean): string[] {
  const removed: string[] = [];
  for (const name of readdirSync(root)) {
    const pid = new RegExp(`^${PREFIX}(\\d+)-`).exec(name)?.[1];
    if (pid === undefined || alive(Number(pid))) continue;
    rmSync(join(root, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

export class TestDbDirMissingError extends Error {
  constructor() {
    super(
      `R616: ${DB_DIR_ENV} is not set, so scripts/test-preload.ts did not load; run tests through bun scripts/verify.ts or from the repo root`,
    );
    this.name = "TestDbDirMissingError";
  }
}

/**
 * A fresh path for a scratch database file, in its own folder inside the preload's DB folder (the
 * preload removes the whole folder at the end). Throws when the preload did not set the folder:
 * never a silent fallback to disk.
 */
export function testDbPath(
  name: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const dir = env[DB_DIR_ENV];
  if (dir === undefined || dir === "") throw new TestDbDirMissingError();
  return join(mkdtempSync(join(dir, "t-")), name);
}
