import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import { AlRunnerV3Backend } from "../src/al-runner-v3-backend";
import type { CompiledArtifact } from "../src/artifact";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import { BcDevMcpBackend } from "../src/bcdev-backend";
import type { RunEvent } from "../src/events";
import { UnfilteredExtensionsQueryError } from "../src/harness";
import { runSession } from "../src/orchestrator";
import { RunMutantTransport, type newControlState } from "../src/run-mutant-transport";
import { ResultsStore } from "../src/store";
import { removeScratchDir } from "./helpers/scratch";

/**
 * R739: a backend's own user-facing notices become warning events for the length of a session
 * (`setNotify`), and go back to the console after it.
 */

const APP_JSON = JSON.stringify({
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  name: "T",
  publisher: "P",
  version: "1.0.0.0",
  idRanges: [{ from: 50000, to: 79999 }],
});
const GOOD_AL = `codeunit 79301 "Good"
{
    procedure Compute()
    var
        Counter: Integer;
    begin
        Counter := 1;
    end;
}
`;
const TEST_AL = `codeunit 79400 "Good Tests"
{
    Subtype = Test;

    [Test]
    procedure ComputeWorks()
    begin
    end;
}
`;
const SELECTOR_IDS = { selectorId: 60000, controlId: 60001, tableId: 60002 };

class PlainBackend implements ExecutionBackend {
  private active: string | null = null;
  capabilities(): BackendCapabilities {
    return {
      coverage: "procedure",
      deploy: "publish",
      isolation: "session",
      kind: "bcdev",
      authoritative: true,
    };
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "stub" };
  }
  async deploy(): Promise<CompiledArtifact | null> {
    return null;
  }
  async compileCheck(): Promise<void> {}
  async activate(id: string | null): Promise<void> {
    this.active = id;
  }
  async run(ref: TestMethodRef): Promise<TestVerdict> {
    if (this.active === null) {
      return {
        ref,
        outcome: "pass",
        durationMs: 5,
        coverage: {
          granularity: "procedure",
          entries: [{ objectType: "Codeunit", objectId: 79301, procedure: "Compute" }],
        },
      };
    }
    return {
      ref,
      outcome: "pass",
      durationMs: 5,
      attestation: { observedAny: true, identityMismatch: false },
    };
  }
}

/** Behaves as the real backends do: a default console notifier, replaced by `setNotify`. */
class NotifyingBackend extends PlainBackend {
  setNotifyCalls: Array<"fn" | "undefined"> = [];
  private notify: (code: string, message: string) => void = (_c, m) => console.warn(m);
  setNotify(notify?: (code: string, message: string) => void): void {
    this.setNotifyCalls.push(notify === undefined ? "undefined" : "fn");
    this.notify = notify ?? ((_c, m) => console.warn(m));
  }
  say(code: string, message: string): void {
    this.notify(code, message);
  }
  override async deploy(): Promise<CompiledArtifact | null> {
    this.say("fake-notice", "first notice");
    this.say("fake-notice", "second notice, the same code");
    return null;
  }
}

const roots: string[] = [];
beforeAll(async () => {
  await initParser();
});
afterAll(() => {
  for (const r of roots) removeScratchDir(r);
});

async function project() {
  const root = await mkdtemp(join(tmpdir(), "lethal-r739-"));
  roots.push(root);
  const projectDir = join(root, "app");
  const testDir = join(root, "tests");
  await Bun.write(join(projectDir, "app.json"), APP_JSON);
  await Bun.write(join(projectDir, "src/Good.Codeunit.al"), GOOD_AL);
  await Bun.write(join(testDir, "GoodTests.Codeunit.al"), TEST_AL);
  return { projectDir, testDir, instrumentedDir: join(root, "instr") };
}

function noticesOf(events: readonly RunEvent[], code: string): string[] {
  return events.flatMap((e) => (e.type === "warning" && e.code === code ? [e.message] : []));
}

