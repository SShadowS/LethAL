import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import {
  WALK_MAX_APPS,
  dependentsWarning,
  readDependents,
  testsAppIdOf,
  walkTransitiveDependents,
} from "../src/dependents-warning";
import { createEmitter } from "../src/events";
import type { RunEvent } from "../src/events";
import type { InstalledDependent } from "../src/harness";
import { runSession } from "../src/orchestrator";
import { ResultsStore } from "../src/store";
import { removeScratchDirs } from "./helpers/scratch";

/** R727, R733: warn (never refuse) before the first target publish, NAMING the installed apps
 *  beyond the run's tests app that depend on the target. Fakes count calls; nothing reads a clock. */

const TARGET = { name: "Target App", id: "AAAAAAAA-1111-2222-3333-444444444444" };
const TESTS_ID = "bbbbbbbb-1111-2222-3333-444444444444";
const dep = (id: string, name: string): InstalledDependent => ({
  id,
  name,
  publisher: "Pub",
  version: "1.2.3.4",
});
const TESTS_DEP = dep(TESTS_ID, "The Tests");
const OTHER_DEP = dep("cccccccc-1111-2222-3333-444444444444", "Customer Extension");

describe("R733 dependentsWarning (pure)", () => {
  test("another installed dependent: warns, naming it, its version and publisher, the target and R709", () => {
    const m = dependentsWarning([TESTS_DEP, OTHER_DEP], TESTS_ID, TARGET);
    expect(m).toContain("1 installed app(s) other than this run's tests app");
    expect(m).toContain("Customer Extension 1.2.3.4 by Pub (cccccccc-1111-2222-3333-444444444444)");
    expect(m).toContain("Target App");
    expect(m).toContain(TARGET.id);
    expect(m).toContain("R709");
    expect(m).not.toContain("The Tests");
  });
  test("only the tests app, or nothing: silent", () => {
    expect(dependentsWarning([TESTS_DEP], TESTS_ID, TARGET)).toBeNull();
    expect(dependentsWarning([], TESTS_ID, TARGET)).toBeNull();
  });
  test("the tests app is excluded by id, case-insensitively; an unknown tests id excludes nothing", () => {
    expect(dependentsWarning([dep(TESTS_ID.toUpperCase(), "T")], TESTS_ID, TARGET)).toBeNull();
    expect(dependentsWarning([TESTS_DEP], undefined, TARGET)).toContain("The Tests");
  });
  test("a read failure warns 'could not check', with the reason", () => {
    const error = new Error("boom");
    const m = dependentsWarning({ error }, TESTS_ID, TARGET);
    expect(m).toContain("could not check");
    expect(m).toContain("boom");
    expect(m).toContain("R709");
  });
  test("testsAppIdOf lowercases the id and reads nothing else", () => {
    expect(testsAppIdOf({ id: "ABC" })).toBe("abc");
    expect(testsAppIdOf({})).toBeUndefined();
    expect(testsAppIdOf(null)).toBeUndefined();
  });
});

