import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import type { CompiledArtifact } from "../src/artifact";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import type { RunEvent } from "../src/events";
import { UnfilteredExtensionsQueryError } from "../src/harness";
import { generateMutationSet, runSession } from "../src/orchestrator";
import { renderConsole } from "../src/report";
import {
  ControlDrainTimeoutError,
  RunMutantTransport,
  drainPending,
  newControlState,
  takeLateRefusal,
} from "../src/run-mutant-transport";
import { ResultsStore } from "../src/store";
import { removeScratchDir } from "./helpers/scratch";

/**
 * R307 Task 8: what a run says about a refused file (plan sections 2 and 5).
 *
 * - Every file with sites refused: nothing is left to measure, so a plain `Error` (exit 1) names
 *   every refused file and its shape.
 * - One refused, one good: the run goes ahead, and the report says the score is narrowed: the
 *   `instrumentation-refused` row, the `files-refused` caveat, `reliability` `narrowed`, and the
 *   SCOPE line beside the score.
 */

const APP_JSON = JSON.stringify({
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  name: "T",
  publisher: "P",
  version: "1.0.0.0",
  idRanges: [{ from: 50000, to: 79999 }],
});

/** Sites: empty-block, remove-assignment, shift-integer. */
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

/** A codeunit and a page in one file: refused whole as `object-mix`, with 3 sites. */
const MIXED_AL = `codeunit 79302 "Mixed"
{
    procedure Q(): Boolean
    begin
        exit(true);
    end;
}

page 79303 "Mixed Page"
{
    PageType = Card;
    layout { area(Content) { } }
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

// Report paths are always "/"-separated (targetAlFiles normalises them), so never `join` these (R448).
const GOOD = "src/Good.Codeunit.al";
const MIXED = "src/Mixed.al";

/** Every test passes and covers `Good.Compute`, so every mutant survives. */
class SurviveBackend implements ExecutionBackend {
  private active: string | null = null;
  capabilities(): BackendCapabilities {
    return { coverage: "procedure", deploy: "publish", isolation: "session", authoritative: true };
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

const roots: string[] = [];
beforeAll(async () => {
  await initParser();
});
afterAll(() => {
  for (const r of roots) removeScratchDir(r);
});

async function project(files: Readonly<Record<string, string>>) {
  const root = await mkdtemp(join(tmpdir(), "lethal-r307-t8-"));
  roots.push(root);
  const projectDir = join(root, "app");
  const testDir = join(root, "tests");
  await Bun.write(join(projectDir, "app.json"), APP_JSON);
  for (const [rel, content] of Object.entries(files))
    await Bun.write(join(projectDir, rel), content);
  await Bun.write(join(testDir, "GoodTests.Codeunit.al"), TEST_AL);
  return { projectDir, testDir, instrumentedDir: join(root, "instr") };
}

describe("R307 T8: when every file with sites is refused", () => {
  test("a plain Error naming every refused file and its shape", async () => {
    const { projectDir } = await project({ [MIXED]: MIXED_AL });
    const err = await generateMutationSet(projectDir, { emit: () => {} }).then(
      () => undefined,
      (e: unknown) => e,
    );
    // A plain Error: the CLI prints its message and exits 1, like the empty `--lines` refusal.
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).constructor).toBe(Error);
    expect((err as Error).message).toBe(
      `nothing is left to measure: no file with mutation sites could be instrumented, and 1 file(s) were refused whole at instrumentation (R307): object-mix in ${MIXED}: an object that can carry the selector var shares the file with one that cannot; objects codeunit:79302 "Mixed", page:79303 "Mixed Page"`,
    );
  });
});

describe("R307 T8: one refused file beside a good one", () => {
  test("the run goes ahead, and the report and console say the score is narrowed", async () => {
    const dirs = await project({ [GOOD]: GOOD_AL, [MIXED]: MIXED_AL });
    const events: RunEvent[] = [];
    const report = await runSession({
      backend: new SurviveBackend(),
      store: new ResultsStore(":memory:"),
      ...dirs,
      selectorIds: { selectorId: 60000, controlId: 60001, tableId: 60002 },
      emit: [(e) => events.push(e)],
    });
    // Only the good file was measured.
    expect([...new Set(report.mutants.map((m) => m.file))]).toEqual([GOOD]);
    // The refused row reaches the report through the event stream (mutation-set-generated).
    expect(report.excludedSites?.files).toEqual([
      {
        file: MIXED,
        kinds: "codeunit_declaration, page_declaration",
        sites: 3,
        reason: "instrumentation-refused",
        detail: `object-mix in ${MIXED}: an object that can carry the selector var shares the file with one that cannot; objects codeunit:79302 "Mixed", page:79303 "Mixed Page"`,
      },
    ]);
    expect(report.validity.caveats).toContain("files-refused");
    expect(report.validity.reliability).toBe("narrowed");
    expect(report.validity.scoreDescribes).toBe(
      "3 scored mutant(s) in 2 .al file(s); 1 file(s) refused, 3 site(s) not mutated",
    );
    const scope = renderConsole(report)
      .split("\n")
      .filter((l) => l.startsWith("SCOPE: "));
    expect(scope).toEqual([
      "SCOPE: narrowed [files-refused] - 3 scored mutant(s) in 2 .al file(s); 1 file(s) refused, 3 site(s) not mutated",
    ]);
    const warned = events.flatMap((e) =>
      e.type === "warning" && e.code === "instrumentation-refused-files" ? [e.message] : [],
    );
    expect(warned).toEqual([
      `[lethal] refused 1 file(s) whole at instrumentation; they run unmutated and the score covers the other files only: ${MIXED} (object-mix, 3 site(s)).`,
    ]);
  });
});

/** Holds a refusal no call ever threw, as a transport does after a stop outlives its bound. */
class LateRefusalBackend extends SurviveBackend {
  /** Ordered calls: "deactivate" for each activate(null), "take" for takeLateRefusal. */
  calls: string[] = [];
  override async activate(id: string | null): Promise<void> {
    if (id === null) this.calls.push("deactivate");
    await super.activate(id);
  }
  takeLateRefusal(): UnfilteredExtensionsQueryError {
    this.calls.push("take");
    return new UnfilteredExtensionsQueryError("late refusal held at teardown");
  }
}

/** The session is already failing: its first `run` throws. */
class FailingLateRefusalBackend extends LateRefusalBackend {
  override async run(ref: TestMethodRef): Promise<TestVerdict> {
    throw new Error("earlier failure");
  }
}

describe("R-496: a refusal still pending at session teardown", () => {
  // Narrowest owner of teardown that is practical is a full runSession over a stub backend; the
  // lease release is not asserted (needs a lease config), it runs inside the same cleanup call.
  test("the session rejects with UnfilteredExtensionsQueryError, after the backend was deactivated", async () => {
    const dirs = await project({ [GOOD]: GOOD_AL });
    const backend = new LateRefusalBackend();
    const err = await runSession({
      backend,
      store: new ResultsStore(":memory:"),
      ...dirs,
      selectorIds: { selectorId: 60000, controlId: 60001, tableId: 60002 },
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UnfilteredExtensionsQueryError);
    expect((err as Error).message).toContain("late refusal held at teardown");
    // Teardown order: the teardown deactivation is the last thing before the refusal is taken.
    expect(backend.calls.slice(-2)).toEqual(["deactivate", "take"]);
    expect(backend.calls.filter((c) => c === "take")).toHaveLength(1);
  });

  test("a session already failing keeps its own error; the refusal goes to console.warn", async () => {
    const dirs = await project({ [GOOD]: GOOD_AL });
    const backend = new FailingLateRefusalBackend();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const err = await runSession({
        backend,
        store: new ResultsStore(":memory:"),
        ...dirs,
        selectorIds: { selectorId: 60000, controlId: 60001, tableId: 60002 },
      }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(UnfilteredExtensionsQueryError);
      expect((err as Error).message).toContain("earlier failure");
      expect(backend.calls).toContain("take");
      expect(warn.mock.calls.flat().join("\n")).toContain("late refusal held at teardown");
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * R499: a real `RunMutantTransport` against a scripted server. RunMutant answers a valid pass,
 * except while `mode.run` is "truncated": then its body is cut short, the call reads the answer
 * back, and that readback (GetOpAnswer) is DEAF until `refuse` is called. Such a call ends
 * `in-flight-unknown` (not scored) and leaves the readback in flight: an orphan.
 */
function orphanServer() {
  const mode = { run: "truncated" as "truncated" | "pass" };
  let refuseReadback: ((m: string) => void) | undefined;
  const wrap = (inner: Record<string, unknown>) => JSON.stringify({ value: JSON.stringify(inner) });
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    if (String(url).includes("_GetOpAnswer")) {
      return new Promise<Response>((_resolve, reject) => {
        refuseReadback = (m) => reject(new UnfilteredExtensionsQueryError(m));
      });
    }
    const b = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const body = wrap({
      status: "ran",
      testRunsBefore: 0,
      sessionId: 2037,
      targetAppId: b.targetAppId,
      artifactId: b.artifactId,
      attemptId: b.attemptId,
      mutantId: b.mutantId,
      codeunitId: b.testCodeunitId,
      method: b.testMethod,
      codeunitResults: JSON.stringify({ testResults: [{ method: b.testMethod, result: 2 }] }),
      observedActive: true,
    });
    if (mode.run === "pass") return new Response(body, { status: 200 });
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(body.slice(0, -1)));
        c.error(new Error("The socket connection was closed unexpectedly."));
      },
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;
  return {
    mode,
    fetchFn,
    refuse: (m: string) => {
      if (refuseReadback === undefined) throw new Error("no readback in flight");
      refuseReadback(m);
    },
  };
}

const TX_CFG = { baseUrl: "http://bc:7048/BC", company: "CRONUS", username: "u", password: "p" };
const TX_REQ = {
  ref: { codeunitId: 79400, codeunitName: "Good Tests", method: "ComputeWorks" },
  mutantId: "",
  attemptId: "a1",
  timeoutMs: 30,
  lease: { epoch: 1, token: "t", serverGeneration: "g", opSeq: 1 },
} as const;

/**
 * Its FIRST run leaves an orphan on a real transport sharing this backend's control state (a
 * non-scored call). With `scoreMutants`, every MUTANT run also sends a scored pass through that
 * transport first. Every run returns `SurviveBackend`'s verdict. Records teardown order in `calls`.
 */
class OrphanBackend extends SurviveBackend {
  calls: string[] = [];
  mutantRuns = 0;
  readonly state = newControlState();
  readonly server = orphanServer();
  readonly tx: RunMutantTransport;
  private orphaned = false;
  private current: string | null = null;
  constructor(
    drainMs: number,
    private readonly scoreMutants = false,
  ) {
    super();
    this.tx = new RunMutantTransport(TX_CFG, "app", "art", this.server.fetchFn, {
      controlState: this.state,
      drainMs,
    });
  }
  override async activate(id: string | null): Promise<void> {
    if (id === null) this.calls.push("deactivate");
    this.current = id;
    await super.activate(id);
  }
  override async run(ref: TestMethodRef): Promise<TestVerdict> {
    if (!this.orphaned) {
      this.orphaned = true;
      const v = await this.tx.run(TX_REQ);
      if (v.operation !== "in-flight-unknown") throw new Error("the orphaning call was scored");
    } else if (this.scoreMutants && this.current !== null) {
      this.mutantRuns += 1;
      this.server.mode.run = "pass";
      await this.tx.run({ ...TX_REQ, mutantId: this.current });
    }
    return super.run(ref);
  }
  /** Set to shorten the teardown's `CONTROL_DRAIN_MS` wait in a test whose orphan never settles. */
  teardownDrainMs: number | undefined;
  async drainControlRequests(ms: number): Promise<void> {
    this.calls.push("drain");
    await drainPending([this.state.orphans], this.teardownDrainMs ?? ms);
  }
  takeLateRefusal(): UnfilteredExtensionsQueryError | undefined {
    this.calls.push("take");
    return takeLateRefusal(this.state);
  }
}

describe("R499: control requests still in flight at the end of a session", () => {
  test("T1: an orphan refused during the teardown drain ends the session with UnfilteredExtensionsQueryError, after cleanup", async () => {
    const dirs = await project({ [GOOD]: GOOD_AL });
    const backend = new OrphanBackend(60_000);
    // The orphan refuses only once the teardown drain is waiting on it.
    const drain = backend.drainControlRequests.bind(backend);
    backend.drainControlRequests = async (ms) => {
      setTimeout(() => backend.server.refuse("refused during the teardown drain"), 20);
      await drain(ms);
    };
    const err = await runSession({
      backend,
      store: new ResultsStore(":memory:"),
      ...dirs,
      selectorIds: { selectorId: 60000, controlId: 60001, tableId: 60002 },
      emit: [
        (e) => {
          if (e.type === "phase-left" && e.phase === "teardown") backend.calls.push("phase-left");
        },
      ],
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UnfilteredExtensionsQueryError);
    expect((err as Error).message).toContain("refused during the teardown drain");
    expect(backend.calls.slice(-4)).toEqual(["deactivate", "drain", "phase-left", "take"]);
  });

  test("a scored call that hits the drain bound ends the session with ControlDrainTimeoutError and records NO verdict for its mutant", async () => {
    const dirs = await project({ [GOOD]: GOOD_AL });
    // The baseline run leaves the orphan; the first MUTANT run goes through the transport as a
    // scored pass and finds that orphan still in flight when its 30 ms bound runs out.
    const backend = new OrphanBackend(30, true);
    backend.teardownDrainMs = 30;
    const store = new ResultsStore(":memory:");
    const err = await runSession({
      backend,
      store,
      ...dirs,
      selectorIds: { selectorId: 60000, controlId: 60001, tableId: 60002 },
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ControlDrainTimeoutError);
    expect((err as Error).message).toContain("GetOpAnswer");
    expect(backend.mutantRuns).toBe(1);
    const count = (sql: string) => (store.db.query(sql).get() as { n: number }).n;
    expect(count("SELECT COUNT(*) AS n FROM mutants")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM test_results WHERE mutant_code IS NOT NULL")).toBe(0);
  });
});