describe("R739 B: setNotify routes a backend's notices through the session", () => {
  test("two different notices of one code give two events, in order, and nothing on the console", async () => {
    const dirs = await project();
    const backend = new NotifyingBackend();
    const events: RunEvent[] = [];
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await runSession({
        backend,
        store: new ResultsStore(":memory:"),
        ...dirs,
        selectorIds: SELECTOR_IDS,
        emit: [(e) => events.push(e)],
      });
      expect(noticesOf(events, "fake-notice")).toEqual([
        "first notice",
        "second notice, the same code",
      ]);
      expect(warn.mock.calls.flat().join("\n")).not.toContain("first notice");
    } finally {
      warn.mockRestore();
    }
  });

  test("a notice after the session goes to console.warn, not to the finished session's events", async () => {
    const dirs = await project();
    const backend = new NotifyingBackend();
    const events: RunEvent[] = [];
    await runSession({
      backend,
      store: new ResultsStore(":memory:"),
      ...dirs,
      selectorIds: SELECTOR_IDS,
      emit: [(e) => events.push(e)],
    });
    // Installed once, restored once.
    expect(backend.setNotifyCalls).toEqual(["fn", "undefined"]);
    const before = noticesOf(events, "after-session").length;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      backend.say("after-session", "said after the session");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toBe("said after the session");
    } finally {
      warn.mockRestore();
    }
    expect(noticesOf(events, "after-session").length).toBe(before);
  });

  test("the notifier is restored when the session throws", async () => {
    const dirs = await project();
    const backend = new NotifyingBackend();
    backend.run = async () => {
      throw new Error("boom");
    };
    const err = await runSession({
      backend,
      store: new ResultsStore(":memory:"),
      ...dirs,
      selectorIds: SELECTOR_IDS,
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(backend.setNotifyCalls).toEqual(["fn", "undefined"]);
  });

  test("a backend without setNotify still runs a session", async () => {
    const dirs = await project();
    const report = await runSession({
      backend: new PlainBackend(),
      store: new ResultsStore(":memory:"),
      ...dirs,
      selectorIds: SELECTOR_IDS,
    });
    expect(report.mutants.length).toBeGreaterThan(0);
  });
});

describe("R739 B: the real backends restart their once-per-backend notices for each session", () => {
  const refused = new Map([["table:50110", "coverage refused for Table:50110"]]);
  type BcDevInternals = {
    nameRefusals(r: ReadonlyMap<string, string>): void;
    leftoverWarned: boolean;
    danglingWarned: boolean;
    controlState: { notify?: unknown };
  };

  test("bcdev: two sessions on one backend both get the coverage-refused-object event", () => {
    const backend = new BcDevMcpBackend({} as never);
    const internals = backend as unknown as BcDevInternals;
    const first: Array<[string, string]> = [];
    const second: Array<[string, string]> = [];
    backend.setNotify((c, m) => first.push([c, m]));
    internals.nameRefusals(refused);
    internals.nameRefusals(refused); // once per object per session
    expect(first).toEqual([
      ["coverage-refused-object", "[lethal] coverage refused for Table:50110"],
    ]);
    backend.setNotify(undefined);
    backend.setNotify((c, m) => second.push([c, m]));
    internals.nameRefusals(refused);
    expect(second).toEqual([
      ["coverage-refused-object", "[lethal] coverage refused for Table:50110"],
    ]);
  });

  test("bcdev: setNotify resets the leftover and dangling flags; undefined restores the console", () => {
    const backend = new BcDevMcpBackend({} as never);
    const internals = backend as unknown as BcDevInternals;
    internals.leftoverWarned = true;
    internals.danglingWarned = true;
    backend.setNotify(() => {});
    expect(internals.leftoverWarned).toBe(false);
    expect(internals.danglingWarned).toBe(false);
    // Restoring does not reset: a console user keeps the once-per-backend behaviour.
    internals.leftoverWarned = true;
    backend.setNotify(undefined);
    expect(internals.leftoverWarned).toBe(true);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      internals.nameRefusals(refused);
      expect(String(warn.mock.calls[0]?.[0])).toBe("[lethal] coverage refused for Table:50110");
    } finally {
      warn.mockRestore();
    }
  });

  test("v3: setNotify resets the .NET helper flag", () => {
    const backend = new AlRunnerV3Backend({
      alcPath: "/fake/alc",
      packagesDir: "/fake/deps",
      instrumentedDir: "/fake/instr",
    } as never);
    const internals = backend as unknown as { dotnetHelperWarned: boolean };
    internals.dotnetHelperWarned = true;
    backend.setNotify(() => {});
    expect(internals.dotnetHelperWarned).toBe(false);
    backend.setNotify(undefined);
  });
});

