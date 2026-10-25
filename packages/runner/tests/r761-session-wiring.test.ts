// R761: guards an opus build review found untested.
// (1) runSession passes `resume: <cfg.resume set>` to backend.decideTransport.
// (2) the first real spawn (callCodeunit, startDaemon) freezes the transport decision.
// (3) the shape scan also covers the TEST folder.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import { AlRunnerV3Backend } from "../src/al-runner-v3-backend";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  PackageUnread,
  RunOpts,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import type { MicrosoftMode } from "../src/digest-inputs";
import { runSession } from "../src/orchestrator";
import { ResultsStore } from "../src/store";
import { servedIsInstalled, testAppJson, testAppPackage } from "./helpers/proven-test-app";
import { scratchDirs } from "./helpers/scratch";

const scratch = scratchDirs();

const LOGIC_AL = `codeunit 79000 "Sandbox Logic"
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
const APP_JSON = JSON.stringify({
  id: "6d0f4a2e-1c3b-4a8d-9f10-2b7c5e4d3a91",
  name: "Sandbox R761 Fixture",
  publisher: "LethAL",
  version: "1.0.0.0",
  idRanges: [{ from: 79000, to: 79199 }],
});
const selectorIds = { selectorId: 50000, controlId: 50001, tableId: 50002 };

/** A stateful fake: records every `decideTransport` argument. Every mutant is killed. */
class DecideBackend implements ExecutionBackend {
  readonly decisions: { resume: boolean }[] = [];
  private active: string | null = null;
  private mutantRuns = 0;
  /** Abort (in-flight-unknown) after this many mutant runs, so the run is left unfinished. */
  constructor(private readonly abortAfter?: number) {}
  served: Uint8Array | PackageUnread = testAppPackage();
  async fetchPublishedAppPackage(): Promise<Uint8Array | PackageUnread> {
    return this.served;
  }
  microsoftMode(): MicrosoftMode {
    return servedIsInstalled(() => this.served);
  }
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
  async decideTransport(facts: { readonly resume: boolean }): Promise<void> {
    this.decisions.push({ resume: facts.resume });
  }
  async deploy(): Promise<null> {
    return null;
  }
  async compileCheck(): Promise<void> {}
  async activate(id: string | null): Promise<void> {
    this.active = id;
  }
  async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
    if (this.active === null) {
      return {
        ref,
        outcome: "pass",
        durationMs: 5,
        coverage: {
          granularity: "procedure" as const,
          entries: [{ objectType: "Codeunit", objectId: 79000, procedure: "IsOverBudget" }],
        },
      };
    }
    this.mutantRuns += 1;
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
      outcome: "fail",
      durationMs: 5,
      failureMessage: "Assert.IsTrue failed",
      ...(opts.coverage === "none"
        ? { attestation: { observedAny: true, identityMismatch: false } }
        : {}),
    };
  }
}

describe("R761: runSession hands the resume fact to decideTransport", () => {
  test("no resume: false; resume: true", async () => {
    const root = scratch("lethal-r761-wire-");
    const dirs = {
      projectDir: join(root, "app"),
      testDir: join(root, "tests"),
      instrumentedDir: join(root, "instr"),
    };
    await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), LOGIC_AL);
    await Bun.write(join(dirs.projectDir, "app.json"), APP_JSON);
    await Bun.write(join(dirs.testDir, "SandboxTests.Codeunit.al"), TEST_AL);
    await Bun.write(join(dirs.testDir, "app.json"), testAppJson());
    const store = new ResultsStore(":memory:");
    const first = new DecideBackend(1);
    await runSession({ backend: first, store, ...dirs, selectorIds });
    const second = new DecideBackend();
    await runSession({ backend: second, store, ...dirs, selectorIds, resume: "last" });
    store.close();
    expect(first.decisions).toEqual([{ resume: false }]);
    expect(second.decisions).toEqual([{ resume: true }]);
  });
});

let roots: string[] = [];
beforeAll(async () => {
  await initParser();
});
afterEach(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
  roots = [];
});

const PLAIN_AL = `codeunit 50000 "Plain"\n{\n    procedure P()\n    begin\n    end;\n}\n`;
const MULTI_AL = `${PLAIN_AL}\ncodeunit 50001 "Second"\n{\n    procedure Q()\n    begin\n    end;\n}\n`;
const PLAIN_TESTS: TestMethodRef[] = [
  { codeunitId: 50100, codeunitName: "Plain Tests", method: "A" },
];

async function backend(testSrc: string) {
  const root = await mkdtemp(join(tmpdir(), "r761w-"));
  roots.push(root);
  const src = join(root, "src");
  const testDir = join(root, "test");
  await mkdir(src);
  await mkdir(testDir);
  await writeFile(join(src, "Plain.Codeunit.al"), PLAIN_AL);
  await writeFile(join(testDir, "T.Codeunit.al"), testSrc);
  const warnings: { code: string; message: string }[] = [];
  const b = new AlRunnerV3Backend(
    {
      alRunnerPath: "/fake/al-runner",
      instrumentedDir: join(root, "scratch"),
      testDir,
      packagesDir: join(root, "deps"),
      bcVersion: "28.0.46665.47126",
      selectorObjectId: 50001,
      alcPath: "/fake/alc",
      coverage: "none",
      sourceProjectDir: src,
      transport: "serve-entries",
      transportSource: "default",
    },
    async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  );
  b.setNotify((code, message) => warnings.push({ code, message }));
  (b as unknown as { build: unknown }).build = {
    version: "alrunner 3.0.0-alpha.5 (abcdef012)",
    binarySha256: "0",
  };
  b.useDiscoveredTests(PLAIN_TESTS);
  return { b, warnings };
}

describe("R761: the shape scan covers the test folder", () => {
  test("a multi-object file only in testDir falls back", async () => {
    const { b, warnings } = await backend(MULTI_AL);
    await b.decideTransport({ resume: false });
    expect(b.inRunStopIsBudget).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("multi-object-or-wrapped: T.Codeunit.al");
  });
});