describe("R733 readDependents (the read the session shares with the R843 clash check)", () => {
  const dirs: string[] = [];
  afterEach(() => removeScratchDirs(dirs.splice(0)));
  async function testDir(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), "lethal-r727-"));
    dirs.push(d);
    await Bun.write(join(d, "app.json"), JSON.stringify({ id: TESTS_ID.toUpperCase() }));
    return d;
  }

  test("names the other dependent and leaves the tests app (by its app.json id) out", async () => {
    const dir = await testDir();
    const both = await readDependents(
      { installedDependents: async () => [TESTS_DEP, OTHER_DEP] },
      dir,
      TARGET,
      Date.now,
    );
    expect(both?.read).toEqual([TESTS_DEP, OTHER_DEP]);
    expect(both?.testsAppId).toBe(TESTS_ID.toLowerCase());
    const m = both === null ? null : dependentsWarning(both.read, both.testsAppId, TARGET);
    expect(m).toContain("Customer Extension");
    expect(m).not.toContain("The Tests");
    const only = await readDependents(
      { installedDependents: async () => [TESTS_DEP] },
      dir,
      TARGET,
      Date.now,
    );
    expect(
      only === null ? "none" : dependentsWarning(only.read, only.testsAppId, TARGET),
    ).toBeNull();
  });

  test("a failed read is returned as the error, not thrown, and warns", async () => {
    const got = await readDependents(
      {
        installedDependents: async () => {
          throw new Error("down");
        },
      },
      await testDir(),
      TARGET,
      Date.now,
    );
    expect(got).not.toBeNull();
    if (got === null) return;
    expect(Array.isArray(got.read)).toBe(false);
    const m = dependentsWarning(got.read, got.testsAppId, TARGET);
    expect(m).toContain("could not check");
    expect(m).toContain("down");
  });

  test("a backend without installedDependents: no call, null", async () => {
    expect(await readDependents({}, await testDir(), TARGET, Date.now)).toBeNull();
  });
});

describe("R845 walkTransitiveDependents", () => {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const app = (n: number) => dep(id(n), `App${n}`);
  const clock = { now: () => 0, startedMs: 0 };
  /** A graph as adjacency: app number to the numbers that depend on it. Counts every call. */
  function graph(edges: Record<string, number[]>, calls: string[]) {
    return async (appId: string) => {
      calls.push(appId);
      return (edges[appId] ?? []).map(app);
    };
  }

  test("breadth first, the tests app's branch first, each app once", async () => {
    const calls: string[] = [];
    const list = graph({ [id(1)]: [3], [id(2)]: [4], [id(3)]: [5], [id(4)]: [5] }, calls);
    const got = await walkTransitiveDependents(list, TARGET.id, [app(1), app(2)], id(2), clock);
    expect(got.transitive.map((d) => d.name)).toEqual(["App4", "App3", "App5"]);
    expect(got.warnings).toEqual([]);
    expect(calls).toEqual([id(2), id(1), id(4), id(3), id(5)]);
  });

  test("the target's own id is seeded: a stray row naming the target is not a dependent of itself", async () => {
    const calls: string[] = [];
    const stray = dep(TARGET.id.toLowerCase(), "Target App");
    const got = await walkTransitiveDependents(
      async (appId) => {
        calls.push(appId);
        return appId === id(1) ? [stray] : [];
      },
      TARGET.id,
      [app(1)],
      undefined,
      clock,
    );
    expect(got.transitive).toEqual([]);
    expect(calls).toEqual([id(1)]);
  });

  test("a cycle ends", async () => {
    const calls: string[] = [];
    const list = graph({ [id(1)]: [2], [id(2)]: [3], [id(3)]: [1, 2] }, calls);
    const got = await walkTransitiveDependents(list, TARGET.id, [app(1)], undefined, clock);
    expect(got.transitive.map((d) => d.name)).toEqual(["App2", "App3"]);
    expect(calls).toHaveLength(3);
  });

  test("a failed read of one level warns by name and ends that branch only", async () => {
    const got = await walkTransitiveDependents(
      async (appId) => {
        if (appId === id(1)) throw new Error("HTTP 500");
        return appId === id(2) ? [app(4)] : [];
      },
      TARGET.id,
      [app(1), app(2)],
      undefined,
      clock,
    );
    expect(got.transitive.map((d) => d.name)).toEqual(["App4"]);
    expect(got.warnings).toHaveLength(1);
    expect(got.warnings[0]).toContain("App1");
    expect(got.warnings[0]).toContain("HTTP 500");
  });

  test("the app bound: at most 40 apps in all, then a warning naming how many were not read", async () => {
    const calls: string[] = [];
    // Every app has one dependent, a chain far longer than 40.
    const list = async (appId: string) => {
      calls.push(appId);
      const n = Number.parseInt(appId.slice(-12), 10);
      return [app(n + 1)];
    };
    const got = await walkTransitiveDependents(list, TARGET.id, [app(1)], undefined, clock);
    expect(1 + got.transitive.length).toBe(WALK_MAX_APPS);
    expect(calls).toHaveLength(WALK_MAX_APPS - 1);
    expect(got.warnings).toHaveLength(1);
    expect(got.warnings[0]).toContain("40 apps");
    expect(got.warnings[0]).toContain("1 app(s) were NOT read");
  });

  test("the time bound: past 120 s no further level is read, and it warns", async () => {
    const calls: string[] = [];
    let t = 0;
    const list = async (appId: string) => {
      calls.push(appId);
      t += 70_000; // each read takes 70 s on the fake clock
      const n = Number.parseInt(appId.slice(-12), 10);
      return [app(n + 1)];
    };
    const got = await walkTransitiveDependents(list, TARGET.id, [app(1)], undefined, {
      now: () => t,
      startedMs: 0,
    });
    expect(calls).toHaveLength(2); // read at 0 s and 70 s, refused at 140 s
    expect(got.warnings).toHaveLength(1);
    expect(got.warnings[0]).toContain("120 s");
  });

  test("dependentsWarning names a transitive dependent, and it is not treated as the tests app", () => {
    const m = dependentsWarning([TESTS_DEP], TESTS_ID, TARGET, [OTHER_DEP]);
    expect(m).toContain("Customer Extension");
    expect(m).toContain("[transitive]");
    expect(m).not.toContain("The Tests");
  });

  test("readDependents walks: the target is asked first, then each dependent, and the result carries both", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-r845-"));
    try {
      await Bun.write(join(dir, "app.json"), JSON.stringify({ id: TESTS_ID }));
      const calls: string[] = [];
      const got = await readDependents(
        {
          installedDependents: async (appId: string) => {
            calls.push(appId);
            return appId === TARGET.id ? [TESTS_DEP] : appId === TESTS_ID ? [OTHER_DEP] : [];
          },
        },
        dir,
        TARGET,
        () => 7,
      );
      expect(got?.read).toEqual([TESTS_DEP]);
      expect(got?.transitive).toEqual([OTHER_DEP]);
      expect(got?.startedMs).toBe(7);
      expect(calls).toEqual([TARGET.id, TESTS_ID, OTHER_DEP.id]);
    } finally {
      removeScratchDirs([dir]);
    }
  });
});