describe("R739 B: the transport's further late refusals go through the backend's notify", () => {
  const recordLate = (t: RunMutantTransport, err: UnfilteredExtensionsQueryError): void =>
    (t as unknown as { recordLate(e: UnfilteredExtensionsQueryError): void }).recordLate(err);

  test("the first is kept silently, a later one is a lease-refusal-extra notice", () => {
    const backend = new BcDevMcpBackend({} as never);
    const state = (backend as unknown as { controlState: ReturnType<typeof newControlState> })
      .controlState;
    const transport = new RunMutantTransport({} as never, "app", "art", undefined, {
      controlState: state,
    });
    const seen: Array<[string, string]> = [];
    backend.setNotify((c, m) => seen.push([c, m]));
    recordLate(transport, new UnfilteredExtensionsQueryError("one"));
    expect(seen).toEqual([]);
    recordLate(transport, new UnfilteredExtensionsQueryError("two"));
    expect(seen.map(([c]) => c)).toEqual(["lease-refusal-extra"]);
    expect(seen[0]?.[1]).toContain("a further refused unfiltered extensions query");
    // After the session: the console.
    backend.setNotify(undefined);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      recordLate(transport, new UnfilteredExtensionsQueryError("three"));
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
    expect(seen).toHaveLength(1);
  });
});

// Each test goes red if its bcdev site reverts to `console.warn`.
describe("R739: bcdev notices reach setNotify, never the console", () => {
  type Internals = {
    warnOnThinFencedCoverage(
      ref: { codeunitId: number; codeunitName: string; method: string },
      totalRows: number,
      declaredRows: number,
      refusedRows: number,
      flaggedObjects: readonly string[],
      besideMembers: readonly { key: string; lines: readonly number[]; memberRows: number }[],
      rowKeys: readonly string[],
    ): void;
    stageForCompile(instrumentedDir: string): Promise<string>;
  };
  const REF = { codeunitId: 79100, codeunitName: "Tests", method: "A" };

  test("thin fenced coverage: no row for a declared object, and no line in a known procedure", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const backend = new BcDevMcpBackend({} as never);
      const seen: Array<[string, string]> = [];
      backend.setNotify((c, m) => seen.push([c, m]));
      const internals = backend as unknown as Internals;
      internals.warnOnThinFencedCoverage(REF, 3, 0, 0, [], [], []);
      internals.warnOnThinFencedCoverage(REF, 3, 2, 0, ["table:79150 (2 row(s))"], [], []);
      // R748: an empty no-member list must not silence the beside-members code.
      internals.warnOnThinFencedCoverage(
        REF,
        3,
        2,
        0,
        [],
        [{ key: "Codeunit:79100", lines: [1], memberRows: 1 }],
        [],
      );
      // R746/R747: no flagged object (no gap, or a member row) says nothing.
      internals.warnOnThinFencedCoverage(REF, 3, 2, 0, [], [], []);
      expect(seen.map(([c]) => c)).toEqual([
        "fenced-coverage-no-object-rows",
        "fenced-coverage-no-procedure-lines",
        "fenced-coverage-gap-beside-members",
      ]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("staging a compile names a leftover control copy and a dangling package link, once per session", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const root = await mkdtemp(join(tmpdir(), "lethal-r739-stage-"));
      roots.push(root);
      const cache = join(root, "cache");
      const instrumented = join(root, "instr");
      mkdirSync(cache, { recursive: true });
      mkdirSync(instrumented, { recursive: true });
      writeFileSync(join(instrumented, "app.json"), APP_JSON);
      writeFileSync(join(cache, "lethal-control.app"), "old");
      symlinkSync(join(root, "gone.app"), join(cache, "Gone.app"));
      const backend = new BcDevMcpBackend({ packageCachePath: cache } as never);
      const seen: Array<[string, string]> = [];
      backend.setNotify((c, m) => seen.push([c, m]));
      const internals = backend as unknown as Internals;
      await internals.stageForCompile(instrumented);
      await internals.stageForCompile(instrumented); // once per session
      expect(seen.map(([c]) => c).sort()).toEqual([
        "package-cache-dangling",
        "package-cache-leftover",
      ]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("R739: runSession restores the notifier on a throwing backend and a second session sees its notices", () => {
  test("two sessions on one notifying backend both get their notice events", async () => {
    const dirs = await project();
    const backend = new NotifyingBackend();
    const first: RunEvent[] = [];
    const second: RunEvent[] = [];
    await runSession({
      backend,
      store: new ResultsStore(":memory:"),
      ...dirs,
      selectorIds: SELECTOR_IDS,
      emit: [(e) => first.push(e)],
    });
    await runSession({
      backend,
      store: new ResultsStore(":memory:"),
      ...(await project()),
      selectorIds: SELECTOR_IDS,
      emit: [(e) => second.push(e)],
    });
    expect(noticesOf(first, "fake-notice")).toHaveLength(2);
    expect(noticesOf(second, "fake-notice")).toHaveLength(2);
  });
});
