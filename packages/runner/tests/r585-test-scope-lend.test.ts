// R585: `--skip-known-survivors` lends the latest finished run's survivors without reading that
// run's test scope. A run scoped by `--tests-only` never ran the tests it excluded, so its
// "survivors" may be killed by one of them; a later session over the full suite must not skip them.
// Written test-first: the narrower-scope case is RED on master (it lends today); the equal- and
// wider-scope controls are green and must stay green. `--resume` is proven to refuse a scope change
// (by `config_fingerprint`), which R585 says and nothing tested through the real path.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import type { MicrosoftMode } from "../src/digest-inputs";
import type { RunEvent } from "../src/events";
import { runSession } from "../src/orchestrator";
import type { SessionReport } from "../src/report";
import { ResultsStore } from "../src/store";
import { measuredV2_12 } from "./helpers/al-runner-predefined";
import { servedIsInstalled, testAppJson, testAppPackage } from "./helpers/proven-test-app";
import { scratchDirs } from "./helpers/scratch";

const scratch = scratchDirs();

const TARGET_AL = `codeunit 79000 "Sandbox Logic"
{
    procedure IsOverBudget(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount > Budget);
    end;
}
`;
/** Runs under the narrow scope; never kills. */
const NARROW_AL = `codeunit 79100 "Narrow Tests"
{
    Subtype = Test;

    [Test]
    procedure Weak()
    begin
    end;
}
`;
/** Excluded by the narrow scope; kills every mutant (when the backend lets it). */
const KILLER_AL = `codeunit 79101 "Killer Tests"
{
    Subtype = Test;

    [Test]
    procedure Strong()
    begin
    end;
}
`;
const APP_JSON = JSON.stringify({
  id: "6d0f4a2e-1c3b-4a8d-9f10-2b7c5e4d3a91",
  name: "Sandbox R585 Fixture",
  publisher: "LethAL",
  version: "1.0.0.0",
  idRanges: [{ from: 79000, to: 79199 }],
});
const NARROW = ["NarrowTests.Codeunit.al"];

/** al-runner shape (R619's Stub): `Killer Tests` fails under any mutant when `killerKills`. */
class Stub implements ExecutionBackend {
  mutantRuns = 0;
  private active: string | null = null;
  readonly measurePredefinedSymbols = measuredV2_12;
  constructor(
    private readonly killerKills: boolean,
    private readonly abortAfter?: number,
  ) {}
  capabilities(): BackendCapabilities {
    return {
      kind: "al-runner",
      coverage: "none",
      deploy: "none",
      isolation: "session",
      authoritative: false,
    };
  }
  microsoftMode(): MicrosoftMode {
    return servedIsInstalled(() => testAppPackage());
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "stub" };
  }
  async deploy(): Promise<null> {
    return null;
  }
  async compileCheck(): Promise<void> {}
  async activate(id: string | null): Promise<void> {
    this.active = id;
  }
  async run(ref: TestMethodRef): Promise<TestVerdict> {
    if (this.active === null) return { ref, outcome: "pass", durationMs: 5 };
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
    const kills = this.killerKills && ref.codeunitName === "Killer Tests";
    return {
      ref,
      outcome: kills ? "fail" : "pass",
      durationMs: 5,
      ...(kills ? { failureMessage: "Assert.AreEqual failed" } : {}),
      attestation: { observedAny: true, identityMismatch: false },
    };
  }
}

async function project() {
  const root = scratch("lethal-r585-");
  const dirs = {
    projectDir: join(root, "app"),
    testDir: join(root, "tests"),
    instrumentedDir: join(root, "instr"),
  };
  await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), TARGET_AL);
  await Bun.write(join(dirs.projectDir, "app.json"), APP_JSON);
  await Bun.write(join(dirs.testDir, "NarrowTests.Codeunit.al"), NARROW_AL);
  await Bun.write(join(dirs.testDir, "KillerTests.Codeunit.al"), KILLER_AL);
  await Bun.write(join(dirs.testDir, "app.json"), testAppJson());
  return dirs;
}
type Dirs = Awaited<ReturnType<typeof project>>;
const base = (store: ResultsStore, dirs: Dirs) => ({
  store,
  ...dirs,
  selectorIds: { selectorId: 50000, controlId: 50001, tableId: 50002 },
  stopHungSessions: true,
  mutantTimeoutMs: 2_000,
});
const scope = (s: readonly string[] | undefined) => (s !== undefined ? { testsOnly: s } : {});
const known = (r: SessionReport) => r.mutants.filter((m) => m.verdict === "known-survivor");
const historyWarnings = (events: readonly RunEvent[]) =>
  events.flatMap((e) => (e.type === "warning" && e.code.startsWith("history-") ? [e] : []));