const TARGET_AL = `codeunit 50013 "R727 Target"
{
    procedure Run(): Boolean
    begin
        exit(1 < 2);
    end;
}
`;
const TEST_AL = `codeunit 50014 "R727 Tests"
{
    Subtype = Test;

    [Test]
    procedure Plain()
    begin
    end;
}
`;

/** A bcdev-like stub that logs every deploy and every installedDependents call, in order. */
class StubBackend implements ExecutionBackend {
  readonly calls: string[] = [];
  private active: string | null = null;
  constructor(
    readonly list: (() => Promise<readonly InstalledDependent[]>) | undefined,
    readonly authoritative = true,
  ) {
    if (list !== undefined) {
      Object.assign(this, {
        installedDependents: (id: string) => {
          this.calls.push(`installedDependents:${id}`);
          return list();
        },
      });
    }
  }
  capabilities(): BackendCapabilities {
    return {
      coverage: "procedure",
      deploy: "publish",
      isolation: "session",
      kind: "bcdev",
      authoritative: this.authoritative,
    };
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "stub" };
  }
  async runnerBuild(): Promise<{ version: string; binarySha256: string }> {
    return { version: "x", binarySha256: "b".repeat(64) };
  }
  async deploy(): Promise<null> {
    this.calls.push("deploy");
    return null;
  }
  async compileCheck(): Promise<void> {}
  async activate(id: string | null): Promise<void> {
    this.active = id;
  }
  async run(ref: TestMethodRef): Promise<TestVerdict> {
    return {
      ref,
      outcome: "pass",
      durationMs: 5,
      ...(this.active === null
        ? {
            coverage: {
              granularity: "procedure" as const,
              entries: [{ objectType: "Codeunit", objectId: 50013, procedure: "Run" }],
            },
          }
        : { attestation: { observedAny: true, identityMismatch: false } }),
    };
  }
}

