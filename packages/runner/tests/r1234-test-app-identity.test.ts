// PR-476 (R1234): the session-level pins that need a whole session. Written on the al-runner-v3 shape
// (r619-one-lend's Stub): test 5 for the al-runner builder of `TestAppIdentity`, and test 7, the
// old-form sentence on every refusal path. The bcdev builders' test 5 are in orchestrator.test.ts
// (they need its env-tool harness), the c2 function's in app-content-identity.test.ts.
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import type { MicrosoftMode } from "../src/digest-inputs";
import type { RunEvent } from "../src/events";
import { createEmitter } from "../src/events";
import { runSession } from "../src/orchestrator";
import { ResultsStore } from "../src/store";
import { TestAppDriftedError } from "../src/test-membership";
import { servedIsInstalled, testAppJson, testAppPackage } from "./helpers/proven-test-app";
import { scratchDirs } from "./helpers/scratch";

const scratch = scratchDirs();

const TARGET_AL = `codeunit 79000 "Sandbox Logic"
{
    procedure IsOverBudget(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount > Budget);
    end;
}
`;
const EXTRA_AL = `codeunit 79002 "Sandbox Extra"
{
    procedure UnderLimit(Amount: Decimal; Limit: Decimal): Boolean
    begin
        exit(Amount < Limit);
    end;
}
`;
const TESTS_AL = `codeunit 79100 "Sandbox Tests"
{
    Subtype = Test;

    [Test]
    procedure OverBudgetDetected()
    begin
    end;

    [Test]
    procedure "Space Step"()
    begin
    end;

    [Test]
    procedure Pond()
    begin
    end;
}
`;
const APP_JSON = JSON.stringify({
  id: "6d0f4a2e-1c3b-4a8d-9f10-2b7c5e4d3a91",
  name: "Sandbox R1234 Fixture",
  publisher: "LethAL",
  version: "1.0.0.0",
  idRanges: [{ from: 79000, to: 79199 }],
});
const V3_VERSION = "alrunner 3.0.0-alpha.2 (91253f2d6)";
const ABORT_AFTER = 3;

class Stub implements ExecutionBackend {
  mutantRuns = 0;
  private active: string | null = null;
  constructor(
    private readonly abortAfter?: number,
    private readonly onFirstMutant?: () => void,
  ) {}
  capabilities(): BackendCapabilities {
    return {
      kind: "al-runner-v3",
      coverage: "none",
      deploy: "none",
      isolation: "session",
      authoritative: false,
    };
  }
  microsoftMode(): MicrosoftMode {
    return servedIsInstalled(() => testAppPackage());
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "stub" };
  }
  async deploy(): Promise<null> {
    return null;
  }
  async compileCheck(): Promise<void> {}
  async activate(id: string | null): Promise<void> {
    this.active = id;
  }
  async run(ref: TestMethodRef): Promise<TestVerdict> {
    if (this.active === null) return { ref, outcome: "pass", durationMs: 5 };
    this.mutantRuns += 1;
    if (this.mutantRuns === 1) this.onFirstMutant?.();
    if (this.abortAfter !== undefined && this.mutantRuns > this.abortAfter) {
      return {
        ref,
        outcome: "error",
        durationMs: 5,
        operation: "in-flight-unknown",
        failureMessage: "RunMutant timed out: AbortError",
      };
    }
    return {
      ref,
      outcome: "pass",
      durationMs: 5,
      attestation: { observedAny: true, identityMismatch: false },
    };
  }
  async runnerBuild(): Promise<{ version: string; binarySha256: string }> {
    return { version: V3_VERSION, binarySha256: "b".repeat(64) };
  }
}

async function project(twoFiles = false) {
  const root = scratch("lethal-r1234-");
  const dirs = {
    projectDir: join(root, "app"),
    testDir: join(root, "tests"),
    instrumentedDir: join(root, "instr"),
  };
  await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), TARGET_AL);
  if (twoFiles) await Bun.write(join(dirs.projectDir, "SandboxExtra.Codeunit.al"), EXTRA_AL);
  await Bun.write(join(dirs.projectDir, "app.json"), APP_JSON);
  await Bun.write(join(dirs.testDir, "SandboxTests.Codeunit.al"), TESTS_AL);
  await Bun.write(join(dirs.testDir, "app.json"), testAppJson());
  return dirs;
}
type Dirs = Awaited<ReturnType<typeof project>>;
const base = (store: ResultsStore, dirs: Dirs) => ({
  store,
  ...dirs,
  selectorIds: { selectorId: 50000, controlId: 50001, tableId: 50002 },
  stopHungSessions: true,
  mutantTimeoutMs: 2_000,
});
const lastRun = (store: ResultsStore) =>
  (store.db.query("SELECT MAX(id) AS id FROM runs").get() as { id: number }).id;

