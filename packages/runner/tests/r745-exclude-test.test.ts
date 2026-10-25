// R745: `--exclude-test <Codeunit.Method>` leaves single test METHODS out of a run. Every direction
// is pinned by a test that goes red when that direction is reverted (see the plan's red checks).
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
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
import { FLAG_OWNERS, parseCliConfig } from "../src/cli";
import type { RunEvent } from "../src/events";
import { type SessionConfig, runSession } from "../src/orchestrator";
import { CAVEAT_INTERPRETATIONS, type SessionReport, renderConsole } from "../src/report";
import { sessionFingerprint } from "../src/resume";
import { ResultsStore } from "../src/store";
import { servesTestApp } from "./helpers/proven-test-app";
import { removeScratchDirs } from "./helpers/scratch";

const TARGET_AL = `codeunit 79000 "Sandbox Logic"
{
    procedure IsOverBudget(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount > Budget);
    end;
}
`;
const TESTS_AL = `codeunit 79100 "Excl Tests"
{
    Subtype = Test;

    [Test]
    procedure Killer()
    begin
    end;

    [Test]
    procedure Other()
    begin
    end;
}
`;
const OTHER_FILE_AL = `codeunit 79101 "Side Tests"
{
    Subtype = Test;

    [Test]
    procedure Side()
    begin
    end;
}
`;
const APP_JSON = JSON.stringify({
  id: "6d0f4a2e-1c3b-4a8d-9f10-2b7c5e4d3a92",
  name: "Sandbox R745 Fixture",
  publisher: "LethAL",
  version: "1.0.0.0",
  idRanges: [{ from: 79000, to: 79199 }],
});
const TEST_APP_JSON = JSON.stringify({
  id: "11111111-2222-3333-4444-555555555556",
  name: "t",
  publisher: "x",
  version: "1.0.0.0",
});

/** bcdev shape. `Killer` fails under any mutant; every call is recorded. */
class Stub implements ExecutionBackend {
  /** Every call: the active mutant (null = baseline), the codeunit and the method. */
  readonly calls: { active: string | null; cu: string; method: string }[] = [];
  deploys = 0;
  statusCalls = 0;
  private active: string | null = null;
  constructor(
    private readonly kind: "bcdev" | "al-runner-v3",
    private readonly covers: ReadonlySet<string> = new Set(["Killer", "Other"]),
  ) {
    if (kind === "bcdev") Object.assign(this, servesTestApp());
  }
  capabilities(): BackendCapabilities {
    return {
      coverage: "procedure",
      deploy: "publish",
      isolation: "session",
      kind: this.kind,
      authoritative: this.kind === "bcdev",
    };
  }
  async status(): Promise<BackendStatus> {
    this.statusCalls += 1;
    return { ok: true, details: "stub" };
  }
  async runnerBuild(): Promise<{ version: string; binarySha256: string }> {
    return { version: "al-runner 3.0.0-test", binarySha256: "b".repeat(64) };
  }
  async deploy(): Promise<null> {
    this.deploys += 1;
    return null;
  }
  async compileCheck(): Promise<void> {}
  async activate(id: string | null): Promise<void> {
    this.active = id;
  }
  async run(ref: TestMethodRef): Promise<TestVerdict> {
    this.calls.push({ active: this.active, cu: ref.codeunitName, method: ref.method });
    if (this.active === null) {
      return {
        ref,
        outcome: "pass",
        durationMs: 5,
        ...(this.covers.has(ref.method)
          ? {
              coverage: {
                granularity: "procedure" as const,
                entries: [{ objectType: "Codeunit", objectId: 79000, procedure: "IsOverBudget" }],
              },
            }
          : {}),
      };
    }
    const kills = ref.method === "Killer";
    return {
      ref,
      outcome: kills ? "fail" : "pass",
      durationMs: 5,
      ...(kills ? { failureMessage: "Assert.AreEqual failed" } : {}),
      attestation: { observedAny: true, identityMismatch: false },
    };
  }
}

