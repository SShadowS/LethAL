// NOT `mutation-testing-report-schema/src-generated/schema`: pre-flight verified that specifier
// resolved, but only via Bun's runtime check, which erases a type-only `import type` before ever
// resolving the module. `tsc` rejects it (TS2307) because the package's own `exports` map in
// package.json publishes that same generated file only under `./api`, not `./src-generated/schema`.
import type {
  FileResultDictionary,
  MutantResult,
  MutantStatus,
  MutationTestResult,
} from "mutation-testing-report-schema/api";
import type { ExcludedSiteFile } from "./excluded-sites";
// `positionOf` is the same byte-offset-to-{line,column} conversion `lethal export`'s own
// projection (R178, mutation-elements.ts) already uses and already tests — reused rather than
// reimplemented, since both projections answer the identical question ("where in `source` does
// this span sit") off the identical inputs (`startIndex`/`endIndex` against the target's text).
import { positionOf } from "./mutation-elements";
import type { MutantErrorCause, MutantOutcome, SessionReport } from "./report";
import type { MutantVerdict } from "./store";

/**
 * Map a LethAL `MutantVerdict` onto the standard mutation-testing-report-schema's `MutantStatus`,
 * so a LethAL run renders in the off-the-shelf HTML viewer StrykerJS and Stryker.NET also target.
 *
 * `known-survivor` maps to `Survived`, not `Pending`: `Survived` is what was MEASURED (a prior run
 * recorded the mutant surviving), and `Pending` would falsely claim the mutant is still queued.
 * That it was carried rather than re-run in THIS run belongs in `statusReason`, not in `status`.
 */
export function statusOf(o: {
  verdict: MutantVerdict;
  cause?: MutantErrorCause;
  compileCulprit?: boolean;
}): MutantStatus {
  const { verdict, cause, compileCulprit } = o;
  switch (verdict) {
    case "killed":
      return "Killed";
    case "survived":
      return "Survived";
    case "no-coverage":
      return "NoCoverage";
    case "timeout-killed":
      return "Timeout";
    case "known-survivor":
      return "Survived";
    case "error":
      if (compileCulprit === true) {
        return "CompileError";
      }
      // Every MutantErrorCause reads as RuntimeError: the schema has no cause-specific error
      // status, and `cause` (or the absence of a compile culprit) belongs in statusReason.
      return "RuntimeError";
    default:
      throw new Error(
        `unmapped verdict ${JSON.stringify(verdict)}: the standard report schema needs an explicit MutantStatus for every MutantVerdict. Add one here rather than letting it default.`,
      );
  }
}

/**
 * The standard schema's OWN major version, per design spec 2026-08-26-excluded-sites-and-report-
 * schema-design.md section 2 — unrelated to `REPORT_SCHEMA_VERSION` (report.ts), which versions
 * LethAL's own `SessionReport` shape. The two happen to both read "2" today; that is a coincidence,
 * not a coupling, and bumping one must never move the other. A STRING, not a number: the schema's
 * `schemaVersion` pattern rejects a number outright (pinned in standard-report.test.ts).
 */
const STANDARD_SCHEMA_VERSION = "2";

/**
 * The schema REQUIRES thresholds and LethAL has no threshold concept of its own (nothing in
 * `lethal.config.json` sets a mutation-score gate) — same reasoning `lethal export`'s own
 * `ElementsOptions.thresholds` doc comment already gives, and the same ecosystem-default numbers
 * `lethal export`'s CLI flag defaults to. D (`--break-at`, deferred) would retire this hardcode with
 * a value someone actually chose.
 */
const STANDARD_THRESHOLDS = { high: 80, low: 60 } as const;

/**
 * A bisected compile-culprit mutant, per design spec section 2.3's "the one AlcCompileError case".
 *
 * When a batch's artifact fails to compile, orchestrator.ts's post-bisection call site gives EVERY
 * mutant in that batch the SAME `error` verdict and the SAME `failureNote` — one shared sentence
 * naming exactly one mutant's id (`bisectAndNote`'s "culprit" case: "compile failed; bisected to
 * mutant M000x (...)"). This mutant IS that culprit exactly when the id the note names is its own
 * `mutantCode`; every other mutant in the same failed batch reads the identical sentence about a
 * DIFFERENT mutant and stays an ordinary RuntimeError.
 */
const BISECTED_CULPRIT = /^compile failed; bisected to mutant (\S+) /;

