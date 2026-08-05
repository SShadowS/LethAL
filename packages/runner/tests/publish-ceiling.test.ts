import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dedupeSpecs } from "@lethal/schemata";
import type { TierResolver } from "@lethal/schemata";
import type { CompiledArtifact } from "../src/artifact";
import { DeploymentError } from "../src/artifact";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  RunOpts,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import { PublishFailedError } from "../src/bcdev-backend";
import { helpText, parseCliConfig, printDryRun } from "../src/cli";
import { DeploymentVerifier, decidePublishOutcome } from "../src/deployment-verifier";
import { generateMutationSet, operatorTiers, runSession } from "../src/orchestrator";
import {
  assertUnderCeiling,
  clearCeilingCommand,
  clearPublishCeiling,
  guardsPerFile,
  knownCeiling,
  recordPublishOutcome,
} from "../src/publish-ceiling";
import { ResultsStore } from "../src/store";

// ————————————————————————————————————————————————————————————————————————
// Step 1/2 — the pure refusal rule (the brief's own four tests, verbatim).
// ————————————————————————————————————————————————————————————————————————

describe("publish ceiling (R90)", () => {
  test("with no history, nothing is refused — a fresh topology eats one honest failure", () => {
    expect(() =>
      assertUnderCeiling({ file: "X.al", guardCount: 9_999, ceiling: {} }),
    ).not.toThrow();
  });

  test("refuses a file at or above the smallest recorded failure", () => {
    expect(() =>
      assertUnderCeiling({
        file: "Big.al",
        guardCount: 660,
        ceiling: { smallestFailure: 331, largestSuccess: 229 },
      }),
    ).toThrow(/Big\.al/);
  });

  test("the refusal states the bracket as MEASUREMENT, never as law", () => {
    try {
      assertUnderCeiling({
        file: "Big.al",
        guardCount: 660,
        ceiling: { smallestFailure: 331, largestSuccess: 229 },
      });
      throw new Error("should have thrown");
    } catch (err) {
      const m = String((err as Error).message);
      expect(m).toContain("331");
      expect(m).toContain("229");
      expect(m).toMatch(/measured|observed|recorded/i);
    }
  });

  test("refuses at EXACTLY the smallest recorded failure, and allows one guard below it", () => {
    // Fix round 1, Minor 3: the brief's four cases use 660 against 331 — a margin wide enough that
    // `>` and `>=` are indistinguishable, so the boundary itself was pinned only by the expensive
    // end-to-end test. These two lines pin it here, where the rule lives.
    const ceiling = { smallestFailure: 331, largestSuccess: 229 };
    expect(() => assertUnderCeiling({ file: "Exact.al", guardCount: 331, ceiling })).toThrow(
      /Exact\.al/,
    );
    expect(() => assertUnderCeiling({ file: "Exact.al", guardCount: 330, ceiling })).not.toThrow();
  });

  test("allows a file below the largest recorded success", () => {
    expect(() =>
      assertUnderCeiling({
        file: "Small.al",
        guardCount: 176,
        ceiling: { smallestFailure: 331, largestSuccess: 229 },
      }),
    ).not.toThrow();
  });
});