beforeAll(async () => {
  await initParser();
});
const roots: string[] = [];
afterEach(() => {
  removeScratchDirs(roots.splice(0));
});

async function project(withSide = false) {
  const root = mkdtempSync(join(tmpdir(), "lethal-r745-"));
  roots.push(root);
  await Bun.write(join(root, "app", "SandboxLogic.Codeunit.al"), TARGET_AL);
  await Bun.write(join(root, "app", "app.json"), APP_JSON);
  await Bun.write(join(root, "tests", "ExclTests.Codeunit.al"), TESTS_AL);
  if (withSide)
    await Bun.write(join(root, "tests", "Side", "SideTests.Codeunit.al"), OTHER_FILE_AL);
  await Bun.write(join(root, "tests", "app.json"), TEST_APP_JSON);
  return root;
}

let n = 0;
const session = (
  root: string,
  store: ResultsStore,
  backend: Stub,
  extra: Partial<SessionConfig> = {},
  events: RunEvent[] = [],
): Promise<SessionReport> =>
  runSession({
    backend,
    store,
    projectDir: join(root, "app"),
    testDir: join(root, "tests"),
    instrumentedDir: join(root, `instr-${++n}`),
    selectorIds: { selectorId: 50147, controlId: 50148, tableId: 50149 },
    emit: [(e) => events.push(e)],
    ...extra,
  });

describe("R745 T1: an excluded test never runs and is named", () => {
  test("control, no flag: Killer kills the mutants", async () => {
    const root = await project();
    const r = await session(root, new ResultsStore(":memory:"), new Stub("bcdev"));
    expect(r.counts.killed).toBeGreaterThan(0);
    expect(r.counts.survived).toBe(0);
    expect(r.mutants.every((m) => m.killingTest === "Killer")).toBe(true);
    expect(r.excludedTests ?? []).toEqual([]);
    expect(r.validity.caveats).not.toContain("tests-narrowed");
  });

  test("excluded: zero calls name Killer, mutants survive, the record, caveat and reliability say so", async () => {
    const root = await project();
    const backend = new Stub("bcdev");
    const events: RunEvent[] = [];
    const r = await session(
      root,
      new ResultsStore(":memory:"),
      backend,
      { excludeTests: ["Excl Tests.Killer"] },
      events,
    );
    expect(backend.calls.filter((c) => c.method === "Killer")).toEqual([]);
    expect(backend.calls.length).toBeGreaterThan(0);
    expect(r.counts.killed).toBe(0);
    expect(r.counts.survived).toBeGreaterThan(0);
    expect(r.excludedTests).toEqual([
      { test: "Excl Tests.Killer", file: "ExclTests.Codeunit.al", reason: "exclude-test" },
    ]);
    expect(r.validity.caveats).toContain("tests-narrowed");
    expect(r.validity.reliability).toBe("narrowed");
    const banner = renderConsole(r);
    expect(banner).toContain("TESTS EXCLUDED: 1 test(s)");
    expect(banner).toContain("Excl Tests.Killer");
    const w = events.find(
      (e) => e.type === "warning" && e.code === "exclude-test-narrowed-baseline",
    );
    expect(w).toBeDefined();
    expect(JSON.stringify(w)).toContain("Excl Tests.Killer");
  });

  test("T1b: the only covering test excluded -> no-coverage", async () => {
    const root = await project();
    const backend = new Stub("bcdev", new Set(["Killer"]));
    const r = await session(root, new ResultsStore(":memory:"), backend, {
      excludeTests: ["Excl Tests.Killer"],
    });
    expect(r.counts.noCoverage).toBeGreaterThan(0);
    expect(r.counts.killed).toBe(0);
  });
});

