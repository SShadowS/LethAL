/**
 * Pure formatting for the diagnostics `hang.itest.ts` prints when a leg's assertions fail, before
 * its `finally` deletes the scratch store and quarantine dir that hold the only record of why
 * (2026-09-27 hang investigation:
 * `.superpowers/sdd/2026-09-27-R-236b-testpage-reply-fix/hang-rootcause-report.md`). That report's
 * root cause for the M0004 failure was never found because the one record that would have said so
 * — the stranded verdict's `failureMessage`, carrying the watchdog's `stopDetail` (last stop
 * refusal, last progress row, stop hook error) — lived only in the scratch SQLite store and the
 * quarantine record, both gone by the time the gate printed its failure.
 *
 * No fs/DB access here on purpose: the itest gathers the data (it already has `LegResult`'s
 * `report`/`testRows`/`quarantineDir` in scope) and this module only renders it, so the render can
 * be unit-tested without a live container and without duplicating `hang.itest.ts`'s env gate.
 */

/** One `verdict === "error"` mutant's raw `test_results.failure_message` rows, verbatim — not
 *  `SessionReport.mutants[].failureNote`, which is a synthesized summary built for the console
 *  table, not the server's own words. */
export interface ErrorMutantDiagnostic {
  readonly mutantCode: string;
  readonly failureMessages: readonly string[];
}

/** `QuarantineRecord` (quarantine-store.ts), reprinted here rather than imported so this module
 *  stays free of any dependency the itest's IO layer could break. Shape must match. */
export interface QuarantineDiagnostic {
  readonly resourceKey: string;
  readonly opKind: string;
  readonly detail: string;
  readonly recordedAtIso: string;
  readonly generation: number;
}

/** A `{ type: "warning" }` `RunEvent` (events.ts), narrowed to the two fields worth printing. */
export interface WarningDiagnostic {
  readonly code: string;
  readonly message: string;
}

export interface HangLegFailureDiagnostics {
  readonly leg: string;
  readonly errorMutants: readonly ErrorMutantDiagnostic[];
  readonly quarantine: readonly QuarantineDiagnostic[];
  readonly warnings: readonly WarningDiagnostic[];
}

/** Never changes a pass/fail condition — this is print-only, called after an assertion has
 *  already thrown. Always emits something for each section, "none" included, so an empty section
 *  reads as measured-empty rather than as a formatting bug that dropped it. */
export function formatHangLegFailureDiagnostics(input: HangLegFailureDiagnostics): string {
  const lines: string[] = [`=== hang gate failure diagnostics: ${input.leg} ===`];

  if (input.errorMutants.length === 0) {
    lines.push("error mutants: none");
  } else {
    lines.push(`error mutants (${input.errorMutants.length}):`);
    for (const m of input.errorMutants) {
      lines.push(`  ${m.mutantCode}:`);
      if (m.failureMessages.length === 0) {
        lines.push("    (no test_results row for this mutant)");
      } else {
        for (const msg of m.failureMessages) lines.push(`    ${msg}`);
      }
    }
  }

  if (input.quarantine.length === 0) {
    lines.push("quarantine records: none");
  } else {
    lines.push(`quarantine records (${input.quarantine.length}):`);
    for (const q of input.quarantine) {
      lines.push(
        `  resourceKey=${q.resourceKey} opKind=${q.opKind} generation=${q.generation} recordedAtIso=${q.recordedAtIso}`,
      );
      lines.push(`    detail: ${q.detail}`);
    }
  }

  if (input.warnings.length === 0) {
    lines.push("warnings: none");
  } else {
    lines.push(`warnings (${input.warnings.length}):`);
    for (const w of input.warnings) lines.push(`  [${w.code}] ${w.message}`);
  }

  lines.push("=== end diagnostics ===");
  return lines.join("\n");
}

/** The itest's only call site: format then print. Kept separate from the pure formatter so the
 *  formatter itself needs no console mock in its unit test. */
export function printHangLegFailureDiagnostics(input: HangLegFailureDiagnostics): void {
  console.error(formatHangLegFailureDiagnostics(input));
}
