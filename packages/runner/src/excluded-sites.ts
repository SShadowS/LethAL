/**
 * ONE record of the sites LethAL deliberately did not mutate, because there were two.
 *
 * `NotInstrumentedFile` (R5, "this FILE cannot carry the injected selector var") and
 * `DeclarativeSiteFile` (R144, "this SITE is not executable AL") have the same shape and the same
 * stated purpose, and `DeclarativeSiteFile`'s own doc comment already calls it a SIBLING of the
 * first. A third consumer is coming: the standard mutation-testing report schema's `Ignored`
 * status. Rather than a third copy, both become views over this.
 *
 * The two views are the ONLY way the legacy fields are produced (`buildReport` consumes them, not
 * the raw arrays), so they cannot drift into a parallel implementation that agrees by accident.
 */
import type { DeclarativeSiteFile, NotInstrumentedFile } from "./report";

/** Why a site or file was excluded. `buildReport` maps each to its legacy view. */
export type ExclusionReason = "not-instrumentable" | "declarative";

export interface ExcludedSiteFile {
  readonly file: string;
  /** Object kind(s) this file declares, e.g. `"page_declaration"` — from `describeObjectKinds`. */
  readonly kinds: string;
  /**
   * The counting rule DIFFERS by reason, and flattening them would be a lie:
   *
   *  - `declarative` counts specs PRE-filter, where they are dropped inside the visit loop.
   *  - `not-instrumentable` counts `fileSpecs.length` AFTER dedup and the `--operator` filter, and
   *    a file whose specs are entirely filtered away leaves the list altogether, because
   *    `generateMutationSet`'s `if (fileSpecs.length === 0) continue;` precedes its
   *    `canCarryMutationSelectorVar` check.
   *
   * Changing either is a separate decision with its own live-gate consequences.
   */
  readonly sites: number;
  readonly reason: ExclusionReason;
  /**
   * Free-text detail for reasons that have one. Neither current reason does.
   *
   * MUST NEVER carry target source (no `originalText`, no snippet of the excluded site's AL):
   * `scripts/redact-campaign-report.ts` redacts only `originalText`/`mutatedText` inside
   * `mutants`, so a future reason that put source text here would publish it from a public repo
   * unredacted (see CLAUDE.md's "Committing a campaign report" section).
   */
  readonly detail?: string;
}

export interface ExcludedSites {
  /** Every `.al` file scanned — the denominator, which only `notInstrumented` had a home for. */
  readonly totalFiles: number;
  readonly siteCount: number;
  /**
   * DISTINCT FILES, which is NOT `files.length`: a file can be excluded under both reasons and
   * therefore appear as two rows. Each VIEW's `fileCount` is that view's own row count, because
   * within one reason a file appears at most once — and because `itest:tables` pins the
   * declarative one.
   */
  readonly fileCount: number;
  readonly files: readonly ExcludedSiteFile[];
}

export function buildExcludedSites(input: {
  readonly skipped: readonly NotInstrumentedFile[];
  readonly declarative: readonly DeclarativeSiteFile[];
  readonly totalFiles: number;
}): ExcludedSites {
  // Mapped explicitly, field by field — never `{ ...f, reason }` — so a field later added to
  // `NotInstrumentedFile` or `DeclarativeSiteFile` is a TYPE ERROR here, not a runtime surprise
  // that reaches `excludedSites.files` and is caught only by the published schema's
  // `additionalProperties: false` at validation time. `rowsOf` below already maps explicitly in
  // the other direction; this keeps both directions consistent.
  const files: ExcludedSiteFile[] = [
    ...input.skipped.map((f) => ({
      file: f.file,
      kinds: f.kinds,
      sites: f.sites,
      reason: "not-instrumentable" as const,
    })),
    ...input.declarative.map((f) => ({
      file: f.file,
      kinds: f.kinds,
      sites: f.sites,
      reason: "declarative" as const,
    })),
  ];
  return {
    totalFiles: input.totalFiles,
    siteCount: files.reduce((n, f) => n + f.sites, 0),
    fileCount: new Set(files.map((f) => f.file)).size,
    files,
  };
}

/** Rows of one reason, stripped back to the legacy three-field shape. */
function rowsOf(excluded: ExcludedSites, reason: ExclusionReason): NotInstrumentedFile[] {
  return excluded.files
    .filter((f) => f.reason === reason)
    .map((f) => ({ file: f.file, kinds: f.kinds, sites: f.sites }));
}

export function notInstrumentedView(excluded: ExcludedSites): {
  readonly totalFiles: number;
  readonly fileCount: number;
  readonly siteCount: number;
  readonly files: readonly NotInstrumentedFile[];
} {
  const files = rowsOf(excluded, "not-instrumentable");
  return {
    totalFiles: excluded.totalFiles,
    fileCount: files.length,
    siteCount: files.reduce((n, f) => n + f.sites, 0),
    files,
  };
}

export function declarativeSitesView(excluded: ExcludedSites): {
  readonly siteCount: number;
  readonly fileCount: number;
  readonly files: readonly DeclarativeSiteFile[];
} {
  const files = rowsOf(excluded, "declarative");
  return {
    siteCount: files.reduce((n, f) => n + f.sites, 0),
    fileCount: files.length,
    files,
  };
}