describe("R733 through runSession", () => {
  beforeAll(async () => {
    await initParser();
  });
  const roots: string[] = [];
  afterEach(() => removeScratchDirs(roots.splice(0)));

  async function run(backend: StubBackend) {
    const root = await mkdtemp(join(tmpdir(), "lethal-r727-"));
    roots.push(root);
    const targetJson = { id: TARGET.id, name: TARGET.name, publisher: "x", version: "1.0.0.0" };
    await Bun.write(join(root, "app", "app.json"), JSON.stringify(targetJson));
    await Bun.write(join(root, "app", "Target.Codeunit.al"), TARGET_AL);
    await Bun.write(
      join(root, "tests", "app.json"),
      JSON.stringify({
        id: TESTS_ID,
        name: "t",
        publisher: "x",
        version: "1.0.0.0",
        dependencies: [{ id: TARGET.id }],
      }),
    );
    await Bun.write(join(root, "tests", "R727.Codeunit.al"), TEST_AL);
    const events: RunEvent[] = [];
    await runSession({
      backend,
      store: new ResultsStore(":memory:"),
      projectDir: join(root, "app"),
      testDir: join(root, "tests"),
      instrumentedDir: join(root, "instr"),
      selectorIds: { selectorId: 50147, controlId: 50148, tableId: 50149 },
      emit: [
        createEmitter([
          (e) => {
            if (e.type === "warning" && e.code === "installed-dependents") {
              backend.calls.push("warning");
            }
            events.push(e);
          },
        ]),
      ],
    });
    return events;
  }

  test("asks once, for the TARGET id, and warns before the first deploy, naming the other app", async () => {
    const backend = new StubBackend(async () => [TESTS_DEP, OTHER_DEP]);
    const events = await run(backend);
    expect(backend.calls.filter((c) => c === `installedDependents:${TARGET.id}`)).toHaveLength(1);
    expect(backend.calls.filter((c) => c === "warning")).toHaveLength(1);
    expect(backend.calls.indexOf("deploy")).toBeGreaterThan(backend.calls.indexOf("warning"));
    expect(backend.calls.indexOf("warning")).toBeGreaterThan(
      backend.calls.indexOf(`installedDependents:${TARGET.id}`),
    );
    const w = events.find((e) => e.type === "warning" && e.code === "installed-dependents");
    expect(w?.type === "warning" ? w.message : "").toContain("Customer Extension");
  });

  test("only the tests app installed: asked, silent", async () => {
    const backend = new StubBackend(async () => [TESTS_DEP]);
    await run(backend);
    expect(backend.calls).not.toContain("warning");
    expect(backend.calls.filter((c) => c === `installedDependents:${TARGET.id}`)).toHaveLength(1);
  });

  test("a failed read warns before the deploy, and the run still deploys", async () => {
    const backend = new StubBackend(async () => {
      throw new Error("InstalledDependents failed: HTTP 404");
    });
    const events = await run(backend);
    const w = events.find((e) => e.type === "warning" && e.code === "installed-dependents");
    expect(w?.type === "warning" ? w.message : "").toContain("could not check");
    expect(backend.calls.indexOf("deploy")).toBeGreaterThan(backend.calls.indexOf("warning"));
  });

  test("a backend without installedDependents: no call, no warning", async () => {
    const backend = new StubBackend(undefined);
    await run(backend);
    expect(backend.calls).not.toContain("warning");
    expect(backend.calls.some((c) => c.startsWith("installedDependents"))).toBe(false);
    expect(backend.calls).toContain("deploy");
  });
});
