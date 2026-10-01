import { afterAll, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { IDENTITY_SCHEME } from "@lethal/schemata";
import type {
  BackendCapabilities,
  BackendStatus,
  CoverageMode,
  ExecutionBackend,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import type { RunEvent } from "../src/events";
import { runSession } from "../src/orchestrator";
import type { SessionReport } from "../src/report";
import { sessionFingerprint } from "../src/resume";
import { ResultsStore } from "../src/store";

// R214 Task 8: history, resume and marks apply only between runs built under the IDENTICAL
// effective symbol set (C1), and the scheme N-1 to N transition on the same-text key (I4).

const HERE = import.meta.dir;
const R214 = join(HERE, "fixtures", "r214");
const REPO = resolve(HERE, "../../..");
type ReportMutant = SessionReport["mutants"][number];

const CAPS: BackendCapabilities = {
  coverage: "procedure",
  deploy: "publish",
  isolation: "session",
  authoritative: true,
};

// Inside the fixture's own id range (79600..79649).
const selectorIds = { selectorId: 79647, controlId: 79648, tableId: 79649 };

/** Every test passes, so every covered mutant survives; the baseline covers `Rate`. */
class SurvivingBackend implements ExecutionBackend {
  private active: string | null = null;
  capabilities(): BackendCapabilities {
    return CAPS;
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
    return {
      ref,
      outcome: "pass",
      durationMs: 5,
      ...(this.active === null
        ? {
            coverage: {
              granularity: "procedure" as const,
              entries: [{ objectType: "Codeunit", objectId: 79600, procedure: "Rate" }],
            },
          }
        : { attestation: { observedAny: true, identityMismatch: false } }),
    };
  }
}

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

/** A private copy of the R321 fixture pair, so a run never writes next to the committed one. */
async function makeSymbolsProject() {
  const root = await mkdtemp(join(tmpdir(), "lethal-r214-hist-"));
  roots.push(root);
  const projectDir = join(root, "app");
  const testDir = join(root, "tests");
  await cp(join(REPO, "fixtures", "sandbox-symbols"), projectDir, { recursive: true });
  await cp(join(REPO, "fixtures", "sandbox-symbols-tests"), testDir, { recursive: true });
  return { projectDir, testDir, instrumentedDir: join(root, "instr") };
}

/** The pre-committed key text of the arm pair's `return-value` under `set`, read from the committed
 *  expected capture, never typed here. Under the new scheme it is the SAME text for L13 under
 *  [LETHALA] and L15 under [LETHALB] (measured, the R-214 plan). */
async function armKey(index: 1 | 2): Promise<string> {
  const text = await readFile(
    join(R214, "expected", `fixture-sandbox-symbols.${index}.txt`),
    "utf8",
  );
  const row = text.split("\n").find((l) => l.includes("\tlethal.return-value\t"));
  const key = row?.split("\t")[4];
  if (key === undefined) throw new Error("no return-value row");
  return key;
}

function armOf(report: SessionReport, line: 13 | 15): ReportMutant {
  const hits = report.mutants.filter(
    (m) => m.line === line && m.operatorName === "lethal.return-value",
  );
  if (hits.length !== 1 || hits[0] === undefined)
    throw new Error(`no single L${line} return-value`);
  return hits[0];
}

/** A real CURRENT-engine run under `symbols`, at the current scheme, as it was recorded;
 *  `finished: false` clears its finish so it is resumable. It never takes a scheme: an old-scheme
 *  record is `oldEngineRun`'s, never a relabelled current-engine run (r3, I2). */
async function storedRun(opts: { symbols: string[]; finished: boolean }) {
  const dirs = await makeSymbolsProject();
  const store = new ResultsStore(":memory:");
  await runSession({
    backend: new SurvivingBackend(),
    store,
    ...dirs,
    selectorIds,
    preprocessorSymbols: opts.symbols,
  });
  const run = store.db.query("SELECT id FROM runs").get() as { id: number };
  if (!opts.finished) store.db.run("UPDATE runs SET finished_at = NULL WHERE id = ?", [run.id]);
  return { dirs, store, runId: run.id };
}

// Built rather than written whole, so the repo's line-citation check (R117) does not read the
// capture's row prefix as a `file:line` pointer.
const OLD_SITE_FILE = ["src/SymbolLogic.Codeunit", "al"].join(".");

/** The OLD engine's record, from committed files only (Task 1 Step 5b): master's own L13
 *  `return-value` key and line from the BEFORE capture, and the starting scheme `S`. Neither is
 *  derived from IDENTITY_SCHEME, so reverting the constant cannot move both sides (r3, I2). */
async function oldEngineKey(): Promise<{ scheme: number; key: string; line: number }> {
  const { identityScheme } = JSON.parse(
    await readFile(join(R214, "before", "scheme.json"), "utf8"),
  ) as { identityScheme: number };
  const text = await readFile(join(R214, "before", "fixture-sandbox-symbols.txt"), "utf8");
  const row = text
    .split("\n")
    .find((l) => l.startsWith(`${OLD_SITE_FILE}:13\tlethal.return-value\t`));
  const key = row?.split("\t")[4];
  if (key === undefined) throw new Error("no L13 return-value row in the BEFORE capture");
  return { scheme: identityScheme, key, line: 13 };
}

/**
 * A run the OLD engine made under [LETHALB]: one row, master's L13 `return-value` key and line,
 * verdict `survived` (the frozen R321 [LETHALB] baseline scores that compiled-out mutant exactly
 * so). Written through the store API, beside one real current-engine run whose project path,
 * backend, coverage mode and test app it copies, so it is found as the same project and differs
 * from that run only where the test says. It is created AFTER that run, so it is the latest.
 * `buildSymbols` is B by default, so the scheme is its ONLY difference from the current-scheme
 * control; `null` is the shape a real pre-R214 row has.
 */
async function oldEngineRun(opts: { finished: boolean; buildSymbols?: readonly string[] | null }) {
  const old = await oldEngineKey();
  const dirs = await makeSymbolsProject();
  const store = new ResultsStore(":memory:");
  await runSession({
    backend: new SurvivingBackend(),
    store,
    ...dirs,
    selectorIds,
    preprocessorSymbols: B,
  });
  const real = store.db
    .query("SELECT project_path, backend, coverage_mode, test_app_hash FROM runs")
    .get() as {
    project_path: string;
    backend: string;
    coverage_mode: CoverageMode;
    test_app_hash: string | null;
  };
  const buildSymbols = opts.buildSymbols === undefined ? B : opts.buildSymbols;
  const runId = store.createRun({
    projectPath: real.project_path,
    backend: real.backend,
    appVersion: "1.0.0.0",
    identityScheme: old.scheme,
    buildSymbols: buildSymbols ?? [],
    coverageMode: real.coverage_mode,
    ...(real.test_app_hash !== null ? { testAppHash: real.test_app_hash } : {}),
    configFingerprint: sessionFingerprint({
      projectDir: dirs.projectDir,
      testDir: dirs.testDir,
      backend: real.backend,
      skipKnownSurvivors: false,
      selectorIds,
      identityScheme: old.scheme,
      coverageMode: real.coverage_mode,
      preprocessorSymbols: B,
    }),
  });
  if (buildSymbols === null)
    store.db.run("UPDATE runs SET build_symbols = NULL WHERE id = ?", [runId]);
  const [astHash = "", codeunitName = "", procedureName = "", operatorName = "", major = ""] =
    old.key.split("|");
  store.recordMutant(runId, {
    mutantCode: "M0010",
    astHash,
    codeunitName,
    procedureName,
    operatorName,
    operatorMajor: Number(major),
    identityOrdinal: 0,
    file: "src/SymbolLogic.Codeunit.al",
    line: old.line,
    verdict: "survived",
    durationMs: 1,
    batchIndex: 0,
  });
  if (opts.finished) store.finishRun(runId, { batchCount: 1, baselineGreen: true });
  return { dirs, store, runId, old };
}

const B = ["LETHALB"];

describe("R214 C1: the same key text names a different site in another build", () => {
  test("pin: L13 under [LETHALA] and L15 under [LETHALB] carry identical key text", async () => {
    expect(await armKey(1)).toBe(await armKey(2));
  });

  test("history: a [LETHALA] survivor is not skipped in a [LETHALB] run, and the run says why", async () => {
    const { dirs, store, runId } = await storedRun({ symbols: ["LETHALA"], finished: true });
    const events: RunEvent[] = [];
    const report = await runSession({
      backend: new SurvivingBackend(),
      store,
      ...dirs,
      selectorIds,
      preprocessorSymbols: B,
      skipKnownSurvivors: true,
      emit: [(e) => events.push(e)],
    });
    expect(armOf(report, 15).verdict).toBe("survived");
    const w = events.flatMap((e) =>
      e.type === "warning" && e.code === "history-build-symbols-changed" ? [e.message] : [],
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toContain(`run ${runId}`);
    expect(w[0]).toContain("LETHALA");
    expect(w[0]).toContain("LETHALB");
  });

  test("history control: a [LETHALB] survivor IS skipped in a [LETHALB] run", async () => {
    const { dirs, store } = await storedRun({ symbols: B, finished: true });
    const report = await runSession({
      backend: new SurvivingBackend(),
      store,
      ...dirs,
      selectorIds,
      preprocessorSymbols: B,
      skipKnownSurvivors: true,
    });
    expect(armOf(report, 15).verdict).toBe("known-survivor");
  });

  test("the run row records the effective set, not NULL", async () => {
    const { store, runId } = await storedRun({ symbols: B, finished: true });
    expect(store.getRun(runId)?.buildSymbols).toEqual(["LETHALB"]);
  });

  test("--resume-run of a [LETHALA] run is refused by name in a [LETHALB] session", async () => {
    const { dirs, store, runId } = await storedRun({ symbols: ["LETHALA"], finished: false });
    await expect(
      runSession({
        backend: new SurvivingBackend(),
        store,
        ...dirs,
        selectorIds,
        preprocessorSymbols: B,
        resume: runId,
      }),
    ).rejects.toThrow(
      new RegExp(
        `--resume-run ${runId} was built with preprocessor symbols LETHALA.*LETHALB.*R214`,
      ),
    );
  });

  test("--resume-run control: the same set resumes", async () => {
    const { dirs, store, runId } = await storedRun({ symbols: B, finished: false });
    const report = await runSession({
      backend: new SurvivingBackend(),
      store,
      ...dirs,
      selectorIds,
      preprocessorSymbols: B,
      resume: runId,
    });
    expect(armOf(report, 15).verdict).toBe("survived");
  });

  test("--resume last names the [LETHALA] run instead of reporting none found", async () => {
    const { dirs, store, runId } = await storedRun({ symbols: ["LETHALA"], finished: false });
    await expect(
      runSession({
        backend: new SurvivingBackend(),
        store,
        ...dirs,
        selectorIds,
        preprocessorSymbols: B,
        resume: "last",
      }),
    ).rejects.toThrow(new RegExp(`run ${runId}, .*preprocessor symbols LETHALA.*LETHALB.*R214`));
  });

  test("--resume last control: the same set resumes", async () => {
    const { dirs, store } = await storedRun({ symbols: B, finished: false });
    const report = await runSession({
      backend: new SurvivingBackend(),
      store,
      ...dirs,
      selectorIds,
      preprocessorSymbols: B,
      resume: "last",
    });
    expect(armOf(report, 15).verdict).toBe("survived");
  });

  async function markedRun(markSymbols: string[] | undefined) {
    const dirs = await makeSymbolsProject();
    return runSession({
      backend: new SurvivingBackend(),
      store: new ResultsStore(":memory:"),
      ...dirs,
      selectorIds,
      preprocessorSymbols: B,
      equivalenceMarks: [
        {
          key: await armKey(2),
          reason: "same either way",
          identityScheme: IDENTITY_SCHEME,
          ...(markSymbols !== undefined ? { preprocessorSymbols: markSymbols } : {}),
        },
      ],
    });
  }

  test("marks: a mark made under [LETHALA] does not mark [LETHALB]'s L15 (stale)", async () => {
    const report = await markedRun(["LETHALA"]);
    expect(armOf(report, 15).readerMark).toBeUndefined();
    expect(report.readerMarkedEquivalent?.stale).toEqual([await armKey(2)]);
  });

  test("marks: a mark with no symbols applies only to a build with none (stale here)", async () => {
    const report = await markedRun(undefined);
    expect(armOf(report, 15).readerMark).toBeUndefined();
  });

  test("marks control: the same mark under [LETHALB] marks it", async () => {
    const report = await markedRun(B);
    expect(armOf(report, 15).readerMark).toBeDefined();
  });
});

describe("R214 I4: an old-engine record never reaches a current-scheme mutant with the same key text", () => {
  // The old side is master's own record (oldEngineKey); the new side is IDENTITY_SCHEME. No number
  // is written here (task.md Addendum), and IDENTITY_SCHEME - 1 is never used (r3, I2).

  test("pin: the old engine's L13 key is the text the new engine gives L15 under [LETHALB]; the scheme moved", async () => {
    const old = await oldEngineKey();
    expect(old.key).toBe(await armKey(2));
    expect(IDENTITY_SCHEME).toBeGreaterThan(old.scheme);
  });

  test("history: the old L13 survivor is not skipped at the new L15, and the run names the scheme", async () => {
    const { dirs, store, runId, old } = await oldEngineRun({ finished: true });
    const events: RunEvent[] = [];
    const report = await runSession({
      backend: new SurvivingBackend(),
      store,
      ...dirs,
      selectorIds,
      preprocessorSymbols: B,
      skipKnownSurvivors: true,
      emit: [(e) => events.push(e)],
    });
    expect(armOf(report, 15).verdict).toBe("survived");
    const w = events.flatMap((e) =>
      e.type === "warning" && e.code === "history-identity-scheme-changed" ? [e.message] : [],
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toContain(`run ${runId}`);
    expect(w[0]).toContain(`identity scheme ${old.scheme}`);
  });

  test("history: the real pre-R214 row shape (build_symbols NULL) is not skipped either", async () => {
    const { dirs, store } = await oldEngineRun({ finished: true, buildSymbols: null });
    const report = await runSession({
      backend: new SurvivingBackend(),
      store,
      ...dirs,
      selectorIds,
      preprocessorSymbols: B,
      skipKnownSurvivors: true,
    });
    expect(armOf(report, 15).verdict).toBe("survived");
  });

  test("history control: a current-engine, current-scheme survivor IS skipped (the key collides)", async () => {
    const { dirs, store } = await storedRun({ symbols: B, finished: true });
    const report = await runSession({
      backend: new SurvivingBackend(),
      store,
      ...dirs,
      selectorIds,
      preprocessorSymbols: B,
      skipKnownSurvivors: true,
    });
    expect(armOf(report, 15).verdict).toBe("known-survivor");
  });

  test("--resume-run of the old run is refused, naming both schemes and R325", async () => {
    const { dirs, store, runId, old } = await oldEngineRun({ finished: false });
    await expect(
      runSession({
        backend: new SurvivingBackend(),
        store,
        ...dirs,
        selectorIds,
        preprocessorSymbols: B,
        resume: runId,
      }),
    ).rejects.toThrow(
      new RegExp(
        `--resume-run ${runId} was keyed under identity scheme ${old.scheme}.*scheme ${IDENTITY_SCHEME}.*R325`,
      ),
    );
  });

  test("--resume last names the old run", async () => {
    const { dirs, store, runId, old } = await oldEngineRun({ finished: false });
    await expect(
      runSession({
        backend: new SurvivingBackend(),
        store,
        ...dirs,
        selectorIds,
        preprocessorSymbols: B,
        resume: "last",
      }),
    ).rejects.toThrow(
      new RegExp(`run ${runId}, .*identity scheme ${old.scheme}.*scheme ${IDENTITY_SCHEME}.*R325`),
    );
  });

  test("marks: an old-scheme mark on the old key is stale; control: the current scheme marks it", async () => {
    const dirs = await makeSymbolsProject();
    const old = await oldEngineKey();
    const key = old.key;
    const run = (identityScheme: number) =>
      runSession({
        backend: new SurvivingBackend(),
        store: new ResultsStore(":memory:"),
        ...dirs,
        selectorIds,
        preprocessorSymbols: B,
        equivalenceMarks: [
          { key, reason: "same either way", identityScheme, preprocessorSymbols: B },
        ],
      });
    expect(armOf(await run(old.scheme), 15).readerMark).toBeUndefined();
    expect(armOf(await run(IDENTITY_SCHEME), 15).readerMark).toBeDefined();
  });
});
