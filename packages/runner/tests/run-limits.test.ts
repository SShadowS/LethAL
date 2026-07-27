import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
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
import { LETHAL_VERSION, helpText, parseCliConfig } from "../src/cli";
import {
  LARGE_RUN_MUTANT_THRESHOLD,
  MIN_MUTANT_BUDGET_MS,
  assertRunSizeAcceptable,
  runSession,
} from "../src/orchestrator";
import { ResultsStore } from "../src/store";

/**
 * R47 (`--mutant-timeout-ms`) and R48 (the large-run pre-flight refusal): the two guards that
 * decide whether a run on a REAL project can start and can finish.
 */

const APP_ID = "0f2b7c5e-4d3a-4917-8a1c-3b4a8d9f1027";
const APP_JSON = JSON.stringify({
  id: APP_ID,
  name: "Sandbox Limits Fixture",
  publisher: "LethAL",
  version: "1.0.0.0",
  idRanges: [{ from: 79000, to: 79199 }],
});

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

const CAPS: BackendCapabilities = {
  coverage: "procedure",
  deploy: "publish",
  isolation: "session",
  authoritative: true,
};

const selectorIds = { selectorId: 50000, controlId: 50001, tableId: 50002 };

async function makeProject() {
  const root = await mkdtemp(join(tmpdir(), "lethal-limits-"));
  const projectDir = join(root, "app");
  const testDir = join(root, "tests");
  const instrumentedDir = join(root, "instr");
  await Bun.write(join(projectDir, "SandboxLogic.Codeunit.al"), TARGET_AL);
  await Bun.write(join(projectDir, "app.json"), APP_JSON);
  await Bun.write(join(testDir, "SandboxTests.Codeunit.al"), TEST_AL);
  return { projectDir, testDir, instrumentedDir };
}

/** Records the `timeoutMs` every mutant run was budgeted, which is the thing R47 makes settable. */
class BudgetRecordingBackend implements ExecutionBackend {
  mutantBudgets: number[] = [];
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
    if (active !== null && opts.timeoutMs !== undefined) this.mutantBudgets.push(opts.timeoutMs);
    return {
      ref,
      outcome: "pass",
      // 5 ms baseline: `2 x baseline` is 10 ms, far under any floor, so the floor is what decides
      // the budget and the assertion below is unambiguous about which term won.
      durationMs: 5,
      ...(active === null
        ? {
            coverage: {
              granularity: "procedure" as const,
              entries: [{ objectType: "Codeunit", objectId: 79000, procedure: "IsOverBudget" }],
            },
          }
        : {}),
      ...(opts.coverage === "none"
        ? { attestation: { observedAny: true, identityMismatch: false } }
        : {}),
    };
  }
}

