import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { tier1Operators } from "@lethal/builtin-tier1";
import {
  type ALSyntaxNode,
  type MutationSpec,
  buildSemanticContext,
  initParser,
  parseAL,
  visit,
  wrapRoot,
} from "@lethal/engine";
import {
  type InstrumentedFile,
  type MutantManifest,
  type MutantManifestEntry,
  type SelectorConfig,
  writeInstrumentedProject,
} from "@lethal/schemata";
import type { ExecutionBackend, TestMethodRef, TestVerdict } from "./backend";
import { discoverTests } from "./discovery";
import { buildReport } from "./report";
import type { SessionOutcome, SessionReport } from "./report";
import {
  type OverlapSite,
  batchByOverlap,
  buildCoverageIndex,
  coverageFilter,
  filterHistory,
  identityKeyOf,
  testKeyOf,
} from "./selection";
import type { ResultsStore } from "./store";
import type { MutantVerdict } from "./store";

const BASELINE_TIMEOUT_DEFAULT = 120_000;

/**
 * Parse every `.al` file under `projectDir` (skipping emitted `Mutation*`
 * artifacts) and run the Tier 1 operator set over each. Mirrors the
 * ops -> compile -> write pipeline exercised by
 * `packages/builtin-tier1/tests/end-to-end.test.ts`: build a per-file
 * semantic context, walk the tree, and collect every spec each operator
 * targets. Overlap resolution is deliberately NOT done here — that is
 * `batchByOverlap`'s job downstream, since overlapping mutants still need to
 * run, just in separate batches.
 */
export async function generateMutationSet(projectDir: string): Promise<InstrumentedFile[]> {
  await initParser();
  const files: InstrumentedFile[] = [];
  const entries = (await readdir(projectDir, { recursive: true }))
    .filter((e) => e.toLowerCase().endsWith(".al"))
    .filter((e) => !basename(e).startsWith("Mutation"));
  for (const rel of entries.sort()) {
    const source = await readFile(join(projectDir, rel), "utf8");
    const root = wrapRoot(parseAL(source));
    const ctx = buildSemanticContext([{ path: rel, root }]);
    const specs: MutationSpec[] = [];
    visit(root, (node) => {
      for (const op of tier1Operators) {
        if (op.targets(node, ctx)) {
          for (const spec of op.generate(node, ctx)) specs.push(spec);
        }
      }
    });
    if (specs.length > 0) files.push({ path: rel, source, root, specs });
  }
  return files;
}

export interface SessionConfig {
  readonly backend: ExecutionBackend;
  readonly store: ResultsStore;
  readonly projectDir: string; // target AL project (source of truth)
  readonly testDir: string;
  readonly instrumentedDir: string; // scratch output dir for schemata writes
  readonly selectorIds: SelectorConfig;
  readonly baselineTimeoutMs?: number; // default 120000
  readonly skipKnownSurvivors?: boolean;
  readonly appVersion?: string; // stamped into runs; default "0.0.0.0"
}

/** Alias kept for readability at call sites within this module. */
type SessionVerdict = MutantVerdict;

interface SiteEntry extends OverlapSite {
  readonly spec: MutationSpec;
  readonly sourceFile: InstrumentedFile;
}

