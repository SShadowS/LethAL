/**
 * PR-329 step 0: `LETHAL_V3_LANE_DUMP` makes a tagged survivor send two extra strictOrder requests
 * (mutant active, then none) and dump their raw answers. A shell backend with a stub daemon and call logs.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlRunnerV3Backend } from "../src/al-runner-v3-backend";
import type { TestMethodRef } from "../src/backend";

const ref = (codeunitId: number): TestMethodRef => ({
  codeunitId,
  codeunitName: `Tests${codeunitId}`,
  method: "T",
});
const SITE = { objectType: "codeunit", codeunitId: 50100 };

type Body = Record<string, unknown> & {
  entries: { id: string; resources: Record<string, string>; test: string }[];
};

function shell(opts: { singleInstance: boolean; refuse?: boolean; empty?: boolean }) {
  const calls: Body[] = [];
  const closes: string[] = [];
  const state = { open: false, starts: 0 };
  const resource = join(tmpdir(), `pr329-res-${Math.random().toString(36).slice(2)}`);
  const fileAtCall: (string | undefined)[] = [];
  const daemon = {
    requests: 0,
    server: {
      runEntries: async (body: Body) => {
        calls.push(body);
        fileAtCall.push(await readFile(resource, "utf8").catch(() => undefined));
        if (opts.refuse) throw new Error("strictOrder refused");
        if (!state.open) throw new Error("daemon is closed");
        if (opts.empty) return { tests: [], summary: {} };
        return {
          tests: [{ codeunit: 1, method: "T", status: "pass", message: "m", name: "Codeunit1.T" }],
          summary: { orderHints: [{ name: "Codeunit1.T" }] },
        };
      },
    },
  };
  const b = Object.create(AlRunnerV3Backend.prototype) as Record<string, unknown>;
  b.lanesBuilt = false;
  b.lane = { requestBase: () => ({ command: "runTests" }), resourcePath: () => resource };
  b.testsPerCodeunit = new Map([
    [1, 1],
    [2, 1],
    [3, 1],
  ]);
  b.echoId = 9;
  b.ensureDaemon = async () => {
    if (!state.open) {
      state.open = true;
      state.starts += 1;
    }
    return daemon;
  };
  b.coverageIndex = {
    singleInstance: new Set(opts.singleInstance ? ["codeunit:50100"] : []),
  };
  b.serveStopSeconds = () => 60;
  b.closeLane = async (_l: unknown, reason: string) => {
    state.open = false;
    closes.push(reason);
  };
  return {
    calls,
    closes,
    state,
    resource,
    fileAtCall,
    backend: b as unknown as AlRunnerV3Backend,
  };
}

describe("LETHAL_V3_LANE_DUMP", () => {
  let dir = "";
  let file = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pr329-"));
    file = join(dir, "dump.ndjson");
  });
  afterEach(async () => {
    // biome-ignore lint/performance/noDelete: unsetting an env var needs delete
    delete process.env.LETHAL_V3_LANE_DUMP;
    await rm(dir, { recursive: true, force: true });
  });
  const lines = async () =>
    (await readFile(file, "utf8").catch(() => ""))
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  test("unset: zero extra requests", async () => {
    const s = shell({ singleInstance: true });
    await s.backend.laneDump("M1", [ref(1), ref(2)], [1, 2], SITE);
    expect(s.calls.length).toBe(0);
    expect(s.closes.length).toBe(0);
    expect(await lines()).toEqual([]);
  });

  test("set, tagged survivor: four strictOrder requests; mutant active only on the mutant kinds", async () => {
    process.env.LETHAL_V3_LANE_DUMP = file;
    const s = shell({ singleInstance: true });
    await writeFile(s.resource, "PRIOR", "utf8");
    await s.backend.laneDump("M1", [ref(2), ref(1)], [2, 1], SITE);
    expect(s.calls.length).toBe(4);
    for (const c of s.calls) expect(c.strictOrder).toBe(true);
    const [em, en, bm, bn] = s.calls;
    expect(em?.entries.map((e) => Object.values(e.resources)[0])).toEqual(["M1", "M1"]);
    expect(en?.entries.every((e) => Object.values(e.resources)[0] !== "M1")).toBe(true);
    // one entry per covering codeunit, in the no-ledger order
    expect(em?.entries.map((e) => e.test)).toEqual(["Codeunit2.", "Codeunit1."]);
    // the batch kinds: no entries, the complement (codeunit 3 and the echo 9) in excludeTests
    for (const c of [bm, bn]) {
      expect(c?.entries).toBeUndefined();
      expect(c?.excludeTests).toEqual(["Codeunit3.", "Codeunit9."]);
    }
    // the resource file carried the mutant id, then NONE, and holds its prior content again
    expect(s.fileAtCall.slice(2)).toEqual(["M1", "NONE"]);
    expect(await readFile(s.resource, "utf8")).toBe("PRIOR");
    const got = await lines();
    expect(got.map((l) => l.kind)).toEqual([
      "lane-mutant",
      "lane-none",
      "lane-batch-mutant",
      "lane-batch-none",
    ]);
    expect(got.map((l) => l.activation)).toEqual([
      "entry-resources",
      "entry-resources",
      "resource-file",
      "resource-file",
    ]);
    for (const l of got) {
      expect(l.accepted).toBe(true);
      expect(l.codeunitOrder).toEqual([2, 1]);
      expect(l.mutantId).toBe("M1");
      expect(l.rows).toEqual([{ codeunit: 1, method: "T", status: "pass", message: "m" }]);
      expect(l.summary).toEqual({ orderHints: [{ name: "Codeunit1.T" }] });
    }
    expect(s.closes).toEqual(["probe"]);
  });

  test("set, untagged survivor (not SingleInstance, or one codeunit): zero requests", async () => {
    process.env.LETHAL_V3_LANE_DUMP = file;
    const plain = shell({ singleInstance: false });
    await plain.backend.laneDump("M1", [ref(1), ref(2)], [1, 2], SITE);
    const one = shell({ singleInstance: true });
    await one.backend.laneDump("M1", [ref(1), ref(1)], [1], SITE);
    expect(plain.calls.length + one.calls.length).toBe(0);
    expect(await lines()).toEqual([]);
  });

  test("two tagged survivors in a row both get their pair (the daemon is restarted)", async () => {
    process.env.LETHAL_V3_LANE_DUMP = file;
    const s = shell({ singleInstance: true });
    await s.backend.laneDump("M1", [ref(1), ref(2)], [1, 2], SITE);
    await s.backend.laneDump("M2", [ref(1), ref(2)], [1, 2], SITE);
    expect(s.calls.length).toBe(8);
    expect(s.state.starts).toBe(2);
    const got = await lines();
    expect(got.length).toBe(8);
    expect(got.every((l) => l.accepted === true)).toBe(true);
    expect(got.filter((l) => l.mutantId === "M2").length).toBe(4);
    // no prior file: the batch kinds leave none behind
    expect(await readFile(s.resource, "utf8").catch(() => "gone")).toBe("gone");
  });

  test("zero rows is accepted false, never a result", async () => {
    process.env.LETHAL_V3_LANE_DUMP = file;
    const s = shell({ singleInstance: true, empty: true });
    await s.backend.laneDump("M1", [ref(1), ref(2)], [1, 2], SITE);
    const got = await lines();
    expect(got.length).toBe(4);
    for (const l of got) {
      expect(l.accepted).toBe(false);
      expect(l.error).toBe("zero rows (silently empty)");
    }
  });

  test("a refused request: accepted false with the error, no throw, one line per request", async () => {
    process.env.LETHAL_V3_LANE_DUMP = file;
    const s = shell({ singleInstance: true, refuse: true });
    await s.backend.laneDump("M1", [ref(1), ref(2)], [1, 2], SITE);
    await writeFile(s.resource, "PRIOR", "utf8");
    await s.backend.laneDump("M2", [ref(1), ref(2)], [1, 2], SITE);
    // restored after a throw too
    expect(await readFile(s.resource, "utf8")).toBe("PRIOR");
    const got = await lines();
    expect(got.length).toBe(8);
    for (const l of got) {
      expect(l.accepted).toBe(false);
      expect(l.error).toBe("strictOrder refused");
      expect(l.rows).toEqual([]);
    }
  });
});
