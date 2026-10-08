import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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
import { ResultsStore } from "../src/store";

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
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
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
