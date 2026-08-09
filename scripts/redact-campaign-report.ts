#!/usr/bin/env bun
/**
 * Strip verbatim third-party AL source out of a `SessionReport` before it is committed.
 *
 * WHY THIS EXISTS. A real-project campaign report carries `originalText` and `mutatedText` on every
 * mutant — the AL statement the operator replaced, and what it replaced it with. On a fixture that is
 * harmless. On a commercial product it is that product's source code, and this repository is PUBLIC.
 * Two campaign reports against Continia Document Output were committed with 2,550 such fields before
 * anyone noticed (2026-08-07 and 2026-08-08); both were redacted on 2026-08-09.
 *
 * THE RULING this implements, from the repository owner on 2026-08-09: **filenames, paths, procedure
 * names and test names are fine to publish; source code is not.** So exactly two fields go, and
 * nothing else is touched — not verdicts, not counts, not `killingTestFailure`, not coverage, not ast
 * hashes. Everything a reader needs to check the campaign's own numbers against the artifact that
 * produced them survives, which is why redaction was chosen over deletion.
 *
 * `killingTestFailure` is deliberately RETAINED even though ~65 of a measured 73 kill messages are
 * `Error(...)`/`Assert.*` string literals from the target's source. Ruled the same day: that text is
 * documentation-grade rather than implementation, and it is the corpus `scripts/r121-classify-eval.ts`
 * scores candidate false-kill rules against. Redacting it would make the shipped screen's measured
 * precision uncheckable and would destroy the corpus's value for any FUTURE rule. See
 * `docs/campaign/2026-08-08-r85-swap-population/README.md` for the full composition.
 *
 * WHAT THIS DOES NOT DO. It does not remove anything from git history. A report already pushed to a
 * public remote has been fetchable since the moment it landed; running this afterwards changes what a
 * fresh clone sees and nothing else. Run it BEFORE the commit.
 *
 *   bun scripts/redact-campaign-report.ts <report.json> [...]
 *   bun scripts/redact-campaign-report.ts --check <report.json> [...]   # exit 1 if any field remains
 */
import { readFileSync, writeFileSync } from "node:fs";

/** The marker a redacted field carries. A fixed string, so `--check` is an equality test rather than
 *  a guess, and so a reader meeting one in a report can grep for where it came from. */
export const REDACTION_MARKER = "[redacted: third-party source, see this directory's README]";

/** The only two fields that carry verbatim target source. Named here rather than inline so the
 *  ruling's scope is one greppable list. */
const SOURCE_FIELDS = ["originalText", "mutatedText"] as const;

interface Report {
  mutants?: Array<Record<string, unknown>>;
}

const args = process.argv.slice(2);
const check = args[0] === "--check";
const paths = check ? args.slice(1) : args;
if (paths.length === 0) {
  throw new Error(
    "usage: bun scripts/redact-campaign-report.ts [--check] <report.json> [...]\n" +
      "  --check exits 1 if any report still carries unredacted target source",
  );
}

let offending = 0;
for (const path of paths) {
  const report = JSON.parse(readFileSync(path, "utf8")) as Report;
  const mutants = report.mutants;
  if (!Array.isArray(mutants)) {
    // Loud, never a quiet skip: a report shape this script cannot read is a report it cannot
    // certify, and "nothing to redact" and "could not look" must not produce the same exit code.
    throw new Error(`${path}: no \`mutants\` array — this is not a SessionReport`);
  }
  let touched = 0;
  for (const mutant of mutants) {
    for (const field of SOURCE_FIELDS) {
      const value = mutant[field];
      if (typeof value !== "string" || value === REDACTION_MARKER) continue;
      // An empty `mutatedText` is meaningful (a deletion operator's mutation IS the empty string)
      // and reveals nothing, so it is left alone.
      if (value === "") continue;
      touched += 1;
      if (!check) mutant[field] = REDACTION_MARKER;
    }
  }
  if (check) {
    if (touched > 0) {
      offending += 1;
      console.error(`UNREDACTED: ${path} — ${touched} field(s) still carry target source`);
    } else {
      console.log(`ok: ${path}`);
    }
    continue;
  }
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`${path}: ${touched} field(s) redacted across ${mutants.length} mutant(s)`);
}

if (check && offending > 0) {
  console.error(
    `\n${offending} report(s) carry verbatim target AL source. Run this script without --check BEFORE committing — after a push the source is already public and redacting only changes what a fresh clone sees.`,
  );
  process.exit(1);
}
