// ————————————————————————————————————————————————————————————————————————
// Layer 5B (Task 15): cross-cutting fault-injection oracles.
//
// Most per-seam containment invariants already have dedicated coverage from Tasks 8-13 (see
// docs/superpowers/specs 2026-07-20-layer-5b-single-container-hardening-design.md §14 and the
// per-file audit recorded in .superpowers/sdd/5b-task-15-report.md):
//   - client deadline after dispatch -> in-flight-unknown -> latch + quarantine, at the
//     baseline/mutant/kill-confirm sites: orchestrator.test.ts "runSession — Task 12 quarantine
//     on in-flight-unknown deadline" and "— latch+quarantine on in-flight-unknown at baseline
//     and kill-confirm too".
//   - transport pre-dispatch-rejected (retry-safe) vs in-flight-unknown (never retried, latches):
//     orchestrator.test.ts "activateOnce / runOnce — retry only pre-dispatch failures";
//     bcdev-backend.test.ts "run() connect failure before dispatch is pre-dispatch-rejected" /
//     "run() rejection AFTER dispatch is in-flight-unknown"; al-runner-backend.test.ts "marks a
//     transport error pre-dispatch-rejected" / "deadline does NOT set an unsafe-latching
//     operation".
//   - SetActive 2xx malformed body -> completed-effect-unknown, no retry: activation.test.ts
//     "echo mismatch after a 2xx is completed-effect-unknown (no blind retry)"; orchestrator.test.ts
//     "activateOnce rethrows a completed-effect-unknown failure WITHOUT retry or latch".
//   - finally/DeploymentVerifier/status() gating after an unsafe latch: orchestrator.test.ts
//     "finally teardown does NOT call activate(null) once the session is unsafe" / "finally DOES
//     call activate(null) on the ordinary (safe) path"; "a pre-quarantined tier refuses to run
//     before status() is ever called".
//   - generation-checked clear: quarantine-store.test.ts "QuarantineStore clear
//     (generation-checked)"; cli.test.ts "clearQuarantine (Task 13)".
//
// This file adds ONLY the two seams that audit found genuinely uncovered:
//   1. a QuarantineStore whose record() rejects must fail the session loudly — it must never
//      resolve as if the tier had been safely marked.
//   2. a durable quarantine written off the back of a real in-flight-unknown latch survives a
//      brand-new QuarantineStore instance (simulating a process restart) AND actually gates the
//      next session, not just readable-but-inert — closing the loop existing tests each prove
//      only half of (Task 12 proves the record lands; Task 11 proves a PRE-SEEDED record blocks
//      a session; nothing chains "organically produced -> survives restart -> blocks retry" in
//      one place).
// ————————————————————————————————————————————————————————————————————————

import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SelectorConfig } from "@lethal/schemata";
import type { CompiledArtifact } from "../src/artifact";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import { runSession } from "../src/orchestrator";
import type { SessionConfig } from "../src/orchestrator";
import { QuarantineStore } from "../src/quarantine-store";
import { ResultsStore } from "../src/store";

const TARGET_AL = `codeunit 79000 "Sandbox Logic"
{
    procedure IsOverBudget(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount > Budget);
    end;
}
`;

const TEST_AL = `codeunit 79100 "Sandbox Tests"
{
    Subtype = Test;

    [Test]
    procedure OverBudgetDetected()
    begin
    end;
}
`;

const APP_ID = "22222222-2222-2222-2222-222222222222";
const APP_JSON = JSON.stringify(
  {
    id: APP_ID,
    name: "Fault Injection Fixture",
    publisher: "LethAL",
    version: "1.0.0.0",
    idRanges: [{ from: 79000, to: 79199 }],
  },
  null,
  2,
);

const selectorIds: SelectorConfig = { selectorId: 50000, controlId: 50001, tableId: 50002 };

async function makeProject() {
  const root = await mkdtemp(join(tmpdir(), "lethal-fault-injection-"));
  const projectDir = join(root, "app");
  const testDir = join(root, "tests");
  const instrumentedDir = join(root, "instr");
  await Bun.write(join(projectDir, "SandboxLogic.Codeunit.al"), TARGET_AL);
  await Bun.write(join(projectDir, "app.json"), APP_JSON);
  await Bun.write(join(testDir, "SandboxTests.Codeunit.al"), TEST_AL);
  return { projectDir, testDir, instrumentedDir };
}

/** Same shape as orchestrator.test.ts's fakeBackend: a minimal always-passing default,
 *  overridable per test. Duplicated locally (not exported from orchestrator.test.ts) — every
 *  test file in this package keeps its own small fixture set rather than sharing one. */
function fakeBackend(overrides: Partial<ExecutionBackend> = {}): ExecutionBackend {
  const caps: BackendCapabilities = {
    coverage: "none",
    deploy: "publish",
    isolation: "session",
    authoritative: true,
  };
  return {
    capabilities: () => caps,
    status: async (): Promise<BackendStatus> => ({ ok: true, details: "fake" }),
    deploy: async (): Promise<CompiledArtifact | null> => null,
    compileCheck: async () => {},
    activate: async () => {},
    run: async (ref: TestMethodRef): Promise<TestVerdict> => ({
      ref,
      outcome: "pass",
      durationMs: 1,
    }),
    ...overrides,
  };
}

/** Fresh per-call quarantine dir — no test may share (or race on) another's quarantine state. */
function freshTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "lethal-fault-injection-quarantine-"));
}

