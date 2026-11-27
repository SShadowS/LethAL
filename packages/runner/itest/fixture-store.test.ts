import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDENTITY_SCHEME } from "@lethal/schemata";
import { ResultsStore } from "../src/store";
import {
  FixtureStoreHeldError,
  holdFixtureStore,
  holderAlive,
  openFixtureStore,
  processAlive,
  startTimeOf,
} from "./fixture-store";

// R1241: a fixture's shared store, held and opened by gates. Scratch stores under a fresh temp dir; no BC.
function scratchStore(): { dir: string; path: string; holder: string } {
  const dir = mkdtempSync(join(tmpdir(), "r1241-"));
  const path = join(dir, "lethal.sqlite");
  return { dir, path, holder: `${path}.itest-holder` };
}
function newRun(store: ResultsStore): number {
  return store.createRun({
    testScope: [],
    coverageMode: "procedure",
    identityScheme: IDENTITY_SCHEME,
    buildSymbols: [],
    projectPath: "/p",
    backend: "bcdev",
    appVersion: "1.0.0.0",
  });
}
/** The pid of a child that has exited and been reaped: no process has it (barring reuse in the test's lifetime). */
function deadPid(): number {
  const p = Bun.spawnSync(["true"]);
  return p.pid;
}
const linux = process.platform === "linux";

// Red: drop the live-holder refusal in holdFixtureStore: the second hold succeeds.
test("a second gate on a held store is refused, naming the holder; after release it is held again", () => {
  const { dir, path, holder } = scratchStore();
  try {
    const a = holdFixtureStore(path);
    expect(() => holdFixtureStore(path)).toThrow(FixtureStoreHeldError);
    expect(() => holdFixtureStore(path)).toThrow(new RegExp(`pid ${process.pid}`));
    // on Linux the refusal also names the holder's command line (this test's own: bun)
    if (linux) expect(() => holdFixtureStore(path)).toThrow(/\): \S*bun/);
    a.release();
    expect(existsSync(holder)).toBe(false);
    holdFixtureStore(path).release();
    // no temp or set-aside file is left in the directory
    expect(readdirSync(dir).filter((f) => f.includes("itest-holder"))).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Red: make processAlive's catch return true: the dead pid reads as alive, and the default hold refuses it.
test("a holder whose process is gone is taken over by the default check; a dead pid is not alive", () => {
  const { dir, path, holder } = scratchStore();
  try {
    const gone = deadPid();
    expect(processAlive(gone)).toBe(false);
    expect(processAlive(process.pid)).toBe(true);
    writeFileSync(holder, JSON.stringify({ pid: gone, start: null, since: "x" }));
    const a = holdFixtureStore(path);
    expect(JSON.parse(readFileSync(holder, "utf8")).pid).toBe(process.pid);
    a.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Red: drop the start-time comparison in holderAlive: a reused pid (here: our own, with another start) is refused.
test("a reused pid is not taken for the holder: same pid, another start time, is taken over (Linux)", () => {
  if (!linux) return;
  const { dir, path, holder } = scratchStore();
  try {
    const mine = startTimeOf(process.pid);
    expect(mine).toMatch(/^\d+$/);
    expect(holderAlive({ pid: process.pid, start: mine, since: "" })).toBe(true);
    expect(holderAlive({ pid: process.pid, start: "1", since: "" })).toBe(false);
    writeFileSync(holder, JSON.stringify({ pid: process.pid, start: "1", since: "x" }));
    holdFixtureStore(path).release();
    expect(existsSync(holder)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Red: treat an unreadable holder as gone (the first build): it is taken over instead of refused.
test("an unreadable holder file (empty, or not a holder) is refused by name, never taken over", () => {
  for (const text of ["", "not json", '{"since":"x"}']) {
    const { dir, path, holder } = scratchStore();
    try {
      writeFileSync(holder, text);
      expect(() => holdFixtureStore(path)).toThrow(/cannot be read.*delete .*itest-holder by hand/);
      expect(readFileSync(holder, "utf8")).toBe(text);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// Red: drop the pid check in release: another process's holder (written after ours) is deleted.
test("release leaves a holder that names another process", () => {
  const { dir, path, holder } = scratchStore();
  try {
    const a = holdFixtureStore(path);
    writeFileSync(holder, JSON.stringify({ pid: deadPid(), start: null, since: "y" }));
    a.release();
    expect(existsSync(holder)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Red: drop the hold check in openFixtureStore: a gate that skipped holdFixtureStore opens the store.
test("the store opens only under this process's hold", () => {
  const { dir, path, holder } = scratchStore();
  try {
    expect(() => openFixtureStore(path)).toThrow(/without this process's hold/);
    writeFileSync(holder, JSON.stringify({ pid: deadPid(), start: null, since: "z" }));
    expect(() => openFixtureStore(path)).toThrow(/without this process's hold/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Red: open a fixture's store in any itest with `new ResultsStore(join(PROJECT_DIR, ...))`, bypassing the hold.
test("no itest opens a fixture's shared store except through openFixtureStore, and each such gate holds it", () => {
  const dir = import.meta.dir;
  const bypass: string[] = [];
  const unheld: string[] = [];
  const gates = readdirSync(dir).filter((n) => n.endsWith(".itest.ts"));
  expect(gates).toContain("bcdev.itest.ts"); // the scan reads the gates, not nothing
  for (const f of gates) {
    const src = readFileSync(join(dir, f), "utf8");
    if (/new ResultsStore\(\s*join\(\s*PROJECT_DIR/.test(src)) bypass.push(f);
    if (
      src.includes("openFixtureStore(join(PROJECT_DIR") &&
      !src.includes("holdFixtureStore(join(PROJECT_DIR")
    )
      unheld.push(f);
  }
  expect(bypass).toEqual([]);
  expect(unheld).toEqual([]);
});

// Red: make ownRunId() read SELECT MAX(id): "other-after" returns the other run's id instead of refusing.
test("two concurrent runs in one store, both orders: the gate never reads the other's run as its own", () => {
  for (const order of ["other-after", "other-before"] as const) {
    const { dir, path } = scratchStore();
    try {
      const seed = new ResultsStore(path);
      newRun(seed); // an older run, from before the gate opened
      seed.close();
      const hold = holdFixtureStore(path);
      const gate = openFixtureStore(path);
      const other = new ResultsStore(path); // a writer the hold cannot see
      try {
        if (order === "other-before") newRun(other);
        newRun(gate.store);
        if (order === "other-after") newRun(other);
        expect(() => gate.ownRunId()).toThrow(/exactly one run after run 1 .* found 2 \(2, 3\)/);
      } finally {
        other.close();
        gate.close();
        hold.release();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// Red: make ownRunId() count every run (no mark): the older runs make it refuse.
test("one run after the mark is the gate's own, though older runs exist; none is refused; two legs, one hold", () => {
  const { dir, path } = scratchStore();
  try {
    const seed = new ResultsStore(path);
    newRun(seed);
    newRun(seed);
    seed.close();
    const hold = holdFixtureStore(path);
    try {
      for (const expected of [3, 4]) {
        const leg = openFixtureStore(path);
        try {
          expect(() => leg.ownRunId()).toThrow(/found 0 \(none\)/);
          const mine = newRun(leg.store);
          expect(mine).toBe(expected);
          expect(leg.ownRunId()).toBe(mine);
        } finally {
          leg.close();
        }
      }
    } finally {
      hold.release();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
