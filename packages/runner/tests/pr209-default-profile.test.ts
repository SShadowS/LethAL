import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompiledArtifact } from "../src/artifact";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  RunOpts,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import { parseCliConfig } from "../src/cli";
import { SLIM_LEFT_OUT, runSession } from "../src/orchestrator";
import { ResultsStore } from "../src/store";
import { servesTestApp, testAppJson } from "./helpers/proven-test-app";
import { removeRunScratchAfterAll } from "./helpers/scratch";

removeRunScratchAfterAll();

/**
 * PR-209 (M6). A default run now holds `condition-true` and `blank-argument`, so a store an OLDER
 * default run wrote cannot be resumed by it, and says so by name. `--profile slim` is the older
 * set and keeps the older digest, so it resumes that store.
 *
 * The older store is made here by a slim run: slim carries no `operators` key and no marker, which
 * is exactly the digest an older default run recorded.
 */
// As bcdev with a served, installed test app (R495), so the run's identity is proven and resumable.
const CAPS: BackendCapabilities = {
  coverage: "procedure",
  deploy: "publish",
  isolation: "session",
  kind: "bcdev",
  authoritative: true,
};

const APP_JSON = JSON.stringify({
  id: "0f2b7c5e-4d3a-4917-8a1c-3b4a8d9f1027",
  name: "Profile Fixture",
  publisher: "LethAL",
  version: "1.0.0.0",
  idRanges: [{ from: 79000, to: 79199 }],
});

const TARGET_AL = `codeunit 79000 "Sandbox Logic"
{
    procedure Check(Amount: Decimal; Flag: Boolean): Boolean
    var
        N: Integer;
    begin
        if Flag then
            N := 1;
        exit(Amount > N);
    end;
}
`;

const TEST_AL = `codeunit 79100 "Sandbox Tests"
{
    Subtype = Test;

    [Test]
    procedure CheckWorks()
    begin
    end;
}
`;

class StubBackend implements ExecutionBackend {
  constructor() {
    Object.assign(this, servesTestApp());
  }
  async runnerBuild(): Promise<{ version: string; binarySha256: string }> {
    return { version: "alrunner 3.0.0-alpha.2 (91253f2d6)", binarySha256: "b".repeat(64) };
  }
  private activations: Array<string | null> = [];
  capabilities(): BackendCapabilities {
    return CAPS;
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "stub" };
  }
  async deploy(): Promise<CompiledArtifact | null> {
    return null;
  }
  async compileCheck(): Promise<void> {}
  async activate(id: string | null): Promise<void> {
    this.activations.push(id);
  }
  async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
    const active = this.activations.at(-1) ?? null;
    return {
      ref,
      outcome: "pass",
      durationMs: 5,
      ...(active === null
        ? {
            coverage: {
              granularity: "procedure" as const,
              entries: [{ objectType: "Codeunit", objectId: 79000, procedure: "Check" }],
            },
          }
        : {}),
      ...(opts.coverage === "none"
        ? { attestation: { observedAny: true, identityMismatch: false } }
        : {}),
    };
  }
}

const SLIM = { excludeOperators: [...SLIM_LEFT_OUT], profile: "slim" as const };

