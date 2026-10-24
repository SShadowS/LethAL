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
import { accountedFor, checkDependents, dependentsWarning } from "../src/dependents-warning";
import { createEmitter } from "../src/events";
import type { RunEvent } from "../src/events";
import { DependentCountUnavailableError } from "../src/harness";
import { runSession } from "../src/orchestrator";
import { ResultsStore } from "../src/store";
import { removeScratchDirs } from "./helpers/scratch";

/** R727: warn (never refuse) before the first target publish when published apps beyond the run's
 *  tests app depend on the target. Fakes count calls; nothing reads a clock. */

const TARGET = { name: "Target App", id: "AAAAAAAA-1111-2222-3333-444444444444" };
const TESTS_ID = "bbbbbbbb-1111-2222-3333-444444444444";

describe("R727 dependentsWarning (pure)", () => {
  test("N=2, K=1: warns, naming N, K, the target and R709", () => {
    const m = dependentsWarning(2, 1, TARGET);
    expect(m).toContain("2 published app(s) depend on the target Target App");
    expect(m).toContain(TARGET.id);
    expect(m).toContain("accounts for 1");
    expect(m).toContain("R709");
  });
  test("N=1, K=1 and N=0, K=0: silent", () => {
    expect(dependentsWarning(1, 1, TARGET)).toBeNull();
    expect(dependentsWarning(0, 0, TARGET)).toBeNull();
  });
  test("N=1, K=0: warns", () => {
    expect(dependentsWarning(1, 0, TARGET)).toContain("1 published app(s)");
  });
  test("a read failure warns 'could not check', with the reason", () => {
    for (const error of [new DependentCountUnavailableError("too old"), new Error("boom")]) {
      const m = dependentsWarning({ error }, 0, TARGET);
      expect(m).toContain("could not check");
      expect(m).toContain(error.message);
      expect(m).toContain("R709");
    }
  });
  test("accountedFor compares ids case-insensitively", () => {
    expect(accountedFor({ dependencies: [{ id: TARGET.id.toLowerCase() }] }, TARGET.id)).toBe(1);
    expect(accountedFor({ dependencies: [{ id: TESTS_ID }] }, TARGET.id)).toBe(0);
    expect(accountedFor({}, TARGET.id)).toBe(0);
  });
});

describe("R727 checkDependents", () => {
  const dirs: string[] = [];
  afterEach(() => removeScratchDirs(dirs.splice(0)));
  async function testDir(deps: unknown[]): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), "lethal-r727-"));
    dirs.push(d);
    await Bun.write(join(d, "app.json"), JSON.stringify({ id: TESTS_ID, dependencies: deps }));
    return d;
  }

  test("reads K from the tests app.json: N=2 warns when it depends on the target, N=1 does not", async () => {
    const dir = await testDir([{ id: TARGET.id.toLowerCase() }]);
    expect(await checkDependents({ dependentCount: async () => 2 }, dir, TARGET)).toContain("R709");
    expect(await checkDependents({ dependentCount: async () => 1 }, dir, TARGET)).toBeNull();
    const none = await testDir([]);
    expect(await checkDependents({ dependentCount: async () => 1 }, none, TARGET)).not.toBeNull();
  });

  test("a failed read warns and does not throw", async () => {
    const dir = await testDir([]);
    for (const error of [new DependentCountUnavailableError("old"), new Error("down")]) {
      const m = await checkDependents(
        {
          dependentCount: async () => {
            throw error;
          },
        },
        dir,
        TARGET,
      );
      expect(m).toContain("could not check");
      expect(m).toContain(error.message);
    }
  });

  test("a backend without dependentCount: no message", async () => {
    expect(await checkDependents({}, await testDir([]), TARGET)).toBeNull();
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

/** A bcdev-like stub that logs every deploy and every dependentCount call, in order. */
class StubBackend implements ExecutionBackend {
  readonly calls: string[] = [];
  private active: string | null = null;
  constructor(
    readonly count: (() => Promise<number>) | undefined,
    readonly authoritative = true,
  ) {
    if (count !== undefined) {
      Object.assign(this, {
        dependentCount: (id: string) => {
          this.calls.push(`dependentCount:${id}`);
          return count();
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

describe("R727 through runSession", () => {
  beforeAll(async () => {
    await initParser();
  });
  const roots: string[] = [];
  afterEach(() => removeScratchDirs(roots.splice(0)));

  async function run(backend: StubBackend, testsDependOnTarget: boolean) {
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
        dependencies: testsDependOnTarget ? [{ id: TARGET.id }] : [],
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

  test("asks once, for the TARGET id, and warns before the first deploy", async () => {
    const backend = new StubBackend(async () => 2);
    const events = await run(backend, true);
    // The closed-world guard also asks, for the TESTS app id; only the target's asks are ours.
    const asked = backend.calls.filter((c) => c === `dependentCount:${TARGET.id}`);
    expect(asked).toHaveLength(1);
    expect(backend.calls).toContain(`dependentCount:${TESTS_ID}`);
    expect(backend.calls.filter((c) => c === "warning")).toHaveLength(1);
    expect(backend.calls.indexOf("deploy")).toBeGreaterThan(backend.calls.indexOf("warning"));
    expect(backend.calls.indexOf("warning")).toBeGreaterThan(
      backend.calls.indexOf(`dependentCount:${TARGET.id}`),
    );
    const w = events.find((e) => e.type === "warning" && e.code === "installed-dependents");
    expect(w).toBeDefined();
  });

  test("N=1 with the tests app depending on the target: asked, silent", async () => {
    const backend = new StubBackend(async () => 1);
    await run(backend, true);
    expect(backend.calls).not.toContain("warning");
    expect(backend.calls.filter((c) => c === `dependentCount:${TARGET.id}`)).toHaveLength(1);
  });

  test("a failed read warns before the deploy, and the run still deploys", async () => {
    const backend = new StubBackend(async () => {
      throw new DependentCountUnavailableError("old control app");
    });
    const events = await run(backend, true);
    const w = events.find((e) => e.type === "warning" && e.code === "installed-dependents");
    expect(w?.type === "warning" ? w.message : "").toContain("could not check");
    expect(backend.calls.indexOf("deploy")).toBeGreaterThan(backend.calls.indexOf("warning"));
  });

  test("a backend without dependentCount: no call, no warning", async () => {
    const backend = new StubBackend(undefined);
    await run(backend, true);
    expect(backend.calls).not.toContain("warning");
    expect(backend.calls.some((c) => c.startsWith("dependentCount"))).toBe(false);
    expect(backend.calls).toContain("deploy");
  });
});