/** Builds a full SessionConfig around a caller-supplied fake backend, matching the tier identity
 *  ("http://cronus281|BC") the Task 11/12 orchestrator.test.ts oracles already assert against. */
async function runSessionForTest(
  backend: ExecutionBackend,
  overrides: Partial<SessionConfig> = {},
) {
  const dirs = await makeProject();
  const store = new ResultsStore(":memory:");
  return runSession({
    backend,
    store,
    ...dirs,
    selectorIds,
    resourceServer: "http://cronus281",
    resourceServerInstance: "BC",
    ...overrides,
  });
}

/** A STATEFUL fake: once `activate()` names a real mutant, EVERY subsequent run() reports "still
 *  running" (deadline-exceeded / in-flight-unknown) — it never resolves to a terminal signal, so
 *  a "call abort then continue on the next call" implementation could not pass this. Mirrors the
 *  `activeMutant` pattern orchestrator.test.ts's own Task 12 fixtures use. */
function stillRunningOnceActiveBackend(): ExecutionBackend {
  let activeMutant: string | null = null;
  return fakeBackend({
    activate: async (id) => {
      activeMutant = id;
    },
    run: async (ref) =>
      activeMutant === null
        ? { ref, outcome: "pass", durationMs: 1 }
        : { ref, outcome: "deadline-exceeded", durationMs: 1, operation: "in-flight-unknown" },
  });
}

const RESOURCE_KEY = "http://cronus281|BC";

describe("fault injection — QuarantineStore write failure must fail the session loudly", () => {
  test("record() rejecting propagates as a thrown error, not a quiet quarantined report, and nothing partial lands on disk", async () => {
    const dir = freshTmpDir();
    const activateCalls: Array<string | null> = [];
    let activeMutant: string | null = null;
    // Stateful (same pattern as stillRunningOnceActiveBackend above), inlined here so this test
    // can also track every activate() call for the latch-gated-finally assertion below.
    const backend = fakeBackend({
      activate: async (id) => {
        activateCalls.push(id);
        activeMutant = id;
      },
      run: async (ref) =>
        activeMutant === null
          ? { ref, outcome: "pass", durationMs: 1 }
          : { ref, outcome: "deadline-exceeded", durationMs: 1, operation: "in-flight-unknown" },
    });
    const recordSpy = spyOn(QuarantineStore.prototype, "record").mockRejectedValue(
      new Error("ENOSPC: no space left on device"),
    );
    let result: unknown;
    try {
      result = await runSessionForTest(backend, {
        quarantineDir: dir,
        nowIso: () => "2026-07-20T12:00:00.000Z",
      }).catch((e: unknown) => e);
    } finally {
      recordSpy.mockRestore();
    }
    // The session must fail LOUDLY — reject with the store's own error — never resolve with a
    // report as if the tier had been safely marked quarantined.
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("ENOSPC");
    // The in-memory latch still trips (it is set BEFORE the durable write is attempted), so the
    // latch-gated finally teardown must still refuse a post-latch activate(null) even though the
    // durable write itself failed — a failed durability write must not reopen the mutating path.
    const firstMutantId = activateCalls.find((id): id is string => id !== null);
    expect(firstMutantId).toBeDefined(); // sanity: the latch path was actually reached
    const afterLatch = activateCalls.slice(activateCalls.indexOf(firstMutantId as string) + 1);
    expect(afterLatch).not.toContain(null);
    // And nothing partial/corrupt landed on disk: a real (unmocked) store reading the same dir
    // sees no record at all — the failed record() never got as far as the atomic rename.
    const real = new QuarantineStore(dir);
    expect(await real.read(RESOURCE_KEY)).toBeNull();
  });
});

describe("fault injection — crash-between-ambiguity-and-write durability", () => {
  test("a quarantine written off a real in-flight-unknown latch survives a brand-new QuarantineStore instance and gates the NEXT session", async () => {
    const dir = freshTmpDir();
    const backend = stillRunningOnceActiveBackend();
    const report = await runSessionForTest(backend, {
      quarantineDir: dir,
      nowIso: () => "2026-07-20T12:00:00.000Z",
    });
    expect(report.quarantined?.reason).toContain("in-flight-unknown");

    // Simulate a process restart: a store instance that shares NO JS state with the one
    // runSession constructed internally, reading the same directory, must still see the marker
    // this session recorded before it (hypothetically) crashed.
    const restarted = new QuarantineStore(dir);
    const rec = await restarted.read(RESOURCE_KEY);
    expect(rec).not.toBeNull();
    expect(rec?.generation).toBe(1);
    expect(rec?.opKind).toBe("test-run");
    expect(rec?.detail).toContain("in-flight-unknown");
    expect(rec?.recordedAtIso).toBe("2026-07-20T12:00:00.000Z");

    // Close the loop: the marker isn't merely readable, it actually GATES the next session. An
    // operator (or an automated retry) attempting to run again against the same tier before
    // running `lethal clear-quarantine` must be refused before even a non-mutating status()
    // probe — exactly the scenario of a process crashing right after the durable write and
    // something restarting it (or a naive retry) without clearing first.
    let statusCalledOnRetry = false;
    const retryBackend = fakeBackend({
      status: async () => {
        statusCalledOnRetry = true;
        return { ok: true, details: "" };
      },
    });
    await expect(runSessionForTest(retryBackend, { quarantineDir: dir })).rejects.toThrow(
      /quarantined/i,
    );
    expect(statusCalledOnRetry).toBe(false);
  });
});
