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
import { checkDependents, dependentsWarning, testsAppIdOf } from "../src/dependents-warning";
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

describe("R733 checkDependents", () => {
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
    const m = await checkDependents(
      { installedDependents: async () => [TESTS_DEP, OTHER_DEP] },
      dir,
      TARGET,
    );
    expect(m).toContain("Customer Extension");
    expect(m).not.toContain("The Tests");
    expect(
      await checkDependents({ installedDependents: async () => [TESTS_DEP] }, dir, TARGET),
    ).toBeNull();
  });

  test("a failed read warns and does not throw", async () => {
    const m = await checkDependents(
      {
        installedDependents: async () => {
          throw new Error("down");
        },
      },
      await testDir(),
      TARGET,
    );
    expect(m).toContain("could not check");
    expect(m).toContain("down");
  });

  test("a backend without installedDependents: no message", async () => {
    expect(await checkDependents({}, await testDir(), TARGET)).toBeNull();
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
