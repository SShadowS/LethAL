import type { CoverageMode } from "./backend";
import {
  type ExplainAttribution,
  type ExplainOutput,
  MalformedReportError,
  survivorEvidenceOf,
} from "./explain";
import type { SessionReport, SurvivorReach } from "./report";

/**
 * R273: `lethal explain --suggest`, a suggested fix kind per gap, in its OWN section.
 *
 * The owner's ruling (2026-10-06, docs/roadmap/R273.md): `explain`'s output states what was
 * measured and never says what test to write, and its tests police that. A suggestion is allowed
 * only OUTSIDE it: off by default, labelled as a suggestion, and kept out of the strings those tests
 * scan. So nothing here touches `explain()` or `ExplainOutput`; the CLI composes
 * `{ ...explain(report), suggestions: suggest(report, out) }` only under `--suggest`, and the
 * default output is unchanged by construction.
 *
 * Each kind is derived from two facts the report measured, through `survivorEvidenceOf`, the same
 * derivation `explain`'s survivors use: the survivor's `reach` and its coverage `attribution`.
 * Nothing else is read, and where the report cannot decide, the kind says so (`undecided`).
 */

export type SuggestionKind =
  | "check-the-result"
  | "cover-the-branch"
  | "cover-the-statement"
  | "undecided"
  | "reader-marked";

export type GapSuggestionKind = SuggestionKind | "mixed";

/** Keyed by the type, so a kind added to it cannot be left out of `SUGGESTION_KINDS`. */
const KIND_DOMAIN: Record<GapSuggestionKind, true> = {
  "check-the-result": true,
  "cover-the-branch": true,
  "cover-the-statement": true,
  undecided: true,
  "reader-marked": true,
  mixed: true,
};

/** Every kind value, for the schema pin. A new value bumps `EXPLAIN_SCHEMA_VERSION` (R233). */
export const SUGGESTION_KINDS = Object.keys(KIND_DOMAIN) as readonly GapSuggestionKind[];

/** What a kind suggests, and which measured facts it is derived from. `undecided` and
 *  `reader-marked` suggest nothing, so they have no entry. */
export interface SuggestionText {
  readonly suggestion: string;
  readonly derivedFrom: string;
}

/** The kinds that suggest something, each with its text. A plain interface (not a `Record`) so the
 *  schema-leaves test can read it. */
export interface SuggestionKindTexts {
  readonly "check-the-result"?: SuggestionText;
  readonly "cover-the-branch"?: SuggestionText;
  readonly "cover-the-statement"?: SuggestionText;
}

export const SUGGESTION_TEXTS: Required<SuggestionKindTexts> = {
  "check-the-result": {
    suggestion:
      "The mutated statement ran under a covering test and every covering test still passed, so " +
      "no assertion looks at what it changes. A check on that result would likely catch it. An " +
      "equivalent mutant reads the same, and for an expression mutant only the enclosing " +
      "statement is proven to have begun.",
    derivedFrom: "reach reached-unnoticed (the mutant's own statement marker, reachedBy)",
  },
  "cover-the-branch": {
    suggestion:
      "A test enters the procedure (or one of its coverage arms), but the mutated statement did " +
      "not run in this mutant's runs. A test case that takes the path to it would exercise it, " +
      "or the path is unreachable.",
    derivedFrom: "reach covered-but-unreached with attribution exact (member-level coverage)",
  },
  "cover-the-statement": {
    suggestion:
      "The mutated statement did not run in this mutant's runs, and whether any test enters its " +
      "procedure was not measured. A test that reaches the statement would exercise it.",
    derivedFrom:
      "reach unreached-and-uncovered with attribution object or all-green (no member-level match)",
  },
};

export const SUGGESTIONS_LABEL =
  "SUGGESTIONS, not measurements (R273, opt-in via --suggest). Each kind is derived only from a " +
  "survivor's measured reach and coverage attribution. It covers the RECORDED survivors of each " +
  "gap (on a narrowed or quarantined run, not the whole block); no-coverage blocks are outside " +
  "this section. undecided means the report cannot tell; reader-marked means a reader already " +
  "judged the survivor.";