export async function runSession(cfg: SessionConfig): Promise<SessionReport> {
  const caps = cfg.backend.capabilities();
  const status = await cfg.backend.status();
  if (!status.ok) throw new Error(`backend not ready: ${status.details}`);

  const tests = await discoverTests(cfg.testDir);
  if (tests.length === 0) throw new Error("no tests discovered");

  const runId = cfg.store.createRun({
    projectPath: cfg.projectDir,
    backend: caps.authoritative ? "bcdev" : "al-runner",
    appVersion: cfg.appVersion ?? "0.0.0.0",
  });

  const allFiles = await generateMutationSet(cfg.projectDir);
  const allSpecs: SiteEntry[] = allFiles.flatMap((f) =>
    f.specs.map((spec) => ({
      file: f.path,
      startIndex: spec.before.startIndex,
      endIndex: spec.before.endIndex,
      spec,
      sourceFile: f,
    })),
  );
  const specBatches = batchByOverlap(allSpecs);

  const outcomes: SessionOutcome[] = []; // internal accumulation for the report
  let baselineGreenOverall = true;

  try {
    for (const [batchIdx, batchSpecs] of specBatches.entries()) {
      // 1. write instrumented project for THIS batch's specs only
      const byFile = new Map<
        string,
        { source: string; root: ALSyntaxNode; specs: MutationSpec[] }
      >();
      for (const s of batchSpecs) {
        const existing = byFile.get(s.file);
        if (existing) existing.specs.push(s.spec);
        else
          byFile.set(s.file, {
            source: s.sourceFile.source,
            root: s.sourceFile.root,
            specs: [s.spec],
          });
      }
      const batchFiles: InstrumentedFile[] = [...byFile.entries()].map(([path, v]) => ({
        path,
        source: v.source,
        root: v.root,
        specs: v.specs,
      }));
      const batchDir = join(cfg.instrumentedDir, `batch-${batchIdx}`);
      await writeInstrumentedProject({
        targetDir: batchDir,
        files: batchFiles,
        selectorIds: cfg.selectorIds,
      });
      const manifest = JSON.parse(
        await readFile(join(batchDir, "mutant-manifest.json"), "utf8"),
      ) as MutantManifest;

      // 2. history filter
      const prior = cfg.store.priorSurvivorKeys(cfg.projectDir);
      const { execute, knownSurvivors } = filterHistory([...manifest.mutants], prior, {
        skipKnownSurvivors: cfg.skipKnownSurvivors ?? false,
      });
      for (const m of knownSurvivors) record(cfg.store, runId, m, "known-survivor", outcomes);

      // 3. deploy — always, even for in-memory backends: they need the
      // per-batch instrumented dir just as much as a publishing backend
      // needs the compiled app. `capabilities().deploy` still describes
      // publish cost for callers, it just no longer gates this call.
      try {
        await cfg.backend.deploy(batchDir);
      } catch (err) {
        for (const m of execute)
          record(cfg.store, runId, m, "error", outcomes, undefined, String(err));
        continue; // batch aborted, next batch still attempted
      }

      // 4. baseline
      await activateWithRetry(cfg.backend, null);
      const baseline: Array<{ ref: TestMethodRef; verdict: TestVerdict }> = [];
      for (const ref of tests) {
        const v = await runWithRetry(cfg.backend, ref, {
          coverage: caps.coverage,
          timeoutMs: cfg.baselineTimeoutMs ?? BASELINE_TIMEOUT_DEFAULT,
        });
        cfg.store.recordTestResult(runId, null, ref, v.outcome, v.durationMs, v.failureMessage);
        baseline.push({ ref, verdict: v });
      }
      const greenTests = baseline.filter((b) => b.verdict.outcome === "pass");
      if (greenTests.length < baseline.length) baselineGreenOverall = false;
      if (greenTests.length === 0) {
        for (const m of execute) {
          record(cfg.store, runId, m, "error", outcomes, undefined, "no green baseline tests");
        }
        continue;
      }
      const baselineDuration = new Map(
        greenTests.map((b) => [testKeyOf(b.ref), b.verdict.durationMs]),
      );

      // 5. coverage filter (capability-gated)
      let perMutantTests: ReadonlyMap<string, readonly TestMethodRef[]>;
      let uncovered: readonly MutantManifestEntry[] = [];
      if (caps.coverage === "none") {
        perMutantTests = new Map(execute.map((m) => [m.mutantId, greenTests.map((b) => b.ref)]));
      } else {
        const index = buildCoverageIndex(
          greenTests.map((b) => ({
            ref: b.ref,
            ...(b.verdict.coverage !== undefined ? { coverage: b.verdict.coverage } : {}),
          })),
        );
        const split = coverageFilter(
          execute,
          index,
          greenTests.map((b) => b.ref),
        );
        perMutantTests = split.covered;
        uncovered = split.uncovered;
      }
      for (const m of uncovered) record(cfg.store, runId, m, "no-coverage", outcomes);

      // 6. per-mutant loop
      for (const m of execute) {
        const covering = perMutantTests.get(m.mutantId);
        if (covering === undefined) continue; // uncovered, already recorded above
        if (covering.length === 0) {
          // Defensive: the covering-test list resolved to zero refs (e.g. a
          // coverage index key whose tests no longer exist in `greenTests`).
          // Treat it the same as "no coverage" rather than silently
          // reporting "survived" for a mutant nothing actually ran against.
          record(cfg.store, runId, m, "no-coverage", outcomes);
          continue;
        }
        await activateWithRetry(cfg.backend, m.mutantId);
        let verdict: SessionVerdict = "survived";
        let killingTest: string | undefined;
        let failureNote: string | undefined;
        let spent = 0;
        for (const ref of covering) {
          const budget =
            2 *
            (baselineDuration.get(testKeyOf(ref)) ??
              cfg.baselineTimeoutMs ??
              BASELINE_TIMEOUT_DEFAULT);
          const v = await runWithRetry(cfg.backend, ref, { coverage: "none", timeoutMs: budget });
          cfg.store.recordTestResult(
            runId,
            m.mutantId,
            ref,
            v.outcome,
            v.durationMs,
            v.failureMessage,
          );
          spent += v.durationMs;
          if (v.outcome === "timeout") {
            verdict = "timeout-killed";
            killingTest = ref.method;
            break;
          }
          if (v.outcome === "error") {
            verdict = "error";
            failureNote = v.failureMessage;
            break;
          }
          if (v.outcome === "fail") {
            await activateWithRetry(cfg.backend, null);
            const confirm = await runWithRetry(cfg.backend, ref, {
              coverage: "none",
              timeoutMs: budget,
            });
            cfg.store.recordTestResult(
              runId,
              null,
              ref,
              confirm.outcome,
              confirm.durationMs,
              confirm.failureMessage,
            );
            if (confirm.outcome === "pass") {
              verdict = "killed";
              killingTest = ref.method;
            } else {
              verdict = "error";
              failureNote = `unstable test ${ref.method}: fails at baseline confirmation`;
            }
            break;
          }
        }
        record(cfg.store, runId, m, verdict, outcomes, killingTest, failureNote, spent);
      }
    }
  } finally {
    // Best-effort cleanup: deliberately swallow errors here (unlike the
    // retrying activation calls above) since this only runs to leave the
    // backend deactivated on exit, and a failure here must not mask/replace
    // whatever real error is already propagating.
    await cfg.backend.activate(null).catch(() => {});
  }

  cfg.store.finishRun(runId, {
    batchCount: specBatches.length,
    baselineGreen: baselineGreenOverall,
  });
  return buildReport({
    caps,
    baselineGreen: baselineGreenOverall,
    batches: specBatches.length,
    outcomes,
  });
}

