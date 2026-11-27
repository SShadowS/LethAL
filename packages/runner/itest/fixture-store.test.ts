import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDENTITY_SCHEME } from "@lethal/schemata";
import { ResultsStore } from "../src/store";
import { FixtureStoreHeldError, openFixtureStore } from "./fixture-store";

// R1241: a fixture's shared store, opened by gates. Scratch stores under a fresh temp dir; no BC.
function scratchStore(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "r1241-"));
  return { dir, path: join(dir, "lethal.sqlite") };
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

// Red: drop the live-holder refusal in claim(): the second open succeeds.
test("a second gate on a held store is refused, naming the holder; after close it opens", () => {
  const { dir, path } = scratchStore();
  try {
    const a = openFixtureStore(path);
    expect(() => openFixtureStore(path)).toThrow(FixtureStoreHeldError);
    expect(() => openFixtureStore(path)).toThrow(new RegExp(`pid ${process.pid}`));
    // on Linux the refusal also names the holder's command line (this test's own: bun)
    if (process.platform === "linux") expect(() => openFixtureStore(path)).toThrow(/\): \S*bun/);
    a.close();
    expect(existsSync(`${path}.itest-holder`)).toBe(false);
    openFixtureStore(path).close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a holder whose process is gone is taken over; a holder naming another process is left on close", () => {
  const { dir, path } = scratchStore();
  try {
    writeFileSync(`${path}.itest-holder`, JSON.stringify({ pid: 424242, cmd: "gone", since: "x" }));
    const a = openFixtureStore(path, () => false);
    expect(JSON.parse(readFileSync(`${path}.itest-holder`, "utf8")).pid).toBe(process.pid);
    // someone else's holder (written after ours) must survive our close
    writeFileSync(
      `${path}.itest-holder`,
      JSON.stringify({ pid: 424243, cmd: "other", since: "y" }),
    );
    a.close();
    expect(JSON.parse(readFileSync(`${path}.itest-holder`, "utf8")).pid).toBe(424243);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Red: make ownRunId() read SELECT MAX(id): "after" returns the other run's id instead of refusing.
test("two concurrent runs in one store, both orders: the gate never reads the other's run as its own", () => {
  for (const order of ["other-after", "other-before"] as const) {
    const { dir, path } = scratchStore();
    try {
      const seed = new ResultsStore(path);
      newRun(seed); // an older run, from before the gate opened
      seed.close();
      const gate = openFixtureStore(path);
      const other = new ResultsStore(path); // a writer the holder file cannot see
      try {
        if (order === "other-before") newRun(other);
        newRun(gate.store);
        if (order === "other-after") newRun(other);
        expect(() => gate.ownRunId()).toThrow(/exactly one run after run 1 .* found 2 \(2, 3\)/);
      } finally {
        other.close();
        gate.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// Red: make ownRunId() count every run (no mark): the older run makes it refuse.
test("one run after the mark is the gate's own, though older runs exist; none is refused", () => {
  const { dir, path } = scratchStore();
  try {
    const seed = new ResultsStore(path);
    newRun(seed);
    newRun(seed);
    seed.close();
    const gate = openFixtureStore(path);
    try {
      expect(() => gate.ownRunId()).toThrow(/found 0 \(none\)/);
      const mine = newRun(gate.store);
      expect(gate.ownRunId()).toBe(mine);
      expect(mine).toBe(3);
    } finally {
      gate.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