/** A finished run under `source` scope, then a `--skip-known-survivors` session under `session`. */
async function history(opts: {
  source: readonly string[] | undefined;
  session: readonly string[] | undefined;
  /** Whether the excluded test kills in the SOURCE run (false makes a full-suite run survive). */
  sourceKills: boolean;
}) {
  const dirs = await project();
  const store = new ResultsStore(":memory:");
  const r1 = await runSession({
    ...base(store, dirs),
    ...scope(opts.source),
    backend: new Stub(opts.sourceKills),
  });
  const events: RunEvent[] = [];
  const backend = new Stub(true);
  const report = await runSession({
    ...base(store, dirs),
    ...scope(opts.session),
    backend,
    skipKnownSurvivors: true,
    emit: [(e) => events.push(e)],
  });
  store.close();
  return { r1, report, events, backend };
}

describe("R585: a --tests-only run's survivors are not lent to a wider session", () => {
  test("narrower source, full-suite session: nothing is skipped, the excluded test kills (RED on master)", async () => {
    const h = await history({ source: NARROW, session: undefined, sourceKills: true });
    // The source run really did score survivors (the killer was excluded).
    expect(h.r1.counts.survived).toBeGreaterThan(0);
    expect(h.r1.counts.killed).toBe(0);
    // Desired: refused by name, every mutant executed, and killed by `Killer Tests`.
    expect(known(h.report)).toEqual([]);
    expect(h.report.counts.killed).toBe(h.r1.counts.survived);
    expect(historyWarnings(h.events).map((e) => e.code)).toEqual(["history-test-scope-changed"]);
  });

  test("equal scope (both narrow): the survivors still lend", async () => {
    const h = await history({ source: NARROW, session: NARROW, sourceKills: true });
    expect(h.r1.counts.survived).toBeGreaterThan(0);
    expect(known(h.report)).toHaveLength(h.r1.counts.survived);
    expect(h.backend.mutantRuns).toBe(0);
    expect(historyWarnings(h.events)).toEqual([]);
  });

  test("wider source (full suite), narrow session: the survivors still lend", async () => {
    const h = await history({ source: undefined, session: NARROW, sourceKills: false });
    expect(h.r1.counts.survived).toBeGreaterThan(0);
    expect(known(h.report)).toHaveLength(h.r1.counts.survived);
    expect(historyWarnings(h.events)).toEqual([]);
  });

  test("a narrower scope ALSO in the pattern set (another narrow pattern): refused", async () => {
    // Source admits only Narrow; session admits only Killer. Neither is wider: refuse.
    const h = await history({
      source: NARROW,
      session: ["KillerTests.Codeunit.al"],
      sourceKills: true,
    });
    expect(known(h.report)).toEqual([]);
  });
});

describe("R585: --resume refuses a --tests-only change (config_fingerprint), through runSession", () => {
  async function aborted(source: readonly string[] | undefined) {
    const dirs = await project();
    const store = new ResultsStore(":memory:");
    await runSession({ ...base(store, dirs), ...scope(source), backend: new Stub(false, 1) });
    const runId = (store.db.query("SELECT MAX(id) AS id FROM runs").get() as { id: number }).id;
    const finished = store.db.query("SELECT finished_at FROM runs WHERE id = ?").get(runId) as {
      finished_at: string | null;
    };
    expect(finished.finished_at).toBeNull();
    return { dirs, store, runId };
  }
  const resumeWith = async (
    a: Awaited<ReturnType<typeof aborted>>,
    session: readonly string[] | undefined,
    how: "last" | number,
  ) => {
    try {
      await runSession({
        ...base(a.store, a.dirs),
        ...scope(session),
        backend: new Stub(true),
        resume: how,
      });
      return undefined;
    } catch (err) {
      return (err as Error).message;
    } finally {
      a.store.close();
    }
  };

  test("--resume last: a narrow run is not found by a full-suite session", async () => {
    const a = await aborted(NARROW);
    expect(await resumeWith(a, undefined, "last")).toMatch(/--resume found no unfinished run/);
  });
  test("--resume-run <id>: refused as scoped differently", async () => {
    const a = await aborted(NARROW);
    expect(await resumeWith(a, undefined, a.runId)).toMatch(/fingerprint|scoped differently/i);
  });
  test("control: the same scope resumes", async () => {
    const a = await aborted(NARROW);
    expect(await resumeWith(a, NARROW, "last")).toBeUndefined();
  });
});