function isCompileCulprit(m: MutantOutcome): boolean {
  if (m.verdict !== "error" || m.failureNote === undefined) return false;
  const culpritId = BISECTED_CULPRIT.exec(m.failureNote)?.[1];
  return culpritId !== undefined && culpritId === m.mutantCode;
}

/**
 * How many covering tests this mutant's run actually completed, per design spec section 2.3:
 * "`testsCompleted` exists in the schema precisely because a runner may bail after the first
 * failing test, which is what the covering-test loop already does". `killingTest` is set exactly
 * when that loop broke early (a kill or a timeout — both `break` on the SAME line in
 * orchestrator.ts's covering-test loop); its position in `coveringTests` (the loop's OWN order,
 * carried through verbatim by `record()`) is how many tests ran before it did. Falls back to the
 * full count if `killingTest` is somehow not among `coveringTests` — a defensive floor, never
 * expected on a real run.
 */
function testsCompletedOf(m: MutantOutcome): number {
  if (m.killingTest === undefined) return m.coveringTests.length;
  const idx = m.coveringTests.indexOf(m.killingTest);
  return idx >= 0 ? idx + 1 : m.coveringTests.length;
}

/**
 * `MutantResult.statusReason` for a real (non-`Ignored`) mutant, per design spec section 2.3's
 * mapping table. Not a single field copy: which report field answers "why this status" depends on
 * the verdict, so this mirrors `statusOf`'s own switch rather than one `?? ?? ??` chain that would
 * silently prefer the wrong field for a case nobody meant to cover.
 *
 * `killed`/`timeout-killed`: `killingTestFailure`, the redaction ruling's deliberately-kept field
 * (CLAUDE.md's "Committing a campaign report" section) — the test's own failure text.
 * `error`: `cause` when the two call sites that know one set it, else `failureNote` (a bisected
 * culprit's identity, a deadline/unstable diagnostic, or whatever `record()` was given) — never
 * both, since a caused error's `failureNote` restates the same fact in prose.
 * `known-survivor`: a fixed sentence — the schema's `status` already collapsed this to `Survived`
 * (see `statusOf`'s own doc comment), so this is where the carried provenance actually survives.
 * `survived`/`no-coverage`: nothing to say beyond the status itself.
 */
function statusReasonOf(m: MutantOutcome): string | undefined {
  switch (m.verdict) {
    case "known-survivor":
      return "carried from a PRIOR run (--skip-known-survivors); not re-run in this session.";
    case "killed":
    case "timeout-killed":
      return m.killingTestFailure;
    case "error":
      return m.cause ?? m.failureNote;
    case "survived":
    case "no-coverage":
      return undefined;
    default:
      // statusOf (called for the SAME mutant, in mutantResultOf) already throws for a verdict this
      // switch doesn't recognise — reachable only if the two switches drift out of sync, which is
      // itself the bug this throws to name rather than silently returning no reason.
      throw new Error(
        `statusReasonOf: unmapped verdict ${JSON.stringify(m.verdict)} — add a case here to match statusOf's own switch.`,
      );
  }
}

/** One real mutant, mapped onto the schema's `MutantResult`. `source` is the SAME text `location`
 *  is measured against, so the two can never disagree about where this mutant's file starts. */
function mutantResultOf(m: MutantOutcome, source: string): MutantResult {
  const status = statusOf({
    verdict: m.verdict,
    ...(m.cause !== undefined ? { cause: m.cause } : {}),
    compileCulprit: isCompileCulprit(m),
  });
  const coveredBy = m.coveringTests.length > 0 ? [...m.coveringTests] : undefined;
  const killedBy = m.killingTest !== undefined ? [m.killingTest] : undefined;
  const testsCompleted = coveredBy !== undefined ? testsCompletedOf(m) : undefined;
  const statusReason = statusReasonOf(m);
  return {
    id: m.mutantCode,
    mutatorName: m.operatorName,
    location: {
      start: positionOf(source, m.startIndex),
      end: positionOf(source, m.endIndex),
    },
    status,
    // `mutatedText` is always a real string (`""` for a deletion operator, never absent) — see
    // `MutantOutcome.mutatedText`'s own doc comment — so this needs no `!== undefined` guard.
    replacement: m.mutatedText,
    ...(coveredBy !== undefined ? { coveredBy } : {}),
    ...(killedBy !== undefined ? { killedBy } : {}),
    ...(testsCompleted !== undefined ? { testsCompleted } : {}),
    ...(statusReason !== undefined ? { statusReason } : {}),
  };
}