describe("R745 T2: names", () => {
  test("an unknown name is refused, naming only it, before any deploy", async () => {
    const root = await project();
    const backend = new Stub("bcdev");
    let err: unknown;
    try {
      await session(root, new ResultsStore(":memory:"), backend, {
        excludeTests: ["Excl Tests.Killer", "Excl Tests.Nope"],
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain("Excl Tests.Nope");
    expect(msg).not.toContain('"Excl Tests.Killer"');
    expect(backend.deploys).toBe(0);
    expect(backend.calls).toEqual([]);
  });

  test("T2b: case and quotes are ignored; the record uses the discovered spelling", async () => {
    const root = await project();
    const r = await session(root, new ResultsStore(":memory:"), new Stub("bcdev"), {
      excludeTests: ['"excl tests".KILLER'],
    });
    expect(r.excludedTests?.map((t) => t.test)).toEqual(["Excl Tests.Killer"]);
  });

  test("T2c: a name that exists only outside --tests-only is refused", async () => {
    const root = await project(true);
    await expect(
      session(root, new ResultsStore(":memory:"), new Stub("bcdev"), {
        testsOnly: ["Side/**"],
        excludeTests: ["Excl Tests.Killer"],
      }),
    ).rejects.toThrow(/Excl Tests\.Killer/);
  });

  test("excluding every test is its own refusal", async () => {
    const root = await project();
    await expect(
      session(root, new ResultsStore(":memory:"), new Stub("bcdev"), {
        excludeTests: ["Excl Tests.Killer", "Excl Tests.Other"],
      }),
    ).rejects.toThrow(/every test in this run's suite was excluded by --exclude-test/);
  });
});

describe("R745 T3: fingerprint", () => {
  const base = {
    projectDir: "p",
    testDir: "t",
    backend: "bcdev",
    skipKnownSurvivors: false,
    identityScheme: 1,
    selectorIds: { selectorId: 1, controlId: 2, tableId: 3 },
  };
  test("unchanged for an empty set, different for a set, order-free", () => {
    const none = sessionFingerprint(base);
    expect(sessionFingerprint({ ...base, excludeTests: [] })).toBe(none);
    const ab = sessionFingerprint({ ...base, excludeTests: ["a", "b"] });
    expect(ab).not.toBe(none);
    expect(sessionFingerprint({ ...base, excludeTests: ["b", "a"] })).toBe(ab);
  });
});

describe("R745 T4: resume", () => {
  test("a different exclusion set is not resumable", async () => {
    const root = await project();
    const store = new ResultsStore(":memory:");
    await session(root, store, new Stub("bcdev"), { excludeTests: ["Excl Tests.Killer"] });
    store.db.run("UPDATE runs SET finished_at = NULL WHERE id = 1");
    await expect(session(root, store, new Stub("bcdev"), { resume: 1 })).rejects.toThrow(
      /--resume-run 1 was scoped differently/,
    );
  });
});

describe("R745 T5: history lend", () => {
  const warns = (ev: RunEvent[]) =>
    ev.flatMap((e) => (e.type === "warning" && e.code.startsWith("history-") ? [e.code] : []));
  test("an exclusion run's survivors are not lent to a full run", async () => {
    const root = await project();
    const store = new ResultsStore(":memory:");
    const r1 = await session(root, store, new Stub("bcdev"), {
      excludeTests: ["Excl Tests.Killer"],
    });
    expect(r1.counts.survived).toBeGreaterThan(0);
    const ev: RunEvent[] = [];
    const r2 = await session(root, store, new Stub("bcdev"), { skipKnownSurvivors: true }, ev);
    expect(r2.mutants.filter((m) => m.verdict === "known-survivor")).toEqual([]);
    expect(r2.counts.killed).toBe(r1.counts.survived);
    expect(warns(ev)).toEqual(["history-test-scope-changed"]);
  });
  test("a full run's survivors are lent to an exclusion run", async () => {
    const root = await project();
    const store = new ResultsStore(":memory:");
    // The full run's survivors need Killer not to kill: it covers nothing here.
    const r1 = await session(root, store, new Stub("bcdev", new Set(["Other"])));
    expect(r1.counts.survived).toBeGreaterThan(0);
    const ev: RunEvent[] = [];
    const r2 = await session(
      root,
      store,
      new Stub("bcdev", new Set(["Other"])),
      { skipKnownSurvivors: true, excludeTests: ["Excl Tests.Killer"] },
      ev,
    );
    expect(r2.mutants.filter((m) => m.verdict === "known-survivor")).toHaveLength(
      r1.counts.survived,
    );
    expect(warns(ev)).toEqual([]);
  });
});

describe("R745 T6: al-runner-v3 refuses, with the reason", () => {
  test("refused before status(), naming why", async () => {
    const root = await project();
    const backend = new Stub("al-runner-v3");
    let err: unknown;
    try {
      await session(root, new ResultsStore(":memory:"), backend, {
        excludeTests: ["Excl Tests.Killer"],
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain("--exclude-test");
    expect(msg).toContain("al-runner-v3 runs whole codeunits");
    expect(msg).toContain("would still run");
    expect(backend.statusCalls).toBe(0);
  });
});

describe("R745 T7: cli", () => {
  const ARGS = ["run", "--project", "p", "--tests", "t", "--backend", "bcdev"];
  test("repeatable, and carried", () => {
    const cfg = parseCliConfig([...ARGS, "--exclude-test", "A.B", "--exclude-test", "C.D"]);
    expect(cfg.mode === "run" ? cfg.excludeTests : undefined).toEqual(["A.B", "C.D"]);
  });
  test("an empty value is refused", () => {
    expect(() => parseCliConfig([...ARGS, "--exclude-test", ""])).toThrow(
      /--exclude-test requires a non-empty/,
    );
  });
  test("--dry-run refuses it", () => {
    expect(() => parseCliConfig([...ARGS, "--dry-run", "--exclude-test", "A.B"])).toThrow(
      /--exclude-test has no effect with --dry-run/,
    );
  });
  test("campaign and verify refuse it by name (run owns it)", () => {
    const row = FLAG_OWNERS.find((r) => r.flag === "exclude-test");
    expect(row?.owners).toEqual(["run"]);
  });
});

describe("R745: the tests-narrowed interpretation covers excluded methods", () => {
  test("names --exclude-test and excludedTests", () => {
    const m = CAVEAT_INTERPRETATIONS["tests-narrowed"].meaning;
    expect(m).toContain("--exclude-test");
    expect(m).toContain("excludedTests");
  });
});

// R759: the run records what it was narrowed by, so `lethal verify` can tell a test the run left
// out from a new one. A run with no narrowing records empty lists (NULL means "before R759").
describe("R759 T7: runSession records the narrowing", () => {
  const narrowingOf = (store: ResultsStore) => store.getRun(1)?.testNarrowing;
  test("no flags: empty lists", async () => {
    const root = await project();
    const store = new ResultsStore(":memory:");
    await session(root, store, new Stub("bcdev"));
    expect(narrowingOf(store)).toEqual({ testsOnly: [], excludeTests: [] });
  });
  test("--exclude-test: the testKeyOf of the test left out", async () => {
    const root = await project();
    const store = new ResultsStore(":memory:");
    await session(root, store, new Stub("bcdev"), { excludeTests: ["Excl Tests.Killer"] });
    expect(narrowingOf(store)).toEqual({ testsOnly: [], excludeTests: ["79100::Killer"] });
  });
  test("--tests-only: the globs", async () => {
    const root = await project(true);
    const store = new ResultsStore(":memory:");
    await session(root, store, new Stub("bcdev"), { testsOnly: ["Side/**"] });
    expect(narrowingOf(store)).toEqual({ testsOnly: ["Side/**"], excludeTests: [] });
  });
});