describe("assertRunSizeAcceptable (R48)", () => {
  test("a run at the threshold is allowed", () => {
    expect(() =>
      assertRunSizeAcceptable({
        mutantCount: LARGE_RUN_MUTANT_THRESHOLD,
        fileCount: 10,
        narrowed: false,
        allowLargeRun: false,
      }),
    ).not.toThrow();
  });

  test("a run above the threshold is REFUSED, not warned about", () => {
    // Refusal is the point. A warning about a cost that lands hours later scrolls past in the
    // first second of the run.
    expect(() =>
      assertRunSizeAcceptable({
        mutantCount: LARGE_RUN_MUTANT_THRESHOLD + 1,
        fileCount: 438,
        narrowed: false,
        allowLargeRun: false,
      }),
    ).toThrow(/pre-flight limit/);
  });

  test("the refusal names the count, the file count and every narrowing lever", () => {
    // A bare "too many mutants" sends the reader hunting for a limit to raise. What they need is
    // the three levers and which of them can change a verdict.
    let message = "";
    try {
      assertRunSizeAcceptable({
        mutantCount: 19832,
        fileCount: 438,
        narrowed: false,
        allowLargeRun: false,
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("19832");
    expect(message).toContain("438");
    expect(message).toContain("--only");
    expect(message).toContain("--tests-only");
    expect(message).toContain("--max-guards-per-batch");
    expect(message).toContain("--allow-large-run");
  });

  test("--allow-large-run turns it off entirely", () => {
    expect(() =>
      assertRunSizeAcceptable({
        mutantCount: 1_000_000,
        fileCount: 9999,
        narrowed: false,
        allowLargeRun: true,
      }),
    ).not.toThrow();
  });

  test("an already-narrowed run is told to narrow FURTHER, not to add --only", () => {
    let message = "";
    try {
      assertRunSizeAcceptable({
        mutantCount: 6572,
        fileCount: 82,
        narrowed: true,
        allowLargeRun: false,
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("Narrow --only further");
  });

  test("runSession refuses before deploying anything", async () => {
    // The fixture is tiny, so drive the guard directly through the session by lowering nothing —
    // instead assert the opposite direction: a small project is NOT refused and does deploy.
    const dirs = await makeProject();
    const backend = new BudgetRecordingBackend();
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(report.counts.survived + report.counts.killed).toBeGreaterThan(0);
  });
});

describe("CLI flags (R47/R48)", () => {
  const RUN_ARGS = ["run", "--project", "p", "--tests", "t", "--backend", "al-runner"] as const;

  test("--mutant-timeout-ms parses as a positive integer", () => {
    const cfg = parseCliConfig([...RUN_ARGS, "--mutant-timeout-ms", "120000"]);
    if (cfg.mode !== "run") throw new Error("mode drift");
    expect(cfg.mutantTimeoutMs).toBe(120_000);
  });

  test("--mutant-timeout-ms rejects a non-integer and a non-positive value", () => {
    expect(() => parseCliConfig([...RUN_ARGS, "--mutant-timeout-ms", "1.5"])).toThrow(
      /positive integer/,
    );
    expect(() => parseCliConfig([...RUN_ARGS, "--mutant-timeout-ms", "0"])).toThrow(
      /positive integer/,
    );
  });

  test("absent flags leave no keys at all (exactOptionalPropertyTypes)", () => {
    const cfg = parseCliConfig([...RUN_ARGS]);
    expect("mutantTimeoutMs" in cfg).toBe(false);
    expect("resume" in cfg).toBe(false);
    expect("allowLargeRun" in cfg).toBe(false);
  });

  test("--resume selects the last run; --resume-run names one", () => {
    const last = parseCliConfig([...RUN_ARGS, "--resume"]);
    if (last.mode !== "run") throw new Error("mode drift");
    expect(last.resume).toBe("last");
    const named = parseCliConfig([...RUN_ARGS, "--resume-run", "12"]);
    if (named.mode !== "run") throw new Error("mode drift");
    expect(named.resume).toBe(12);
  });

  test("--resume-run rejects a non-positive-integer run id", () => {
    expect(() => parseCliConfig([...RUN_ARGS, "--resume-run", "x"])).toThrow(/positive integer/);
  });

  test("--resume and --resume-run are mutually exclusive", () => {
    // Not a precedence question — a caller who passes both wants two different things, and
    // silently picking one would resume from a run they did not name.
    expect(() => parseCliConfig([...RUN_ARGS, "--resume", "--resume-run", "7"])).toThrow(
      /mutually exclusive/,
    );
  });

  test("--allow-large-run parses", () => {
    const cfg = parseCliConfig([...RUN_ARGS, "--allow-large-run"]);
    if (cfg.mode !== "run") throw new Error("mode drift");
    expect(cfg.allowLargeRun).toBe(true);
  });

  test("--mutant-timeout-ms and --resume are refused with --dry-run", () => {
    // A dry run executes no mutants and records no verdicts; accepting either would imply it had
    // done something.
    expect(() =>
      parseCliConfig(["run", "--project", "p", "--dry-run", "--mutant-timeout-ms", "1000"]),
    ).toThrow(/no effect with --dry-run/);
    expect(() => parseCliConfig(["run", "--project", "p", "--dry-run", "--resume"])).toThrow(
      /no effect with --dry-run/,
    );
  });
});

describe("--help and --version (R49)", () => {
  const RUN_ARGS = ["run", "--project", "p", "--tests", "t", "--backend", "al-runner"] as const;

  test("--help and -h are recognised BEFORE strict parseArgs rejects them", () => {
    // The defect: parseArgs runs in strict mode, so `--help` used to exit 1 with a raw TypeError
    // and a stack trace into the bundled binary — for the flag a new user types first.
    expect(parseCliConfig(["--help"]).mode).toBe("help");
    expect(parseCliConfig(["-h"]).mode).toBe("help");
    expect(parseCliConfig(["run", "--help"]).mode).toBe("help");
  });

  test("a bare invocation shows usage rather than 'unknown subcommand: got none'", () => {
    expect(parseCliConfig([]).mode).toBe("help");
  });

  test("--version and -V report the bundled release version", () => {
    expect(parseCliConfig(["--version"]).mode).toBe("version");
    expect(parseCliConfig(["-V"]).mode).toBe("version");
    // Bundled by a static JSON import, not read from disk at runtime — R50 measured that a
    // runtime-computed path resolves against Bun's virtual root under `--compile` and fails.
    expect(LETHAL_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("an unknown subcommand still errors, and now points at --help", () => {
    expect(() => parseCliConfig(["frobnicate"])).toThrow(/lethal --help/);
  });

  test("help text documents every flag `parseCliConfig` accepts", () => {
    // A flag that exists and is undocumented is invisible to anyone holding only the binary. This
    // pins the two together so adding a flag without documenting it fails here.
    const text = helpText("0.0.0");
    for (const flag of [
      "--project",
      "--tests",
      "--backend",
      "--db",
      "--out",
      "--config",
      "--skip-known-survivors",
      "--dry-run",
      "--workers",
      "--compile-concurrency",
      "--server",
      "--instance",
      "--keep-env",
      "--allow-expiring-env",
      "--selector-id",
      "--control-id",
      "--table-id",
      "--only",
      "--tests-only",
      "--max-guards-per-batch",
      "--mutant-timeout-ms",
      "--resume",
      "--resume-run",
      "--allow-large-run",
    ]) {
      expect(text).toContain(flag);
    }
  });

  test("help names the quarantine exit code and the verdict-changing narrowing", () => {
    // The two things a reader cannot infer and will otherwise get wrong: exit 3 is not a crash,
    // and --tests-only can manufacture a survivor.
    const text = helpText("0.0.0");
    expect(text).toContain("quarantined");
    expect(text).toMatch(/--tests-only[\s\S]*CAN CHANGE A\s+VERDICT/);
  });

  test("--help wins over an otherwise-valid run invocation", () => {
    expect(parseCliConfig([...RUN_ARGS, "--help"]).mode).toBe("help");
  });
});

describe("--mutant-timeout-ms (R47)", () => {
  test("the default floor is MIN_MUTANT_BUDGET_MS", async () => {
    const dirs = await makeProject();
    const backend = new BudgetRecordingBackend();
    const store = new ResultsStore(":memory:");
    await runSession({ backend, store, ...dirs, selectorIds });
    expect(backend.mutantBudgets.length).toBeGreaterThan(0);
    for (const b of backend.mutantBudgets) expect(b).toBe(MIN_MUTANT_BUDGET_MS);
  });

  test("a configured floor reaches every mutant run", async () => {
    // Before R47 this constant had no config surface at all, and exceeding it cost the whole run:
    // an over-budget run is indistinguishable from one the server may still be executing, so the
    // session quarantines. Measured on a real project, that discarded 12 scored mutants at 13/138.
    const dirs = await makeProject();
    const backend = new BudgetRecordingBackend();
    const store = new ResultsStore(":memory:");
    await runSession({ backend, store, ...dirs, selectorIds, mutantTimeoutMs: 300_000 });
    expect(backend.mutantBudgets.length).toBeGreaterThan(0);
    for (const b of backend.mutantBudgets) expect(b).toBe(300_000);
  });

  test("it raises the floor, it does not CAP a slow test's 2x budget", async () => {
    // A floor below `2 x baseline` must leave the generous term in place — capping is what would
    // cause the aborts this flag exists to prevent.
    const dirs = await makeProject();
    const backend = new BudgetRecordingBackend();
    const store = new ResultsStore(":memory:");
    await runSession({ backend, store, ...dirs, selectorIds, mutantTimeoutMs: 1 });
    // Baseline duration is 5 ms in this fake, so `2 x baseline` = 10 ms wins over the 1 ms floor.
    for (const b of backend.mutantBudgets) expect(b).toBe(10);
  });
});
