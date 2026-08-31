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

/**
 * R184: is this a `mutation-elements` export rather than a `SessionReport`?
 *
 * Detected BY SHAPE, never by filename. The `--out` path is the user's to choose, so a name-based
 * test passes against the same dangerous file saved as `out.json`. The shape is unmistakable: the
 * interchange schema requires a root `schemaVersion` and `files`, and every file entry carries the
 * `source` that makes the document dangerous in the first place.
 *
 * Exported so the committed-file guard in this script's test uses the SAME predicate the refusal
 * does, rather than a second definition that can drift from it.
 */
export function isMutationElementsExport(doc: unknown): boolean {
  if (typeof doc !== "object" || doc === null) return false;
  const root = doc as { schemaVersion?: unknown; files?: unknown };
  if (typeof root.schemaVersion !== "string") return false;
  if (typeof root.files !== "object" || root.files === null) return false;
  return Object.values(root.files as Record<string, unknown>).some(
    (f) =>
      typeof f === "object" && f !== null && typeof (f as { source?: unknown }).source === "string",
  );
}

interface Report {
  mutants?: Array<Record<string, unknown>>;
}

/**
 * The CLI body, guarded so this file can also be IMPORTED as a module.
 *
 * `isMutationElementsExport` above is the predicate the committed-file guard in this script's
 * test needs, and importing it used to execute everything below: the test process inherited
 * `bun test`'s argv, matched no report path, and died on the usage error. Same shape as the
 * itest-script hazard recorded on `notinstrumented-evidence.ts`. `import.meta.main` is true only
 * when this file is the entry point, so the CLI still behaves identically when run directly.
 */
if (import.meta.main) {
  const args = process.argv.slice(2);
  // R185: `--check` is honoured ANYWHERE in argv, not only as args[0]. It used to be positional, so
  // `redact-campaign-report.ts <file> --check` took the WRITE branch, rewrote the file, printed a
  // reassuring "0 field(s) redacted" and only then died opening "--check" as a path. A check flag
  // that silently becomes a write flag is the same class of defect as an assertion that cannot fail:
  // it reports success for work it did not do, in the script guarding a PUBLIC repo.
  const check = args.includes("--check");
  const paths = args.filter((a) => a !== "--check");
  // An unrecognised dash-argument is refused rather than treated as a path, so a typo like `--dry-run`
  // cannot become a filename this script then fails to open half way through a batch.
  const unknownFlags = paths.filter((a) => a.startsWith("-"));
  if (unknownFlags.length > 0) {
    throw new Error(
      `unrecognised argument(s): ${unknownFlags.join(", ")}. Only --check is understood; everything else is treated as a report path, and a flag is never a path.`,
    );
  }
  if (paths.length === 0) {
    throw new Error(
      "usage: bun scripts/redact-campaign-report.ts [--check] <report.json> [...]\n" +
        "  --check exits 1 if any report still carries unredacted target source",
    );
  }

  let offending = 0;
  for (const path of paths) {
    const report = JSON.parse(readFileSync(path, "utf8")) as Report;
    // R184: a mutation-elements export is the OTHER source-bearing shape this repo produces, and it
    // is refused rather than redacted. Its schema REQUIRES each file's complete `source`, so blanking
    // that leaves a document which still validates but renders nothing: "redacted" would be false in
    // both directions. Detected before the `mutants` check below, because it has no top-level
    // `mutants` array and would otherwise die as "not a SessionReport", which tells a user the file is
    // unrecognised rather than that it is dangerous.
    if (isMutationElementsExport(report)) {
      throw new Error(
        `${path}: this is a mutation-elements export (\`lethal export --format mutation-elements\`), not a SessionReport. It embeds the COMPLETE source of every mutated file, which the schema requires, so it cannot be redacted into something useful and must not be committed to this public repository at all. Delete it, or move it outside the repo.`,
      );
    }
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
}