export interface SuggestionMember {
  readonly mutantCode: string;
  readonly kind: SuggestionKind;
  readonly reach: SurvivorReach;
  readonly attribution: ExplainAttribution;
  /** Verbatim from the row, when its operator declared one. */
  readonly equivalenceRisk?: string;
}

export interface GapSuggestion {
  readonly gapId: string;
  readonly kind: GapSuggestionKind;
  readonly members: readonly SuggestionMember[];
}

export interface ExplainSuggestions {
  readonly label: string;
  /** `SUGGESTION_TEXTS` for the kinds that appear, once each. */
  readonly kinds: SuggestionKindTexts;
  /** One per `gaps[]` entry, same order, same members. */
  readonly gaps: readonly GapSuggestion[];
}

/** `lethal explain --suggest`'s output: the default projection plus the suggestions section. */
export interface ExplainSuggestedOutput extends ExplainOutput {
  readonly suggestions: ExplainSuggestions;
}

/** R273: `--suggest` on a report whose rows carry no gap ids (written before C02-09). Refused,
 *  never an empty list, which would read as "nothing to suggest". */
export class SuggestionsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SuggestionsUnavailableError";
  }
}

/** The kind for one survivor. Total over (reach, attribution); a combination
 *  `survivorReachOf` cannot produce throws rather than default. */
export function suggestionKindOf(
  reach: SurvivorReach,
  attribution: ExplainAttribution,
): Exclude<SuggestionKind, "reader-marked"> {
  switch (reach) {
    case "reached-unnoticed":
      return "check-the-result";
    case "not-decided":
      return "undecided";
    case "covered-but-unreached":
      if (attribution === "exact") return "cover-the-branch";
      break;
    case "unreached-and-uncovered":
      if (attribution === "object" || attribution === "all-green") return "cover-the-statement";
      break;
  }
  throw new MalformedReportError(
    `lethal explain --suggest: reach ${JSON.stringify(reach)} with attribution ${JSON.stringify(attribution)} cannot occur`,
  );
}

/**
 * The suggestions section for `report` (already validated) and its projection `out`. Built from
 * `out.gaps`, which `--top` never shortens, and from the report's own rows, never `out.survivors`.
 */
export function suggest(report: SessionReport, out: ExplainOutput): ExplainSuggestions {
  if (out.gaps === undefined) {
    throw new SuggestionsUnavailableError(
      "lethal explain --suggest: this report's rows carry no gap ids (written before C02-09), so there are no gaps to suggest for. Re-run under this build.",
    );
  }
  const coverageMode: CoverageMode | undefined = report.coverageMode;
  const gaps = out.gaps.map((g): GapSuggestion => {
    const members = g.members.map((code): SuggestionMember => {
      // By gap id AND code, never code alone (codes restart per batch). The gap id fixes the
      // batch: `tallyGaps` refuses a gap spanning two.
      const rows = report.mutants.filter(
        (m) => m.gapId === g.gapId && m.mutantCode === code && m.verdict === "survived",
      );
      const [row] = rows;
      if (row === undefined || rows.length > 1) {
        throw new MalformedReportError(
          `lethal explain --suggest: gap ${g.gapId}'s member ${code} is not exactly one survived row`,
        );
      }
      const { attribution, reach } = survivorEvidenceOf(row, coverageMode);
      return {
        mutantCode: code,
        kind: row.readerMark !== undefined ? "reader-marked" : suggestionKindOf(reach, attribution),
        reach,
        attribution,
        ...(row.equivalenceRisk !== undefined ? { equivalenceRisk: row.equivalenceRisk } : {}),
      };
    });
    const kinds = [...new Set(members.map((m) => m.kind))];
    const [only] = kinds;
    if (only === undefined) {
      throw new MalformedReportError(`lethal explain --suggest: gap ${g.gapId} has no members`);
    }
    return { gapId: g.gapId, kind: kinds.length === 1 ? only : "mixed", members };
  });
  const used = new Set(gaps.flatMap((g) => g.members.map((m) => m.kind)));
  const kinds: SuggestionKindTexts = Object.fromEntries(
    Object.entries(SUGGESTION_TEXTS).filter(([k]) => used.has(k as SuggestionKind)),
  );
  return { label: SUGGESTIONS_LABEL, kinds, gaps };
}
