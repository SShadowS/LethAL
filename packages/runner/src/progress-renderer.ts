/**
 * A human-watching-a-live-run renderer for the event stream (spec 2026-08-05 §A, events.ts).
 *
 * Motivation, measured: before the event stream existed, `orchestrator.ts` had ZERO console
 * writes across ~3,900 lines — a real run against a customer app ran 1,078s printing nothing,
 * 740s of that inside the baseline phase alone, and twenty `console.warn` diagnostics reached
 * neither stdout nor the final JSON. This is the first thing that shows any of that WHILE the
 * run is happening, not after.
 *
 * Not a report. `report.ts`'s `renderConsole`/`writeJsonReport` remain the final, authoritative
 * rendering of a FINISHED run; this exists only to answer "is it still going, and roughly
 * where" for the duration a run is in progress — including moments the eventual report has no
 * per-instant view of at all (a baseline batch returning, a coverage split, mid-run).
 *
 * WRITES TO WHATEVER STREAM THE CALLER HANDS IT (the injected `write`), but the one hard rule
 * for every real caller is: STDERR, NEVER STDOUT. `cli.ts` wires this against `process.stderr`
 * specifically because the report goes to stdout, and mixing the two swallowed a real run
 * error — twice in one session — behind a `grep` on the combined stream.
 *
 * DOES NOT PRINT ONE LINE PER MUTANT. `mutant-scored`/`mutant-carried`/`mutant-skipped-stranded`
 * are the one high-volume event family (hundreds per real run, and the final per-mutant table in
 * the report already exists) — those three update an internal counter and render at most once
 * per `opts.heartbeatMs`. Every other event type rendered here is already low-volume (a handful
 * of phase boundaries, a few dozen baseline batches at most, occasional warnings) and renders on
 * every occurrence.
 *
 * Never throws. `createEmitter` (events.ts) isolates a throwing subscriber after its first
 * throw, but that is a safety net, not a licence to lean on — a renderer that died on an
 * unfamiliar event shape would go dark for the rest of the run. Every branch here is total over
 * `RunEvent["type"]`; the event types this renderer deliberately does not surface (the `default`
 * case below) fall through silently rather than throwing on a shape it doesn't handle.
 */
import type { EventSubscriber, RunEvent } from "./events";

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * `undefined` for an empty sample — there is nothing to report a median OF yet (e.g. the run has
 * only carried/stranded-skipped mutants so far, no freshly scored one to time).
 */
function median(sortedMs: readonly number[]): number | undefined {
  const n = sortedMs.length;
  if (n === 0) return undefined;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sortedMs[mid];
  const a = sortedMs[mid - 1];
  const b = sortedMs[mid];
  return a !== undefined && b !== undefined ? (a + b) / 2 : undefined;
}

/** Caps how many failing-test names one `baseline-batch-finished` line lists — a batch where
 *  every test failed (a stale test app, say) must not blow the line out to hundreds of names. */
const MAX_NAMED_FAILURES = 8;