/**
 * One retry on activation failure; if the retry also fails, the error
 * propagates and aborts the session (the `finally` in `runSession` still
 * attempts a best-effort deactivation, and results recorded so far remain
 * persisted in the store since they're written incrementally).
 */
async function activateWithRetry(
  backend: ExecutionBackend,
  mutantId: string | null,
): Promise<void> {
  try {
    await backend.activate(mutantId);
  } catch {
    await backend.activate(mutantId);
  }
}

async function runWithRetry(
  backend: ExecutionBackend,
  ref: TestMethodRef,
  opts: { coverage: "none" | "procedure" | "line"; timeoutMs: number },
): Promise<TestVerdict> {
  const first = await backend.run(ref, opts);
  if (first.outcome !== "error") return first;
  return backend.run(ref, opts); // one retry on transport error, then the error stands
}

function record(
  store: ResultsStore,
  runId: number,
  m: MutantManifestEntry,
  verdict: MutantVerdict,
  outcomes: SessionOutcome[],
  killingTest?: string,
  failureNote?: string,
  durationMs = 0,
): void {
  const key = identityKeyOf(m);
  store.recordMutant(runId, {
    mutantCode: m.mutantId,
    astHash: key.astHash,
    codeunitName: key.codeunitName,
    operatorName: key.operatorName,
    operatorMajor: key.operatorMajor,
    file: m.file,
    line: m.startLine,
    verdict,
    durationMs,
    ...(killingTest !== undefined ? { killingTest } : {}),
  });
  outcomes.push({
    mutant: m,
    verdict,
    ...(killingTest !== undefined ? { killingTest } : {}),
    ...(failureNote !== undefined ? { failureNote } : {}),
  });
}