/**
 * One `excludedSites` row, mapped onto a mutant-less `Ignored` entry (design spec section 2.3: "one
 * mutant-less entry per excluded site, `statusReason` = the reason") — so a site LethAL deliberately
 * declined to mutate is something a reader of the rendered report SEES, rather than an absence they
 * have to notice on their own.
 *
 * No real span exists to point at: `ExcludedSiteFile` records a per-file SITE COUNT (`sites`), not
 * individual byte offsets, so `location` is a zero-width marker at the file's very first character
 * rather than a claim about where in the file the excluded sites actually sit.
 *
 * `id` is `file:reason` rather than an index: `ExcludedSites.fileCount`'s own doc comment states the
 * invariant this depends on — "within one reason a file appears at most once" — so the pair is
 * already unique across every row this function is ever called with, and stays stable across a
 * report regenerated from the same run.
 */
function ignoredResultOf(row: ExcludedSiteFile): MutantResult {
  const detail = row.detail !== undefined ? `: ${row.detail}` : "";
  return {
    id: `ignored:${row.file}:${row.reason}`,
    mutatorName: row.reason,
    location: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
    status: "Ignored",
    statusReason: `${row.reason} (${row.kinds}, ${row.sites} site(s) not mutated)${detail}`,
  };
}

/** `sources.get(file)`, or a loud throw — never `""`. See `toStandardReport`'s doc comment for why
 *  a silent empty default is the wrong failure mode here specifically. */
function sourceFor(sources: ReadonlyMap<string, string>, file: string): string {
  const source = sources.get(file);
  if (source === undefined) {
    throw new Error(
      `toStandardReport: no source for "${file}". The standard schema REQUIRES a FileResult's full source (FileResult.source): without it the report is either invalid, or valid and renders nothing in the viewer for this file — both worse than refusing. Pass every file this report references (report.mutants and report.excludedSites) in the sources map.`,
    );
  }
  return source;
}

/**
 * Project a whole `SessionReport` onto `mutation-testing-report-schema`'s `MutationTestResult`, so a
 * LethAL run renders in the off-the-shelf HTML viewer StrykerJS and Stryker.NET also target.
 *
 * The return type IS the conformance mechanism (design spec section "F2"): annotating it as
 * `MutationTestResult` makes `tsc` enforce the schema's structure at compile time — a missing
 * `source`, a wrong `status` string, a number where `schemaVersion` wants a string — which is why
 * this file adds no JSON Schema validator dependency.
 *
 * `sources` is passed in, never read from disk here: that keeps this function pure and testable
 * without a filesystem, and puts the decision to embed a project's source (a decision the
 * 2026-08-09 redaction ruling in CLAUDE.md cares about — source is not publishable, unlike
 * filenames, paths, procedure and test names) at the CALL SITE, where it is visible, rather than
 * buried in here.
 */
export function toStandardReport(
  report: SessionReport,
  sources: ReadonlyMap<string, string>,
): MutationTestResult {
  const byFile = new Map<string, { mutants: MutantOutcome[]; ignored: ExcludedSiteFile[] }>();
  function entryFor(file: string): { mutants: MutantOutcome[]; ignored: ExcludedSiteFile[] } {
    const existing = byFile.get(file);
    if (existing !== undefined) return existing;
    const created = { mutants: [], ignored: [] };
    byFile.set(file, created);
    return created;
  }

  for (const m of report.mutants) entryFor(m.file).mutants.push(m);
  // A file can carry BOTH real mutants and an ignored row (not every site in a mutated file is
  // necessarily excluded), and a file can carry ONLY an ignored row (see `entryFor` above, which
  // creates the file the first time either loop reaches it) — see `ExcludedSiteFile`'s own doc
  // comment: a file appears "in both lists, in neither, or in one alone".
  for (const row of report.excludedSites?.files ?? []) entryFor(row.file).ignored.push(row);

  const files: FileResultDictionary = {};
  for (const [file, entry] of byFile) {
    const source = sourceFor(sources, file);
    files[file] = {
      language: "al",
      source,
      mutants: [
        ...entry.mutants.map((m) => mutantResultOf(m, source)),
        ...entry.ignored.map((row) => ignoredResultOf(row)),
      ],
    };
  }

  return {
    schemaVersion: STANDARD_SCHEMA_VERSION,
    thresholds: STANDARD_THRESHOLDS,
    files,
  };
}
