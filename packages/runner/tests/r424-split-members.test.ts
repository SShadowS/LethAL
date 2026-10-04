import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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
import type { RunEvent } from "../src/events";
import { type SessionConfig, runSession } from "../src/orchestrator";
import {
  AL_RUNNER_PREDEFINED_SYMBOLS_V2_12_0,
  type AlRunnerPredefinedProbe,
} from "../src/preprocessor-symbols";
import { ResultsStore } from "../src/store";
import { analyzeTestPageSources } from "../src/testpage-scan";

/**
 * R424: a procedure whose HEADER is split by `#if` (one header per arm, one shared body) is one
 * `preproc_split_procedure` node in tree-sitter-al 4.4.1. Measured shapes and compiled method lists:
 * plan `docs/superpowers/plans/2026-10-04-R-424-split-procedure-tests.md` §1.
 */

beforeAll(async () => {
  await initParser();
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

// ————————————————————————————————————————————————————————————————————————
// Before and after (plan r2 §5): a test that opens a TestPage ONLY through a split helper.
// ————————————————————————————————————————————————————————————————————————

/** The helper's header is split the common way (a modifier changes under a CLEAN symbol); its
 *  body opens a TestPage. The test reaches the TestPage only through it. */
const HELPER_OPENS = `codeunit 92490 "R424 Helper Opens"
{
    Subtype = Test;

    [Test]
    procedure OpensThroughHelper()
    begin
        OpenIt();
    end;

#if CLEAN25
    local procedure OpenIt()
#else
    procedure OpenIt()
#endif
    var
        P: TestPage "Customer Card";
    begin
        P.OpenView();
    end;
}
`;

const HELPER_TEST: TestMethodRef = {
  codeunitId: 92490,
  codeunitName: "R424 Helper Opens",
  method: "OpensThroughHelper",
  file: "HelperOpens.Codeunit.al",
};

const TARGET_AL = `codeunit 50013 "R424 Target"
{
    procedure Run(X: Integer)
    begin
        Helper(X);
    end;

    local procedure Helper(V: Integer)
    begin
    end;
}
`;
const PLAIN_AL = `codeunit 92480 "R424 Plain"
{
    Subtype = Test;

    [Test]
    procedure PlainTest()
    begin
    end;
}
`;

class StubBackend implements ExecutionBackend {
  private active: string | null = null;
  readonly baselineMethods: string[] = [];
  constructor(private readonly authoritative: boolean) {}
  capabilities(): BackendCapabilities {
    return {
      coverage: "procedure",
      deploy: "publish",
      isolation: "session",
      authoritative: this.authoritative,
    };
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "stub" };
  }
  measurePredefinedSymbols(): Promise<AlRunnerPredefinedProbe> {
    return Promise.resolve({ symbols: [...AL_RUNNER_PREDEFINED_SYMBOLS_V2_12_0].sort() });
  }
  async deploy(): Promise<null> {
    return null;
  }
  async compileCheck(): Promise<void> {}
  async activate(id: string | null): Promise<void> {
    this.active = id;
  }
  async run(ref: TestMethodRef): Promise<TestVerdict> {
    if (this.active === null) this.baselineMethods.push(ref.method);
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

/** A project whose test app holds `PLAIN_AL` plus `files`. */
async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lethal-r424-run-"));
  roots.push(root);
  const appJson = (name: string) =>
    JSON.stringify({
      id: "11111111-2222-3333-4444-555555555555",
      name,
      publisher: "x",
      version: "1.0.0.0",
    });
  await Bun.write(join(root, "app", "app.json"), appJson("p"));
  await Bun.write(join(root, "app", "src", "Target.Codeunit.al"), TARGET_AL);
  await Bun.write(join(root, "tests", "app.json"), appJson("t"));
  await Bun.write(join(root, "tests", "Plain.Codeunit.al"), PLAIN_AL);
  for (const [name, text] of Object.entries(files))
    await Bun.write(join(root, "tests", name), text);
  return root;
}

let sessions = 0;
const session = (
  root: string,
  store: ResultsStore,
  backend: StubBackend,
  extra: Partial<SessionConfig> = {},
) =>
  runSession({
    backend,
    store,
    projectDir: join(root, "app"),
    testDir: join(root, "tests"),
    instrumentedDir: join(root, `instr-${++sessions}`),
    selectorIds: { selectorId: 50147, controlId: 50148, tableId: 50149 },
    ...extra,
  });

describe("R424 before: a TestPage opened only through a split helper is not seen", () => {
  test("the scan gives the test no TestPage reason and no error", () => {
    const got = analyzeTestPageSources(
      [{ path: HELPER_TEST.file ?? "", text: HELPER_OPENS }],
      [HELPER_TEST],
    );
    expect(got.errors).toEqual([]);
    expect([...got.refused]).toEqual([]);
  });

  test("on bcdev the test is not refused: it is sent to the baseline", async () => {
    const root = await project({ "HelperOpens.Codeunit.al": HELPER_OPENS });
    const events: RunEvent[] = [];
    const backend = new StubBackend(true);
    await session(root, new ResultsStore(":memory:"), backend, {
      emit: [(e) => events.push(e)],
    });
    expect(events.filter((e) => e.type === "tests-testpage-refused")).toEqual([]);
    expect([...new Set(backend.baselineMethods)].sort()).toEqual([
      "OpensThroughHelper",
      "PlainTest",
    ]);
  });
});
