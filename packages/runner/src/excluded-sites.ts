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
import { formatRefusal } from "@lethal/engine";
import type { DeclarativeSiteFile, NotInstrumentedFile } from "./report";

/** R214: a file whose sites the build's preprocessor symbols decided. `detail` is the effective
 *  symbols for `compiled-out` and the reason code for `preproc-undecided`; never source text. */
export interface PreprocExcludedFile {
  readonly file: string;
  readonly kinds: string;
  readonly sites: number;
  readonly reason: "compiled-out" | "preproc-undecided";
  readonly detail: string;
}

/** R447: a file where R196's hang check refused sites an operator would otherwise have claimed. */
export interface HangRefusedFile {
  readonly file: string;
  readonly kinds: string;
  /** (node, operator) pairs, after the `--operator` and `--lines` filters and the `#if` arms. */
  readonly sites: number;
}

/** Why a site or file was excluded. `buildReport` maps each to its legacy view. */
export type ExclusionReason =
  | "not-instrumentable"
  | "declarative"
  | "compiled-out"
  | "preproc-undecided"
  | "instrumentation-refused"
  | "hang-refused";

/** R307: one file `generateMutationSet`'s trial refused whole, with its object kinds and site count. */
export interface RefusedExcludedFile {
  // The engine's `FileRefusalFields`, spelled out rather than imported: the schema generator
  // follows neither an `extends` nor a reference into another package. Assignable both ways.
  readonly file: string;
  readonly shape:
    | "overlap"
    | "unsupported-kind"
    | "latch-owner"
    | "no-anchor"
    | "no-header"
    | "object-mix"
    | "site-before-header";
  readonly objects?: readonly {
    readonly type: string;
    readonly id: number;
    readonly name: string;
  }[];
  /** 1-based first and last line (two numbers; an array because the generator has no tuples). */
  readonly lines?: readonly number[];
  readonly kinds: string;
  readonly sites: number;
  /** R307 section 3: mutants elsewhere whose cross-run carry this refusal disabled (`RefusedFile`). */
  readonly carryDisabled?: number;
}

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
   *  - `compiled-out` (R214) counts RAW specs, before validation, dedup and the operator or line
   *    filters.
   *  - `hang-refused` (R447) counts (node, operator) pairs R196's hang check refused, AFTER the
   *    `--operator` and `--lines` filters and outside inactive `#if` arms. They never became specs,
   *    so no other row counts them.
   *
   * Changing either is a separate decision with its own live-gate consequences.
   */
  readonly sites: number;
  readonly reason: ExclusionReason;
  /**
   * Free-text detail for reasons that have one. R214's two reasons carry one: the effective
   * symbols, or a reason code. R307's `instrumentation-refused` carries the refusal's shape, objects
   * and line span (`formatRefusal`). None is source text.
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
   * DISTINCT FILES, which is NOT `files.length`: a file can be excluded under several reasons and
   * therefore appear as several rows. A `hang-refused` row's file is usually ALSO a mutated file,
   * and may also carry a `not-instrumentable` or `instrumentation-refused` row (R447). Each VIEW's `fileCount` is that view's own row count, because
   * within one reason a file appears at most once — and because `itest:tables` pins the
   * declarative one.
   */
  readonly fileCount: number;
  readonly files: readonly ExcludedSiteFile[];
}

export function buildExcludedSites(input: {
  readonly skipped: readonly NotInstrumentedFile[];
  readonly declarative: readonly DeclarativeSiteFile[];
  readonly preproc: readonly PreprocExcludedFile[];
  /** R307: files refused whole. Optional so every existing caller is unchanged. */
  readonly refused?: readonly RefusedExcludedFile[];
  /** R447: files with hang-refused sites. Optional so every existing caller is unchanged. */
  readonly hangRefused?: readonly HangRefusedFile[];
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
    ...input.preproc.map((f) => ({
      file: f.file,
      kinds: f.kinds,
      sites: f.sites,
      reason: f.reason,
      detail: f.detail,
    })),
    ...(input.refused ?? []).map((f) => ({
      file: f.file,
      kinds: f.kinds,
      sites: f.sites,
      reason: "instrumentation-refused" as const,
      detail: `${formatRefusal({
        file: f.file,
        shape: f.shape,
        ...(f.objects !== undefined ? { objects: f.objects } : {}),
        ...(f.lines?.[0] !== undefined && f.lines[1] !== undefined
          ? { lines: [f.lines[0], f.lines[1]] as const }
          : {}),
      })}${
        f.carryDisabled !== undefined
          ? `; identity carry disabled for ${f.carryDisabled} mutant(s)`
          : ""
      }`,
    })),
    ...(input.hangRefused ?? []).map((f) => ({
      file: f.file,
      kinds: f.kinds,
      sites: f.sites,
      reason: "hang-refused" as const,
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