async function inProject<T>(body: (root: string, store: ResultsStore) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "lethal-pr209-profile-"));
  await Bun.write(join(root, "app", "SandboxLogic.Codeunit.al"), TARGET_AL);
  await Bun.write(join(root, "app", "app.json"), APP_JSON);
  await Bun.write(join(root, "tests", "SandboxTests.Codeunit.al"), TEST_AL);
  await Bun.write(join(root, "tests", "app.json"), testAppJson());
  const store = new ResultsStore(":memory:");
  try {
    return await body(root, store);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

const session = (
  root: string,
  store: ResultsStore,
  extra: Record<string, unknown> = {},
  instr = "instr",
) =>
  runSession({
    backend: new StubBackend(),
    store,
    projectDir: join(root, "app"),
    testDir: join(root, "tests"),
    instrumentedDir: join(root, instr),
    selectorIds: { selectorId: 50000, controlId: 50001, tableId: 50002 },
    ...extra,
  });

describe("PR-209: the default set holds both operators", () => {
  test("a default run's mutants include condition-true; slim's do not, and it is flagged", async () => {
    await inProject(async (root, store) => {
      const full = await session(root, store);
      const slim = await session(root, store, SLIM, "instr-slim");
      const names = (r: { mutants: readonly { operatorName: string }[] }) =>
        new Set(r.mutants.map((m) => m.operatorName));
      expect(names(full).has("lethal.condition-true")).toBe(true);
      expect(names(slim).has("lethal.condition-true")).toBe(false);
      expect(names(slim).has("lethal.blank-argument")).toBe(false);
      // Slim is the default run minus exactly those two operators.
      expect(slim.mutants.length).toBe(
        full.mutants.filter((m) => !SLIM_LEFT_OUT.includes(m.operatorName)).length,
      );
      expect(full.validity.caveats).not.toContain("operator-narrowed");
      expect(slim.validity.caveats).toContain("operator-narrowed");
      expect(slim.operators?.names).not.toContain("lethal.condition-true");
      expect(slim.operators?.names).not.toContain("lethal.blank-argument");
    });
  }, 120_000);
});

describe("PR-209 M6: an older store and the two profiles", () => {
  test("a default resume of an older store refuses by name and points to --profile slim", async () => {
    await inProject(async (root, store) => {
      await session(root, store, SLIM); // the older default set: run 1
      store.db.run("UPDATE runs SET finished_at = NULL WHERE id = 1");
      const byId = session(root, store, { resume: 1 }, "instr-a");
      await expect(byId).rejects.toThrow("--profile slim");
      await expect(byId).rejects.toThrow("PR-209");
      const last = session(root, store, { resume: "last" }, "instr-b");
      await expect(last).rejects.toThrow("--profile slim");
    });
  }, 120_000);

  test("a slim resume of the same store proceeds", async () => {
    await inProject(async (root, store) => {
      await session(root, store, SLIM);
      store.db.run("UPDATE runs SET finished_at = NULL WHERE id = 1");
      const resumed = await session(root, store, { ...SLIM, resume: 1 }, "instr-c");
      expect(resumed.resumedFrom?.runId).toBe(1);
    });
  }, 120_000);

  test("a default run's own store resumes under the default (the marker is stable)", async () => {
    await inProject(async (root, store) => {
      await session(root, store);
      store.db.run("UPDATE runs SET finished_at = NULL WHERE id = 1");
      const resumed = await session(root, store, { resume: 1 }, "instr-d");
      expect(resumed.resumedFrom?.runId).toBe(1);
      // And slim cannot resume a default store: different mutant sets.
      store.db.run("UPDATE runs SET finished_at = NULL WHERE id = 1");
      await expect(session(root, store, { ...SLIM, resume: 1 }, "instr-e")).rejects.toThrow(
        "scoped differently",
      );
    });
  }, 120_000);
});

describe("PR-209: --profile on the command line", () => {
  // bcdev, as cli.test.ts does: --profile is backend-neutral, and al-runner-v3 is refused on Windows (R586 v1), where
  // CI's check job runs.
  const base = ["run", "--project", "p", "--tests", "t", "--backend", "bcdev"];

  test("slim excludes exactly the two and says so", () => {
    const parsed = parseCliConfig([...base, "--profile", "slim"]);
    if (parsed.mode !== "run") throw new Error("mode drift");
    expect(parsed.profile).toBe("slim");
    expect([...(parsed.excludeOperators ?? [])].sort()).toEqual([...SLIM_LEFT_OUT].sort());
  });

  test("slim adds to --exclude-operator", () => {
    const parsed = parseCliConfig([
      ...base,
      "--profile",
      "slim",
      "--exclude-operator",
      "empty-block",
    ]);
    if (parsed.mode !== "run") throw new Error("mode drift");
    expect(parsed.excludeOperators).toEqual([...SLIM_LEFT_OUT, "empty-block"]);
  });

  test("no profile: no exclusion, no profile field", () => {
    const parsed = parseCliConfig(base);
    if (parsed.mode !== "run") throw new Error("mode drift");
    expect(parsed.profile).toBeUndefined();
    expect(parsed.excludeOperators).toBeUndefined();
  });

  test("slim with --operator is refused by name", () => {
    expect(() =>
      parseCliConfig([...base, "--profile", "slim", "--operator", "empty-block"]),
    ).toThrow("--profile and --operator cannot be combined");
  });

  test("an unknown profile is refused by name", () => {
    expect(() => parseCliConfig([...base, "--profile", "fat"])).toThrow(
      '--profile "fat" is not a known profile',
    );
  });

  test("the dry run takes it too", () => {
    const parsed = parseCliConfig([...base, "--dry-run", "--profile", "slim"]);
    if (parsed.mode !== "dry-run") throw new Error("mode drift");
    expect(parsed.profile).toBe("slim");
  });
});