export function createProgressRenderer(
  write: (line: string) => void,
  opts: { readonly heartbeatMs: number },
): EventSubscriber {
  // Mutant-progress state — the one throttled line. `mutantsDeployedTotal` is unknown until
  // `mutation-set-generated` arrives (always before the first mutant event in a real run, but
  // this degrades gracefully — just omits the "/total" part — if it somehow isn't).
  let mutantsDone = 0;
  let mutantsStranded = 0;
  let mutantsDeployedTotal: number | undefined;
  const scoredDurationsMs: number[] = [];
  let lastMutantRenderAt: number | undefined;

  const renderMutantProgress = (): void => {
    const med = median([...scoredDurationsMs].sort((a, b) => a - b));
    const total = mutantsDeployedTotal !== undefined ? `/${mutantsDeployedTotal}` : "";
    const medianPart = med !== undefined ? `, median ${formatSeconds(med)}` : "";
    const strandedPart = mutantsStranded > 0 ? `, ${mutantsStranded} stranded` : "";
    write(`mutants: ${mutantsDone}${total}${medianPart}${strandedPart}`);
  };

  // Shared by mutant-scored/mutant-carried/mutant-skipped-stranded: each is one more of
  // `deployedCount` resolved, whatever verdict it landed on. Renders immediately on the FIRST
  // mutant event this renderer ever sees (so the mutants phase does not look silent for a full
  // `heartbeatMs` before the first tick), then at most once per `heartbeatMs` after that — this
  // is the one thing a 473-mutant run must not turn into 473 lines over.
  const noteMutantResolved = (durationMs?: number): void => {
    mutantsDone += 1;
    if (durationMs !== undefined) scoredDurationsMs.push(durationMs);
    const now = Date.now();
    if (lastMutantRenderAt === undefined || now - lastMutantRenderAt >= opts.heartbeatMs) {
      lastMutantRenderAt = now;
      renderMutantProgress();
    }
  };

  return (event: RunEvent): void => {
    switch (event.type) {
      case "phase-entered": {
        const parts = [`phase: ${event.phase}`];
        if (event.testCount !== undefined) parts.push(`${event.testCount} tests`);
        if (event.batchIndex !== undefined) parts.push(`batch ${event.batchIndex}`);
        if (event.detail !== undefined) parts.push(event.detail);
        write(parts.join(", "));
        break;
      }
      case "phase-left":
        write(`phase: ${event.phase} done in ${formatSeconds(event.elapsedMs)}`);
        break;
      case "mutation-set-generated": {
        // R92: the site count and the deployed count are DIFFERENT NUMBERS — per-file dedup
        // collapses same-site operator collisions (176 sites -> 148 deployed, measured on a
        // real app) — and conflating the two broke a real pre-commitment. Both, always, never
        // just one.
        mutantsDeployedTotal = event.deployedCount;
        const skipped =
          event.notInstrumentedFiles.length > 0
            ? `, ${event.notInstrumentedFiles.length} file(s) not instrumented`
            : "";
        const excluded =
          event.excludedByOnly > 0 ? `, ${event.excludedByOnly} excluded by --only` : "";
        write(
          `mutation set: ${event.siteCount} sites -> ${event.deployedCount} deployed ` +
            `(${event.instrumentableFiles}/${event.totalFiles} files instrumentable${skipped}${excluded})`,
        );
        break;
      }
      case "baseline-batch-finished": {
        // The real tick INSIDE the longest silence (spec: the moment of observation is the
        // batch's baseline RETURNING, not each test inside it — events.ts's own doc comment).
        const total = event.verdicts.length;
        const failing = event.verdicts.filter((v) => v.outcome !== "pass");
        const passed = total - failing.length;
        const names = failing.slice(0, MAX_NAMED_FAILURES).map((v) => v.name);
        const overflow = failing.length - names.length;
        const failingPart =
          failing.length > 0
            ? ` — failing: ${names.join(", ")}${overflow > 0 ? `, +${overflow} more` : ""}`
            : "";
        write(`baseline batch ${event.batchIndex}: ${passed}/${total} passed${failingPart}`);
        break;
      }
      case "coverage-split": {
        // Earns its place: on a real run, 66% no-coverage would have been visible here at batch
        // 1, roughly 15 minutes before the report said so.
        const total = event.coveredCount + event.noCoverageCount;
        const pct = total > 0 ? ((event.noCoverageCount / total) * 100).toFixed(0) : "0";
        write(
          `coverage split (batch ${event.batchIndex}): ${event.coveredCount} covered, ` +
            `${event.noCoverageCount} no-coverage (${pct}%), ${event.untargetedTriggerCount} untargeted trigger(s)`,
        );
        break;
      }
      case "warning":
        write(`WARNING [${event.code}]: ${event.message}`);
        break;
      case "quarantined":
        write(`QUARANTINED: ${event.reason}`);
        break;
      case "session-finished":
        write(`session finished in ${formatSeconds(event.elapsedMs)}`);
        break;
      case "mutant-scored":
        noteMutantResolved(event.durationMs);
        break;
      case "mutant-carried":
        // No comparable `durationMs` here — deliberately (events.ts: only `priorDurationMs`
        // exists, so a prior run's cost can never be summed into this run's measured median,
        // even by accident). Counted as resolved; not timed.
        noteMutantResolved();
        break;
      case "mutant-skipped-stranded":
        mutantsStranded += 1;
        noteMutantResolved();
        break;
      // Deliberately not rendered — see task-5-report.md for the full list and why each is a
      // fair omission for a PROGRESS view (not a report): `stream-started`/`run-configured` echo
      // facts the operator already supplied on the command line; `resume-resolved` restates
      // `--resume`'s own inputs, and its learned counts arrive anyway via `mutant-carried`/
      // `mutant-skipped-stranded`, which DO render through the mutant counter above;
      // `tests-discovered` is a single up-front list with nothing to say beyond "N tests, once";
      // `batch-published`/`batch-invalidated` are compile/deploy plumbing a phase boundary
      // already brackets; `permission-canary` is a one-shot diagnostic whose verdict reaches the
      // operator through the final report regardless.
      default:
        break;
    }
  };
}
