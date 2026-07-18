import { access, copyFile, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tier1Operators } from "@lethal/builtin-tier1";
import {
  type ALSyntaxNode,
  type MutationSpec,
  buildSemanticContext,
  findEnclosingStatement,
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

/**
 * The range `batchByOverlap` must treat as "claimed" by this spec — NOT
 * always `spec.before`'s own range.
 *
 * `schemata`'s compiler (`compile.ts`'s `applyWrap`/`applyDuplicate`, used
 * for `statement-position`/`short-circuit-operand` specs) doesn't rewrite
 * `spec.before` directly: it walks up to the narrowest *enclosing statement*
 * (`findEnclosingStatement`) and replaces that whole statement. Two specs
 * whose `before` nodes are disjoint sub-expressions of the SAME statement
 * (e.g. `conditional-boundary` firing on both sides of
 * `(Value < 0) or (Value > 100)`) therefore don't overlap by `before`
 * range, but collide at compile time on the same statement node
 * (`compileSchemataForFile`'s "two specs resolved to the same AST node"
 * throw) if the naive `before`-range overlap check lets them share a batch.
 * Widening the overlap range to the resolved statement here makes
 * `batchByOverlap` split them into separate batches instead.
 *
 * `expression-position` (lift) specs are unaffected: they never go through
 * `findEnclosingStatement` — multiple lifts landing in the same code block
 * are coordinated into one merged rewrite by
 * `compile.ts`'s `commitLiftRewrites`, not a collision.
 */
function overlapRangeOf(spec: MutationSpec): { startIndex: number; endIndex: number } {
  if (spec.parentContext === "expression-position") {
    return { startIndex: spec.before.startIndex, endIndex: spec.before.endIndex };
  }
  const statement = findEnclosingStatement(spec.before);
  return statement
    ? { startIndex: statement.startIndex, endIndex: statement.endIndex }
    : { startIndex: spec.before.startIndex, endIndex: spec.before.endIndex };
}

export async function runSession(cfg: SessionConfig): Promise<SessionReport> {
  const caps = cfg.backend.capabilities();
  const status = await cfg.backend.status();
  if (!status.ok) throw new Error(`backend not ready: ${status.details}`);

  // NOTE: a prior preflight here scanned [Test] codeunit sources for
  // `TestIsolation = Function;` and aborted session-isolation backends when
  // it was missing. That was factually wrong: `TestIsolation` is a
  // TestRunner-codeunit property in real BC (AL0223 if set on a
  // `Subtype = Test` codeunit) and cannot be verified by scanning test
  // sources — it's chosen by whichever TestRunner codeunit invokes the
  // tests. Removed; isolation is a TestRunner-side concern verified out of
  // band, not something Layer 4 checks.

  const tests = await discoverTests(cfg.testDir);
  if (tests.length === 0) throw new Error("no tests discovered");

  const runId = cfg.store.createRun({
    projectPath: cfg.projectDir,
    backend: caps.authoritative ? "bcdev" : "al-runner",
    appVersion: cfg.appVersion ?? "0.0.0.0",
  });

  const allFiles = await generateMutationSet(cfg.projectDir);
  const allSpecs: SiteEntry[] = allFiles.flatMap((f) =>
    f.specs.map((spec) => {
      const site = overlapRangeOf(spec);
      return {
        file: f.path,
        startIndex: site.startIndex,
        endIndex: site.endIndex,
        spec,
        sourceFile: f,
      };
    }),
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

      // 1b. app.json + full source set — unconditionally, since even
      // in-memory backends may need a project manifest. writeInstrumentedProject
      // only wrote files that had >=1 mutant spec in THIS batch (see
      // packages/schemata/src/project.ts), so alc would fail to compile the
      // batch dir without the rest of the project's `.al` files.
      await prepareBatchProject(cfg.projectDir, batchDir, batchIdx, runId);

      // 2. history filter
      const prior = cfg.store.priorSurvivorKeys(cfg.projectDir);
      const { execute, knownSurvivors } = filterHistory([...manifest.mutants], prior, {
        skipKnownSurvivors: cfg.skipKnownSurvivors ?? false,
      });
      for (const m of knownSurvivors)
        record(cfg.store, runId, m, "known-survivor", outcomes, batchIdx);

      // 3. deploy — always, even for in-memory backends: they need the
      // per-batch instrumented dir just as much as a publishing backend
      // needs the compiled app. `capabilities().deploy` still describes
      // publish cost for callers, it just no longer gates this call.
      try {
        await cfg.backend.deploy(batchDir);
      } catch (err) {
        for (const m of execute)
          record(cfg.store, runId, m, "error", outcomes, batchIdx, undefined, String(err));
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
        // Baseline test results are not tied to any mutant: mutant_row_id stays NULL.
        cfg.store.recordTestResult(
          runId,
          null,
          null,
          ref,
          v.outcome,
          v.durationMs,
          v.failureMessage,
        );
        baseline.push({ ref, verdict: v });
      }
      const greenTests = baseline.filter((b) => b.verdict.outcome === "pass");
      if (greenTests.length < baseline.length) baselineGreenOverall = false;
      if (greenTests.length === 0) {
        for (const m of execute) {
          record(
            cfg.store,
            runId,
            m,
            "error",
            outcomes,
            batchIdx,
            undefined,
            "no green baseline tests",
          );
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
      for (const m of uncovered) record(cfg.store, runId, m, "no-coverage", outcomes, batchIdx);

      // 6. per-mutant loop
      for (const m of execute) {
        const covering = perMutantTests.get(m.mutantId);
        if (covering === undefined) continue; // uncovered, already recorded above
        if (covering.length === 0) {
          // Defensive: the covering-test list resolved to zero refs (e.g. a
          // coverage index key whose tests no longer exist in `greenTests`).
          // Treat it the same as "no coverage" rather than silently
          // reporting "survived" for a mutant nothing actually ran against.
          record(cfg.store, runId, m, "no-coverage", outcomes, batchIdx);
          continue;
        }
        await activateWithRetry(cfg.backend, m.mutantId);
        let verdict: SessionVerdict = "survived";
        let killingTest: string | undefined;
        let failureNote: string | undefined;
        let cause: "deadline-exceeded" | "unstable" | undefined;
        let spent = 0;
        // mutant_row_id isn't known until recordMutant() runs below (the
        // verdict — and thus the recordMutant call — only lands AFTER this
        // loop finishes), so buffer this mutant's test-result rows here and
        // flush them once record() returns the row id.
        const testResultBuffer: Array<{
          mutantCode: string | null;
          ref: TestMethodRef;
          outcome: TestVerdict["outcome"];
          durationMs: number;
          failureMessage: string | undefined;
        }> = [];
        let transportErrorRef: TestMethodRef | undefined;
        for (const ref of covering) {
          const budget =
            2 *
            (baselineDuration.get(testKeyOf(ref)) ??
              cfg.baselineTimeoutMs ??
              BASELINE_TIMEOUT_DEFAULT);
          const v = await runWithRetry(cfg.backend, ref, { coverage: "none", timeoutMs: budget });
          testResultBuffer.push({
            mutantCode: m.mutantId,
            ref,
            outcome: v.outcome,
            durationMs: v.durationMs,
            failureMessage: v.failureMessage,
          });
          spent += v.durationMs;
          if (v.outcome === "deadline-exceeded") {
            // Our timer, not the runner's: says nothing about the mutant.
            verdict = "error";
            failureNote = `deadline exceeded running ${ref.method} (infrastructure, not a kill)`;
            cause = "deadline-exceeded";
            break;
          }
          if (v.outcome === "timeout") {
            verdict = "timeout-killed";
            killingTest = ref.method;
            break;
          }
          if (v.outcome === "error") {
            // runWithRetry already retried once internally — reaching "error"
            // here means the backend failed transport for this test TWICE in
            // a row. Spec §11: that aborts the whole session, not just this
            // mutant (unlike the "unstable test" error path below, which is a
            // legitimate flakiness finding, not a transport failure).
            verdict = "error";
            failureNote = v.failureMessage;
            transportErrorRef = ref;
            break;
          }
          if (v.outcome === "fail") {
            await activateWithRetry(cfg.backend, null);
            const confirm = await runWithRetry(cfg.backend, ref, {
              coverage: "none",
              timeoutMs: budget,
            });
            testResultBuffer.push({
              mutantCode: null,
              ref,
              outcome: confirm.outcome,
              durationMs: confirm.durationMs,
              failureMessage: confirm.failureMessage,
            });
            if (confirm.outcome === "pass") {
              verdict = "killed";
              killingTest = ref.method;
            } else {
              verdict = "error";
              failureNote = `unstable test ${ref.method}: fails at baseline confirmation`;
              cause = "unstable";
            }
            break;
          }
        }
        const mutantRowId = record(
          cfg.store,
          runId,
          m,
          verdict,
          outcomes,
          batchIdx,
          killingTest,
          failureNote,
          cause,
          spent,
        );
        for (const t of testResultBuffer) {
          cfg.store.recordTestResult(
            runId,
            mutantRowId,
            t.mutantCode,
            t.ref,
            t.outcome,
            t.durationMs,
            t.failureMessage,
          );
        }
        if (transportErrorRef !== undefined) {
          throw new Error(
            `backend transport error: two consecutive run() failures for mutant ${m.mutantId} ` +
              `(test ${transportErrorRef.method}) — aborting session per spec §11: ${failureNote ?? ""}`,
          );
        }
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

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Spec §5: the instrumented app must keep the target app's id and
 * version-bump per batch (`1.0.<runId>.<batchIdx>`), and must contain every
 * project source file so `alc` can actually compile it — not just the
 * files `writeInstrumentedProject` wrote for this batch's mutants.
 *
 * Version ordering is `run` THEN `batch`, and that order is load-bearing:
 * BC refuses to publish an app version lower than the one already installed
 * ("Cannot install the extension ... because a newer version N was already
 * installed" — verified live). The original spec scheme `1.0.<batch>.<run>`
 * is non-monotonic ACROSS runs: run 5's batch 0 (1.0.0.5) is lower than run
 * 4's batch 2 (1.0.2.4), so every run after the first failed to deploy any
 * batch below the previous run's highest batch index. `runId` comes from the
 * results DB and strictly increases, so `1.0.<runId>.<batchIdx>` increases
 * both within a run and across runs.
 *
 * Throws (aborting the whole session, uncaught by the per-batch deploy
 * try/catch below) if the target project has no `app.json` — there's no
 * sane per-batch fallback for a structurally uncompilable target.
 */
async function prepareBatchProject(
  projectDir: string,
  batchDir: string,
  batchIdx: number,
  runId: number,
): Promise<void> {
  const appJsonPath = join(projectDir, "app.json");
  let raw: string;
  try {
    raw = await readFile(appJsonPath, "utf8");
  } catch (err) {
    throw new Error(
      `cannot deploy batch ${batchIdx}: target project has no app.json at ${appJsonPath} ` +
        `(required for alc to compile the instrumented app) — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `cannot deploy batch ${batchIdx}: ${appJsonPath} is not valid JSON — ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  manifest.version = `1.0.${runId}.${batchIdx}`;
  await writeFile(join(batchDir, "app.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  // writeInstrumentedProject only wrote files with >=1 mutant spec in this
  // batch; copy every other project source file verbatim (files whose sites
  // landed in a different batch, or that have no mutable sites at all) so
  // the batch dir holds the FULL project alc needs to compile.
  const entries = (await readdir(projectDir, { recursive: true })).filter((e) =>
    e.toLowerCase().endsWith(".al"),
  );
  for (const rel of entries) {
    const dest = join(batchDir, basename(rel));
    if (await pathExists(dest)) continue;
    await copyFile(join(projectDir, rel), dest);
  }
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

/**
 * Records a mutant's verdict and returns the `mutants.id` row id SQLite
 * assigned it. `mutant_code` (e.g. "M0007") is only unique WITHIN a batch —
 * `assignMutantIds` restarts numbering per batch — so `mutant_row_id` is the
 * only unambiguous way to tie a `test_results` row back to a specific mutant
 * across a whole run (see I5).
 */
function record(
  store: ResultsStore,
  runId: number,
  m: MutantManifestEntry,
  verdict: MutantVerdict,
  outcomes: SessionOutcome[],
  batchIndex: number,
  killingTest?: string,
  failureNote?: string,
  cause?: "deadline-exceeded" | "unstable",
  durationMs = 0,
): number {
  const key = identityKeyOf(m);
  const mutantRowId = store.recordMutant(runId, {
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
    batchIndex,
    ...(killingTest !== undefined ? { killingTest } : {}),
    ...(failureNote !== undefined ? { failureNote } : {}),
    ...(cause !== undefined ? { cause } : {}),
  });
  return mutantRowId;
}