describe("publish ceiling — the refusal message names the levers, not a law", () => {
  test("names the file, its guard count, the date the failure was observed, and both levers", () => {
    const err = (() => {
      try {
        assertUnderCeiling({
          file: "Big.Codeunit.al",
          guardCount: 660,
          ceiling: {
            smallestFailure: 331,
            largestSuccess: 229,
            failureObservedOn: "2026-08-05",
          },
        });
        return undefined;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(Error);
    const m = String(err?.message);
    expect(m).toContain("Big.Codeunit.al");
    expect(m).toContain("660");
    expect(m).toContain("2026-08-05");
    // The levers, both of them: exclude the file, or split it.
    expect(m).toContain("--only");
    expect(m).toMatch(/split/i);
    // Never phrased as law.
    expect(m).not.toMatch(/the limit is/i);
  });

  test("names the THIRD lever — how to discard the measurement — even with no command to pre-fill", () => {
    // Fix round 1: `--only` and "split the file" both assume the measurement is right. The ceiling
    // is a ratchet (min over `failed` rows, and a refused file can never publish to widen it back),
    // and ANY throw out of the publish call records a failure — a Bun spawn ENOENT is a measured
    // instance (R65). A refusal that does not say how to undo a bogus measurement leaves sqlite
    // surgery as the only way out.
    const bare = (() => {
      try {
        assertUnderCeiling({
          file: "Big.al",
          guardCount: 660,
          ceiling: { smallestFailure: 331 },
        });
        return "";
      } catch (e) {
        return String((e as Error).message);
      }
    })();
    expect(bare).toContain("lethal clear-ceiling");
    expect(bare).toMatch(/transient/i);

    const withCommand = (() => {
      try {
        assertUnderCeiling({
          file: "Big.al",
          guardCount: 660,
          ceiling: { smallestFailure: 331 },
          clearCommand: clearCeilingCommand({
            projectDir: "C:/app",
            server: "http://cronus281",
            serverInstance: "BC",
            file: "Big.al",
          }),
        });
        return "";
      } catch (e) {
        return String((e as Error).message);
      }
    })();
    // Copy-pasteable, not a command name to go look up.
    expect(withCommand).toContain(
      'lethal clear-ceiling --project "C:/app" --server "http://cronus281" --instance "BC" --file "Big.al"',
    );
  });
});

// ————————————————————————————————————————————————————————————————————————
// Step 3 — persistence. The authorized deviation from the brief: the stored
// value is the outcome CATEGORY, not a boolean, and only `failed` counts.
// ————————————————————————————————————————————————————————————————————————

describe("knownCeiling — only a demonstrated `failed` publish moves the ceiling", () => {
  test("a `failed` row sets smallestFailure; an `accepted` row sets largestSuccess", () => {
    const store = new ResultsStore(":memory:");
    try {
      recordPublishOutcome(store, "tier-a", 229, "accepted", "Small.al");
      recordPublishOutcome(store, "tier-a", 331, "failed", "Big.al");
      recordPublishOutcome(store, "tier-a", 660, "failed", "Huge.al");
      const ceiling = knownCeiling(store, "tier-a");
      expect(ceiling.smallestFailure).toBe(331);
      expect(ceiling.largestSuccess).toBe(229);
      expect(ceiling.failureObservedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    } finally {
      store.close();
    }
  });

  test("an `indeterminate` row NEVER moves the ceiling — R107's blindness must not become a refusal", () => {
    // R90's own measured reproduction arrives as `indeterminate`, not `failed`: the external
    // publish tool exits 0 while its JSON body reports {"success": false, "message": "The
    // operation timed out."} (env-tool.ts has no `success` handling — filed as R107). The row is
    // still stored, so the store carries measurable proof of exactly where the gate is blind and
    // the R107 fix will show up as a mode flip indeterminate -> failed. But `indeterminate`'s
    // OTHER causes (verification endpoint unreachable, control app absent, server restarting) are
    // SIZE-INDEPENDENT, so counting one toward the ceiling would permanently refuse files that
    // publish perfectly well.
    const store = new ResultsStore(":memory:");
    try {
      recordPublishOutcome(store, "tier-b", 12, "indeterminate", "Tiny.al");
      recordPublishOutcome(store, "tier-b", 7, "anomalous", "Tinier.al");
      const ceiling = knownCeiling(store, "tier-b");
      expect(ceiling.smallestFailure).toBeUndefined();
      // …and the rows really are there, so this is "not counted", not "not recorded".
      expect(
        store
          .publishOutcomes("tier-b")
          .map((r) => r.outcome)
          .sort(),
      ).toEqual(["anomalous", "indeterminate"]);
      // Nothing is refused on the strength of them.
      expect(() => assertUnderCeiling({ file: "X.al", guardCount: 9_999, ceiling })).not.toThrow();
    } finally {
      store.close();
    }
  });

  test("the ceiling is per tier — one tier's measurement never refuses on another", () => {
    const store = new ResultsStore(":memory:");
    try {
      recordPublishOutcome(store, "tier-a", 331, "failed", "Big.al");
      expect(knownCeiling(store, "tier-b").smallestFailure).toBeUndefined();
      expect(knownCeiling(store, "tier-a").smallestFailure).toBe(331);
    } finally {
      store.close();
    }
  });

  test("a corrupt stored outcome throws, naming itself — never a guessed default", () => {
    const store = new ResultsStore(":memory:");
    try {
      store.db
        .query("INSERT INTO publish_outcomes (tier, guard_count, file, outcome) VALUES (?,?,?,?)")
        .run("tier-c", 5, null, "probably-fine");
      expect(() => knownCeiling(store, "tier-c")).toThrow(/probably-fine/);
    } finally {
      store.close();
    }
  });

  test("an empty tier key is a caller-contract violation, not a row", () => {
    const store = new ResultsStore(":memory:");
    try {
      expect(() => recordPublishOutcome(store, "", 5, "failed", undefined)).toThrow(/tier/);
      expect(() => recordPublishOutcome(store, "t", -1, "failed", undefined)).toThrow(/guard/);
    } finally {
      store.close();
    }
  });

  test("an existing database created before this table gains it on open — no ALTER needed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-ceiling-migrate-"));
    try {
      const dbPath = join(dir, "old.sqlite");
      // An "old" lethal.sqlite: runs table only, no publish_outcomes anywhere.
      const old = new Database(dbPath, { create: true });
      old.exec(
        "CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT, finished_at TEXT, project_path TEXT NOT NULL, backend TEXT NOT NULL, app_version TEXT NOT NULL, batch_count INTEGER, baseline_green INTEGER)",
      );
      old.close();
      const store = new ResultsStore(dbPath);
      try {
        recordPublishOutcome(store, "tier-old", 331, "failed", "Big.al");
        expect(knownCeiling(store, "tier-old").smallestFailure).toBe(331);
      } finally {
        store.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("clearPublishCeiling — the operator escape from a transient failure (fix round 1)", () => {
  test("clearing a tier drops its recorded failures and reports exactly what it destroyed", () => {
    const store = new ResultsStore(":memory:");
    try {
      recordPublishOutcome(store, "tier-a", 229, "accepted", "Mid.al");
      recordPublishOutcome(store, "tier-a", 331, "failed", "Big.al");
      recordPublishOutcome(store, "tier-b", 12, "failed", "Other.al");
      const result = clearPublishCeiling(store, "tier-a", undefined);
      expect(result.before.smallestFailure).toBe(331);
      expect(result.after).toEqual({});
      expect(result.removed).toHaveLength(2);
      expect(result.removed.map((r) => r.guardCount).sort((a, b) => a - b)).toEqual([229, 331]);
      // Another tier's history is untouched — the clear is scoped, not global.
      expect(knownCeiling(store, "tier-b").smallestFailure).toBe(12);
    } finally {
      store.close();
    }
  });

  test("--file narrows the clear, so a surgical undo keeps the rest of a tier's history", () => {
    // The evidence-loss answer: an operator who knows WHICH measurement is bogus does not have to
    // discard the ones that cost a live publish failure to learn.
    const store = new ResultsStore(":memory:");
    try {
      recordPublishOutcome(store, "tier-a", 9, "failed", "Transient.al");
      recordPublishOutcome(store, "tier-a", 331, "failed", "Genuinely.al");
      expect(knownCeiling(store, "tier-a").smallestFailure).toBe(9);
      const result = clearPublishCeiling(store, "tier-a", "Transient.al");
      expect(result.removed).toHaveLength(1);
      expect(result.removed[0]?.file).toBe("Transient.al");
      expect(result.after.smallestFailure).toBe(331);
    } finally {
      store.close();
    }
  });

  test("a blanket clear is the ONLY thing that reaches a multi-file artifact's row", () => {
    // Rows recorded by a multi-file batch carry no filename at all, so a file-only command could
    // never clear them — which is why the blanket clear is the default rather than the exception.
    const store = new ResultsStore(":memory:");
    try {
      recordPublishOutcome(store, "tier-a", 45, "failed", undefined);
      expect(clearPublishCeiling(store, "tier-a", "Anything.al").removed).toHaveLength(0);
      expect(knownCeiling(store, "tier-a").smallestFailure).toBe(45);
      expect(clearPublishCeiling(store, "tier-a", undefined).removed).toHaveLength(1);
      expect(knownCeiling(store, "tier-a").smallestFailure).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test("clearing a tier with nothing recorded is idempotent, not an error", () => {
    const store = new ResultsStore(":memory:");
    try {
      const result = clearPublishCeiling(store, "tier-empty", undefined);
      expect(result.removed).toHaveLength(0);
      expect(result.before).toEqual({});
      expect(result.after).toEqual({});
    } finally {
      store.close();
    }
  });

  test("an empty tier key is a caller-contract violation here too", () => {
    const store = new ResultsStore(":memory:");
    try {
      expect(() => clearPublishCeiling(store, "", undefined)).toThrow(/tier/);
    } finally {
      store.close();
    }
  });
});

describe("guardsPerFile", () => {
  test("counts DEPLOYED guards per file, descending, so the worst offender is named first", () => {
    const counts = [
      ...guardsPerFile([
        { file: "Small.al" },
        { file: "Big.al" },
        { file: "Big.al" },
        { file: "Big.al" },
        { file: "Mid.al" },
        { file: "Mid.al" },
      ]),
    ];
    expect(counts).toEqual([
      ["Big.al", 3],
      ["Mid.al", 2],
      ["Small.al", 1],
    ]);
  });
});

// ————————————————————————————————————————————————————————————————————————
// Step 3 — the WIRING. These are the tests that fail if the ceiling is a
// well-tested function nothing calls.
// ————————————————————————————————————————————————————————————————————————

const APP_ID = "11111111-1111-1111-1111-111111111111";
const APP_JSON = JSON.stringify({
  id: APP_ID,
  name: "Publish Ceiling Fixture",
  publisher: "LethAL",
  version: "1.0.0.0",
  idRanges: [{ from: 79000, to: 79199 }],
});

const TEST_AL = `codeunit 79100 "Sandbox Tests"
{
    Subtype = Test;

    [Test]
    procedure OverBudgetDetected()
    begin
    end;
}
`;

/**
 * A codeunit carrying EXACTLY `guards` deployed mutants. Measured against the real pipeline
 * (`generateMutationSet` + `dedupeSpecs`): the `exit(A > B)` procedure shape yields 3 (empty-block
 * on the body, return-value on the `exit`, conditional-boundary on the `>`), and the `G := n`
 * procedure shape yields exactly 1 — so `3n + r` reaches any count. The exact number is asserted
 * by the tests below rather than assumed: if the operator set changes, they say so instead of
 * silently measuring a different file.
 */
function codeunitWithGuards(objectId: number, name: string, guards: number): string {
  const triples = Math.floor(guards / 3);
  const singles = guards % 3;
  const procs = Array.from(
    { length: triples },
    (_, i) => `    procedure P${i}(A: Decimal; B: Decimal): Boolean
    begin
        exit(A > B);
    end;
`,
  );
  const fillers = Array.from(
    { length: singles },
    (_, i) => `    procedure Q${i}()
    begin
        G := ${i + 1};
    end;
`,
  );
  return `codeunit ${objectId} "${name}"\n{\n    var G: Integer;\n\n${[...procs, ...fillers].join("\n")}}\n`;
}

async function makeCeilingProject(files: ReadonlyArray<{ name: string; source: string }>) {
  const root = await mkdtemp(join(tmpdir(), "lethal-ceiling-"));
  const projectDir = join(root, "app");
  const testDir = join(root, "tests");
  const instrumentedDir = join(root, "instr");
  const quarantineDir = join(root, "quarantine");
  await Bun.write(join(projectDir, "app.json"), APP_JSON);
  for (const f of files) await Bun.write(join(projectDir, f.name), f.source);
  await Bun.write(join(testDir, "SandboxTests.Codeunit.al"), TEST_AL);
  return { root, projectDir, testDir, instrumentedDir, quarantineDir };
}

describe("the fixture generator itself", () => {
  test("produces EXACTLY the requested deployed guard count — otherwise the refusal tests measure a file of unknown size", async () => {
    for (const want of [9, 229, 331]) {
      const dirs = await makeCeilingProject([
        { name: "Sized.Codeunit.al", source: codeunitWithGuards(79000, "Sized", want) },
      ]);
      try {
        const { files } = await generateMutationSet(dirs.projectDir, {});
        const deployed = files.reduce((n, f) => n + dedupeSpecs(f.specs, tierOf).length, 0);
        expect(deployed).toBe(want);
      } finally {
        await rm(dirs.root, { recursive: true, force: true });
      }
    }
  });
});

const CEILING_CAPS: BackendCapabilities = {
  coverage: "none",
  deploy: "publish",
  isolation: "session",
  authoritative: true,
};

const VERIFIER_CFG = {
  baseUrl: "http://bc:7048/BC",
  company: "CRONUS",
  username: "u",
  password: "p",
};

const RESOURCE_SERVER = "http://cronus281";
const RESOURCE_INSTANCE = "BC";
const TIER = `${RESOURCE_SERVER}|${RESOURCE_INSTANCE}`;

/**
 * Mirrors `BcDevMcpBackend.deploy()`'s composition the way `PhaseBackend` (orchestrator.test.ts)
 * already does — fake compile, FAKE DEPLOYER, and the REAL `DeploymentVerifier`,
 * `decidePublishOutcome`, `DeploymentError` and `PublishFailedError`. `publishCalls` is the call
 * counter the pre-flight test asserts against: a refusal that fires AFTER a publish has saved
 * nothing, and wall-clock timing is not evidence (house rule).
 */
class CeilingBackend implements ExecutionBackend {
  publishCalls = 0;
  compileCalls = 0;
  constructor(
    private readonly opts: {
      /** Throwing simulates the deployer's publish() failing. */
      readonly onPublish?: () => void;
      /** What the registry reports back; defaults to echoing the compiled artifact. */
      readonly reportedIdentity?: string;
    } = {},
  ) {}
  capabilities(): BackendCapabilities {
    return CEILING_CAPS;
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "ceiling" };
  }
  private async compileArtifact(dir: string): Promise<CompiledArtifact> {
    this.compileCalls++;
    const appManifest = JSON.parse(await readFile(join(dir, "app.json"), "utf8")) as {
      id: string;
      version: string;
    };
    const mutantManifest = JSON.parse(
      await readFile(join(dir, "mutant-manifest.json"), "utf8"),
    ) as CompiledArtifact["mutantManifest"];
    return {
      artifactId: mutantManifest.artifactId,
      appId: appManifest.id,
      appVersion: appManifest.version,
      appPath: join(dir, "ceiling-fake.app"),
      sha256: Bun.SHA256.hash(new Uint8Array([1, 2, 3]), "hex"),
      mutantManifest,
      appManifest: appManifest as unknown as Record<string, unknown>,
    };
  }
  async compileCheck(dir: string): Promise<void> {
    await this.compileArtifact(dir);
  }
  async deploy(dir: string): Promise<CompiledArtifact | null> {
    const artifact = await this.compileArtifact(dir);
    this.publishCalls++;
    let publishOk = true;
    let publishError: string | undefined;
    try {
      this.opts.onPublish?.();
    } catch (err) {
      publishOk = false;
      publishError = err instanceof Error ? err.message : String(err);
    }
    const reported =
      this.opts.reportedIdentity ?? (publishOk ? artifact.artifactId : "f".repeat(32));
    const fetchFn = (async (_url: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ value: reported }), { status: 200 })) as typeof fetch;
    const verification = await new DeploymentVerifier(VERIFIER_CFG, fetchFn).verify(artifact);
    const outcome = decidePublishOutcome(publishOk, verification);
    if (outcome === "failed") {
      const detail = publishError ?? "publish failed with no detail";
      throw new PublishFailedError(detail, {
        guardCount: artifact.mutantManifest.mutants.length,
        file: undefined,
        tier: TIER,
        detail,
      });
    }
    if (outcome !== "accepted") throw new DeploymentError(outcome, publishError, verification);
    return artifact;
  }
  async activate(_mutantId: string | null): Promise<void> {}
  async run(ref: TestMethodRef, _opts: RunOpts): Promise<TestVerdict> {
    return {
      ref,
      outcome: "pass",
      durationMs: 1,
      attestation: { observedAny: true, identityMismatch: false },
    };
  }
}

const selectorIds = { selectorId: 50000, controlId: 50001, tableId: 50002 };

/** The same resolver `writeInstrumentedProject` builds — so the fixture-size check below measures
 *  the DEPLOYED count, not the raw site count. */
const tierOf: TierResolver = (name) => operatorTiers.get(name);

describe("publish ceiling — wired into the session (R90)", () => {
  test("a demonstrated publish failure leaves a (tier, guardCount, 'failed') row behind", async () => {
    const dirs = await makeCeilingProject([
      { name: "Small.Codeunit.al", source: codeunitWithGuards(79000, "Small", 9) },
    ]);
    const store = new ResultsStore(":memory:");
    // A fake deployer that THROWS plus a verifier reporting a different artifact:
    // decidePublishOutcome(false, mismatch) === "failed".
    const backend = new CeilingBackend({
      onPublish: () => {
        throw new Error("continia publish: The operation timed out.");
      },
      reportedIdentity: "f".repeat(32),
    });
    try {
      await expect(
        runSession({
          backend,
          store,
          projectDir: dirs.projectDir,
          testDir: dirs.testDir,
          instrumentedDir: dirs.instrumentedDir,
          selectorIds,
          resourceServer: RESOURCE_SERVER,
          resourceServerInstance: RESOURCE_INSTANCE,
          quarantineDir: dirs.quarantineDir,
        }),
      ).rejects.toBeInstanceOf(PublishFailedError);
      const rows = store.publishOutcomes(TIER);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.outcome).toBe("failed");
      expect(rows[0]?.guardCount).toBe(9);
      expect(rows[0]?.file).toBe("Small.Codeunit.al");
      expect(knownCeiling(store, TIER).smallestFailure).toBe(9);
    } finally {
      store.close();
      await rm(dirs.root, { recursive: true, force: true });
    }
  });

  test("an accepted publish is recorded too — largestSuccess is what the refusal quotes back", async () => {
    const dirs = await makeCeilingProject([
      { name: "Small.Codeunit.al", source: codeunitWithGuards(79000, "Small", 9) },
    ]);
    const store = new ResultsStore(":memory:");
    try {
      await runSession({
        backend: new CeilingBackend(),
        store,
        projectDir: dirs.projectDir,
        testDir: dirs.testDir,
        instrumentedDir: dirs.instrumentedDir,
        selectorIds,
        resourceServer: RESOURCE_SERVER,
        resourceServerInstance: RESOURCE_INSTANCE,
        quarantineDir: dirs.quarantineDir,
      });
      expect(knownCeiling(store, TIER)).toEqual({ largestSuccess: 9 });
    } finally {
      store.close();
      await rm(dirs.root, { recursive: true, force: true });
    }
  });

  test("a seeded failure refuses a same-size file BEFORE anything is compiled or published", async () => {
    // The measured bracket, verbatim: 331 guards timed out on the campaign's hosted tier; 229
    // published. The fixture file carries exactly 331 — the `>=` boundary, the strongest form.
    const dirs = await makeCeilingProject([
      { name: "Big.Codeunit.al", source: codeunitWithGuards(79000, "Big", 331) },
    ]);
    const store = new ResultsStore(":memory:");
    const backend = new CeilingBackend();
    try {
      recordPublishOutcome(store, TIER, 229, "accepted", "Mid.Codeunit.al");
      recordPublishOutcome(store, TIER, 331, "failed", "Big.Codeunit.al");
      const err = await runSession({
        backend,
        store,
        projectDir: dirs.projectDir,
        testDir: dirs.testDir,
        instrumentedDir: dirs.instrumentedDir,
        selectorIds,
        resourceServer: RESOURCE_SERVER,
        resourceServerInstance: RESOURCE_INSTANCE,
        quarantineDir: dirs.quarantineDir,
      }).catch((e: unknown) => e);
      expect(String((err as Error).message)).toContain("Big.Codeunit.al");
      expect(String((err as Error).message)).toContain("331");
      // The whole point of R90: the refusal costs nothing, because nothing was paid for yet.
      expect(backend.publishCalls).toBe(0);
      expect(backend.compileCalls).toBe(0);
    } finally {
      store.close();
      await rm(dirs.root, { recursive: true, force: true });
    }
  });

  test("a file BELOW the seeded failure still publishes — the refusal is a bracket, not a wall", async () => {
    const dirs = await makeCeilingProject([
      { name: "Mid.Codeunit.al", source: codeunitWithGuards(79000, "Mid", 229) },
    ]);
    const store = new ResultsStore(":memory:");
    const backend = new CeilingBackend();
    try {
      recordPublishOutcome(store, TIER, 331, "failed", "Big.Codeunit.al");
      const report = await runSession({
        backend,
        store,
        projectDir: dirs.projectDir,
        testDir: dirs.testDir,
        instrumentedDir: dirs.instrumentedDir,
        selectorIds,
        resourceServer: RESOURCE_SERVER,
        resourceServerInstance: RESOURCE_INSTANCE,
        quarantineDir: dirs.quarantineDir,
      });
      expect(backend.publishCalls).toBe(1);
      expect(report.mutants).toHaveLength(229);
    } finally {
      store.close();
      await rm(dirs.root, { recursive: true, force: true });
    }
  });

  test("an artifact whose TOTAL exceeds the bracket still runs when no single file does — --max-guards-per-batch is the lever there", async () => {
    // Batches split at FILE granularity: a file that alone exceeds the bracket is unrescuable and
    // is refused. Two files that only exceed it TOGETHER are exactly what the batch budget exists
    // for, so refusing them would be the false-refusal direction.
    const dirs = await makeCeilingProject([
      { name: "A.Codeunit.al", source: codeunitWithGuards(79000, "A", 30) },
      { name: "B.Codeunit.al", source: codeunitWithGuards(79001, "B", 30) },
    ]);
    const store = new ResultsStore(":memory:");
    const backend = new CeilingBackend();
    try {
      recordPublishOutcome(store, TIER, 50, "failed", undefined);
      const report = await runSession({
        backend,
        store,
        projectDir: dirs.projectDir,
        testDir: dirs.testDir,
        instrumentedDir: dirs.instrumentedDir,
        selectorIds,
        resourceServer: RESOURCE_SERVER,
        resourceServerInstance: RESOURCE_INSTANCE,
        quarantineDir: dirs.quarantineDir,
      });
      expect(backend.publishCalls).toBe(1);
      expect(report.mutants).toHaveLength(60);
    } finally {
      store.close();
      await rm(dirs.root, { recursive: true, force: true });
    }
  });

  test("the pre-flight is CONSULTED per file, not merely implemented — a 331-guard file passes when the tier's failure was recorded elsewhere", async () => {
    // Guards the wiring from the other side: the refusal above must come from THIS tier's history,
    // not from any recorded failure anywhere. Same file, same size, failure filed under a
    // different tier — it must publish.
    const dirs = await makeCeilingProject([
      { name: "Big.Codeunit.al", source: codeunitWithGuards(79000, "Big", 331) },
    ]);
    const store = new ResultsStore(":memory:");
    const backend = new CeilingBackend();
    try {
      recordPublishOutcome(store, "http://some-other-host|BC", 331, "failed", "Big.Codeunit.al");
      await runSession({
        backend,
        store,
        projectDir: dirs.projectDir,
        testDir: dirs.testDir,
        instrumentedDir: dirs.instrumentedDir,
        selectorIds,
        resourceServer: RESOURCE_SERVER,
        resourceServerInstance: RESOURCE_INSTANCE,
        quarantineDir: dirs.quarantineDir,
      });
      expect(backend.publishCalls).toBe(1);
    } finally {
      store.close();
      await rm(dirs.root, { recursive: true, force: true });
    }
  });

  test("a file refused by a TRANSIENT failure publishes again after clear-ceiling — the ratchet has a release", async () => {
    // Fix round 1's Important finding, end to end. `publishOk` goes false on ANY throw out of
    // `deployer.publish()`, including a Bun spawn ENOENT (R65 measured one), so a transient blip
    // records a `failed` row that permanently refuses every file that size — a refused file can
    // never publish, so it can never produce the counter-evidence that would widen the bracket.
    const dirs = await makeCeilingProject([
      { name: "Big.Codeunit.al", source: codeunitWithGuards(79000, "Big", 331) },
    ]);
    const store = new ResultsStore(":memory:");
    const session = () =>
      runSession({
        backend,
        store,
        projectDir: dirs.projectDir,
        testDir: dirs.testDir,
        instrumentedDir: dirs.instrumentedDir,
        selectorIds,
        resourceServer: RESOURCE_SERVER,
        resourceServerInstance: RESOURCE_INSTANCE,
        quarantineDir: dirs.quarantineDir,
      });
    const backend = new CeilingBackend();
    try {
      // A transient spawn failure recorded against this tier at exactly this file's size.
      recordPublishOutcome(store, TIER, 331, "failed", "Big.Codeunit.al");
      const refused = await session().catch((e: unknown) => e);
      expect(String((refused as Error).message)).toContain("Big.Codeunit.al");
      expect(backend.publishCalls).toBe(0);

      // The escape the refusal message itself names.
      const cleared = clearPublishCeiling(store, TIER, "Big.Codeunit.al");

      // The property that matters, asserted FIRST and deliberately: same project, same file, same
      // tier, and it now PUBLISHES. Assertion order is load-bearing here — checking the returned
      // bookkeeping first would let a `clearPublishCeiling` that reports a clear it never performed
      // fail on the bookkeeping line and never reach the only assertion that proves the ratchet
      // actually released.
      const report = await session();
      expect(backend.publishCalls).toBe(1);
      expect(report.mutants).toHaveLength(331);

      // …and only then, that what it REPORTED destroying matches what the session just proved.
      expect(cleared.removed).toHaveLength(1);
      expect(cleared.after.smallestFailure).toBeUndefined();
    } finally {
      store.close();
      await rm(dirs.root, { recursive: true, force: true });
    }
  });

  test("the refusal a real session throws carries the copy-pasteable clear-ceiling command", async () => {
    const dirs = await makeCeilingProject([
      { name: "Big.Codeunit.al", source: codeunitWithGuards(79000, "Big", 331) },
    ]);
    const store = new ResultsStore(":memory:");
    try {
      recordPublishOutcome(store, TIER, 331, "failed", "Big.Codeunit.al");
      const err = await runSession({
        backend: new CeilingBackend(),
        store,
        projectDir: dirs.projectDir,
        testDir: dirs.testDir,
        instrumentedDir: dirs.instrumentedDir,
        selectorIds,
        resourceServer: RESOURCE_SERVER,
        resourceServerInstance: RESOURCE_INSTANCE,
        quarantineDir: dirs.quarantineDir,
      }).catch((e: unknown) => e);
      const m = String((err as Error).message);
      // The real tier and the real project dir, not a placeholder to fill in by hand.
      expect(m).toContain("lethal clear-ceiling");
      expect(m).toContain(`--server "${RESOURCE_SERVER}"`);
      expect(m).toContain(`--instance "${RESOURCE_INSTANCE}"`);
      expect(m).toContain(`--project "${dirs.projectDir}"`);
      expect(m).toContain('--file "Big.Codeunit.al"');
    } finally {
      store.close();
      await rm(dirs.root, { recursive: true, force: true });
    }
  });

  test("an `indeterminate` deploy failure records its category — and refuses nothing afterwards", async () => {
    // R107's shape, end to end: the publish call itself SUCCEEDS while the deployment is not ours.
    // The row must land (so the R107 fix is measurable as a mode flip) and must not become a wall.
    const dirs = await makeCeilingProject([
      { name: "Small.Codeunit.al", source: codeunitWithGuards(79000, "Small", 9) },
    ]);
    const store = new ResultsStore(":memory:");
    try {
      await expect(
        runSession({
          backend: new CeilingBackend({ reportedIdentity: "f".repeat(32) }),
          store,
          projectDir: dirs.projectDir,
          testDir: dirs.testDir,
          instrumentedDir: dirs.instrumentedDir,
          selectorIds,
          resourceServer: RESOURCE_SERVER,
          resourceServerInstance: RESOURCE_INSTANCE,
          quarantineDir: dirs.quarantineDir,
        }),
      ).rejects.toThrow(/indeterminate/i);
      const rows = store.publishOutcomes(TIER);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.outcome).toBe("indeterminate");
      expect(rows[0]?.guardCount).toBe(9);
      expect(knownCeiling(store, TIER).smallestFailure).toBeUndefined();
    } finally {
      store.close();
      await rm(dirs.root, { recursive: true, force: true });
    }
  });
});

// ————————————————————————————————————————————————————————————————————————
// Step 4 — `--dry-run` reports BOTH counts (R92) and the measured bracket (R90).
// ————————————————————————————————————————————————————————————————————————

/**
 * The only shape in this repo where a Tier-2 operator provably claims a site `void-method-call`
 * also claims, so §3.2 precedence DELETES the Tier-1 mutant and `sites !== deployed`. A fixture
 * where the two counts happened to be equal could not tell "both printed" from "one printed
 * twice", which is the exact confusion R92 exists to end.
 */
const COLLISION_AL = `codeunit 79300 "Tier2 Collisions"
{
    procedure P()
    var
        Cust: Record Customer;
    begin
        Cust.TestField("No.");
        Cust.SetRange("No.", 'A');
        Cust.CalcFields(Balance);
    end;
}
`;

async function captureDryRun(
  projectDir: string,
  paths: { dbPath: string; configPath: string },
): Promise<string> {
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    await printDryRun(projectDir, undefined, paths);
  } finally {
    log.mockRestore();
  }
  return lines.join("\n");
}

describe("--dry-run reports both counts and the measured bracket (R92/R90)", () => {
  test("names BOTH the site count and the deployed count per file, largest first — never one number standing for the other", async () => {
    const dirs = await makeCeilingProject([
      { name: "Collisions.Codeunit.al", source: COLLISION_AL },
      { name: "Small.Codeunit.al", source: codeunitWithGuards(79000, "Small", 3) },
    ]);
    try {
      const out = await captureDryRun(dirs.projectDir, {
        dbPath: join(dirs.root, "absent.sqlite"),
        configPath: join(dirs.root, "absent.json"),
      });
      const collisionLine = out
        .split("\n")
        .find((l) => l.includes("Collisions.Codeunit.al") && l.includes("sites="));
      expect(collisionLine).toBeDefined();
      const sites = Number(/sites=(\d+)/.exec(collisionLine ?? "")?.[1]);
      const deployed = Number(/deployed=(\d+)/.exec(collisionLine ?? "")?.[1]);
      // The measured property, not a hardcoded pair: three Tier-2 narrowings each displace a
      // void-method-call mutant, so deployed is strictly smaller. If that ever stops being true,
      // this fixture has stopped exercising R92 and says so.
      expect(sites).toBeGreaterThan(deployed);
      expect(deployed).toBeGreaterThan(0);
      // Descending by deployed count: the file to split or exclude is named first.
      const order = out
        .split("\n")
        .filter((l) => l.includes("sites=") && l.includes("deployed="))
        .map((l) => Number(/deployed=(\d+)/.exec(l)?.[1]));
      expect(order).toEqual([...order].sort((a, b) => b - a));
      // The header carries the deployed total too, labelled.
      expect(out).toMatch(/deployed mutant\(s\)/);
      // …and the per-site listing marks the displaced Tier-1 mutants, so nobody counts the lines
      // and pre-commits that number as the mutant count (the mistake R92 was filed for).
      const displaced = out.split("\n").filter((l) => l.includes("[not deployed")).length;
      expect(displaced).toBe(sites - deployed);
      expect(out).toMatch(/lethal\.void-method-call {2}\[not deployed/);
    } finally {
      await rm(dirs.root, { recursive: true, force: true });
    }
  });

  test("reports the tier's measured bracket as MEASUREMENT, and says what will be refused", async () => {
    const dirs = await makeCeilingProject([
      { name: "Small.Codeunit.al", source: codeunitWithGuards(79000, "Small", 3) },
    ]);
    const dbPath = join(dirs.root, "lethal.sqlite");
    const configPath = join(dirs.root, "lethal.config.json");
    try {
      const store = new ResultsStore(dbPath);
      recordPublishOutcome(store, TIER, 229, "accepted", "Mid.al");
      recordPublishOutcome(store, TIER, 331, "failed", "Big.al");
      store.close();
      await Bun.write(
        configPath,
        JSON.stringify({ bcdev: { server: RESOURCE_SERVER, serverInstance: RESOURCE_INSTANCE } }),
      );
      const out = await captureDryRun(dirs.projectDir, { dbPath, configPath });
      expect(out).toContain(TIER);
      expect(out).toContain("331");
      expect(out).toContain("229");
      expect(out).toMatch(/MEASURED/);
      expect(out).toMatch(/not a fixed limit/i);
      expect(out).toMatch(/REFUSED/);
      expect(out).not.toMatch(/the limit is/i);
    } finally {
      await rm(dirs.root, { recursive: true, force: true });
    }
  });

  test("a project with no config and no database still dry-runs, and creates neither", async () => {
    const dirs = await makeCeilingProject([
      { name: "Small.Codeunit.al", source: codeunitWithGuards(79000, "Small", 3) },
    ]);
    const dbPath = join(dirs.root, "lethal.sqlite");
    const configPath = join(dirs.root, "lethal.config.json");
    try {
      const out = await captureDryRun(dirs.projectDir, { dbPath, configPath });
      expect(out).toContain("dry run:");
      expect(out).not.toMatch(/publish ceiling/i);
      // A dry run must leave nothing behind — `new ResultsStore(path)` would have CREATED one.
      expect(existsSync(dbPath)).toBe(false);
    } finally {
      await rm(dirs.root, { recursive: true, force: true });
    }
  });

  test("a tier with a database but no recorded outcome says so, rather than staying silent", async () => {
    const dirs = await makeCeilingProject([
      { name: "Small.Codeunit.al", source: codeunitWithGuards(79000, "Small", 3) },
    ]);
    const dbPath = join(dirs.root, "lethal.sqlite");
    const configPath = join(dirs.root, "lethal.config.json");
    try {
      new ResultsStore(dbPath).close();
      await Bun.write(
        configPath,
        JSON.stringify({ bcdev: { server: RESOURCE_SERVER, serverInstance: RESOURCE_INSTANCE } }),
      );
      const out = await captureDryRun(dirs.projectDir, { dbPath, configPath });
      expect(out).toMatch(/nothing measured yet/i);
      expect(out).toMatch(/failing once/i);
    } finally {
      await rm(dirs.root, { recursive: true, force: true });
    }
  });
});

// ————————————————————————————————————————————————————————————————————————
// Fix round 1 — `lethal clear-ceiling` at the CLI boundary.
// ————————————————————————————————————————————————————————————————————————

describe("lethal clear-ceiling (CLI)", () => {
  test("parses the tier, the project, the db default and the optional --file", () => {
    expect(
      parseCliConfig([
        "clear-ceiling",
        "--project",
        "proj",
        "--server",
        "http://bc",
        "--instance",
        "BC",
      ]),
    ).toEqual({
      mode: "clear-ceiling",
      projectDir: "proj",
      dbPath: join("proj", "lethal.sqlite"),
      server: "http://bc",
      serverInstance: "BC",
    });
    expect(
      parseCliConfig([
        "clear-ceiling",
        "--project",
        "proj",
        "--server",
        "http://bc",
        "--instance",
        "BC",
        "--file",
        "Big.al",
        "--db",
        "other.sqlite",
      ]),
    ).toEqual({
      mode: "clear-ceiling",
      projectDir: "proj",
      dbPath: "other.sqlite",
      server: "http://bc",
      serverInstance: "BC",
      file: "Big.al",
    });
  });

  test("refuses a missing identity or project rather than clearing something unnamed", () => {
    expect(() => parseCliConfig(["clear-ceiling", "--project", "p", "--instance", "BC"])).toThrow(
      /--server/,
    );
    expect(() =>
      parseCliConfig(["clear-ceiling", "--project", "p", "--server", "http://bc"]),
    ).toThrow(/--instance/);
    expect(() =>
      parseCliConfig(["clear-ceiling", "--server", "http://bc", "--instance", "BC"]),
    ).toThrow(/--project/);
  });

  test("help documents the subcommand and both of its non-obvious properties", () => {
    const text = helpText("0.0.0");
    expect(text).toContain("lethal clear-ceiling");
    // Omitting --file clears the tier, and that is the ONLY way to reach a multi-file row.
    expect(text).toMatch(/multi-file artifact/);
    // Every removed row is printed, because discarding a genuine failure is evidence loss.
    expect(text).toMatch(/evidence loss/i);
    // Minor 2: a "dry" run that migrates an existing schema is a surprise unless it is documented.
    expect(text).toMatch(/OPENED FOR WRITING/);
  });
});