describe("PR-476 test 5, the al-runner builder: its drift check fires when the test source moves", () => {
  test("a test-source change after batch 0 is TestAppDriftedError at batch 1 (and nothing throws without it)", async () => {
    const run = async (move: boolean) => {
      const dirs = await project(true);
      const store = new ResultsStore(":memory:");
      const backend = new Stub(undefined, () => {
        if (move)
          writeFileSync(join(dirs.testDir, "SandboxTests.Codeunit.al"), `${TESTS_AL}// moved\n`);
      });
      const out = await runSession({ ...base(store, dirs), backend, maxGuardsPerBatch: 1 }).then(
        () => undefined,
        (e: unknown) => e,
      );
      return { out, store };
    };
    const control = await run(false);
    expect(control.out).toBeUndefined();
    const moved = await run(true);
    expect(moved.out).toBeInstanceOf(TestAppDriftedError);
    const e = moved.out as TestAppDriftedError;
    expect(e.proven).toStartWith("source:");
    expect(e.now).toStartWith("source:");
    expect(e.now).not.toBe(e.proven);
  });
});

const OLD_FORM = (suffix = "") => `package:${"a".repeat(64)}${suffix}`;
const SENTENCE = "the prior run's test-app identity is the pre-R1234 form (package:<hex>)";
const BOTH = "or a package LethAL does not content-hash (signed or of unknown shape)";

/** A first session that leaves an unfinished run; its identity is rewritten to `identity`, then a
 *  second session resumes it. The refusal's text, or `undefined` when it did not refuse. */
async function resumeRefusal(identity: string): Promise<string | undefined> {
  const dirs = await project();
  const store = new ResultsStore(":memory:");
  await runSession({ ...base(store, dirs), backend: new Stub(ABORT_AFTER) });
  const runId = lastRun(store);
  store.db.run("UPDATE runs SET test_app_hash = ? WHERE id = ?", [identity, runId]);
  try {
    await runSession({
      ...base(store, dirs),
      backend: new Stub(),
      resume: "last",
      retryStranded: true,
    });
    return undefined;
  } catch (err) {
    return (err as Error).message;
  } finally {
    store.close();
  }
}

describe("PR-476 test 7: an old-form prior says so, naming both causes, on every refusal path", () => {
  test("assertSameTestApp, plain: package:<hex>", async () => {
    const msg = await resumeRefusal(OLD_FORM());
    expect(msg).toContain("none of its verdicts is carried (R247, R495)");
    expect(msg).toContain(SENTENCE);
    expect(msg).toContain(BOTH);
    expect(msg).toContain("re-run fresh");
  });
  test("assertSameTestApp: package:<hex>|closed-world:public", async () => {
    const msg = await resumeRefusal(OLD_FORM("|closed-world:public"));
    expect(msg).toContain(SENTENCE);
  });
  test("the pending path: package:<hex>|pending", async () => {
    const msg = await resumeRefusal(OLD_FORM("|pending"));
    expect(msg).toContain("ended before its post-execution closed-world check");
    expect(msg).toContain(SENTENCE);
  });
  test("the revoked path: package:<hex>|closed-world:revoked", async () => {
    const msg = await resumeRefusal(OLD_FORM("|closed-world:revoked"));
    expect(msg).toContain("Its identity was revoked");
    expect(msg).toContain(SENTENCE);
  });
  test("a prior that is not old-form (c2, source:, other) gets no such sentence", async () => {
    for (const id of [
      `package:c2:${"b".repeat(64)}`,
      `source:${"c".repeat(64)}`,
      "package:other",
    ]) {
      const msg = await resumeRefusal(id);
      expect(msg).toContain("none of its verdicts is carried");
      expect(msg).not.toContain("the prior run's test-app identity is");
    }
  });
  test("the reworded TEST_APP_WHY: a timestamp-only recompile is no longer a different test app", async () => {
    const msg = await resumeRefusal(OLD_FORM());
    expect(msg).toContain("A recompile that changes only the build timestamp no longer counts");
    expect(msg).not.toContain("a recompile alc did not reproduce byte for byte");
  });
  test("--skip-known-survivors: the history warning carries the sentence", async () => {
    const dirs = await project();
    const store = new ResultsStore(":memory:");
    await runSession({ ...base(store, dirs), backend: new Stub() });
    const runId = lastRun(store);
    store.db.run("UPDATE runs SET test_app_hash = ? WHERE id = ?", [OLD_FORM(), runId]);
    const events: RunEvent[] = [];
    await runSession({
      ...base(store, dirs),
      backend: new Stub(),
      skipKnownSurvivors: true,
      emit: [createEmitter([(e) => events.push(e)])],
    });
    const warnings = events.flatMap((e) =>
      e.type === "warning" && e.code === "history-test-app-changed" ? [e.message] : [],
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(SENTENCE);
    expect(warnings[0]).toContain(BOTH);
    store.close();
  });
});
