import { build } from "@lethal/operator-sdk";

/**
 * `lethal.flip-filter-literal`'s mini-parser: a refuse-by-default parser plus a fixed-precedence
 * mutation ladder for the CONTENT of a `SetFilter` string literal (the AL string with its outer
 * quotes already stripped and its `''` escapes already unescaped).
 *
 * Spec: docs/superpowers/specs/2026-08-12-r134-filter-literal-design.md §2.2-2.5.
 *
 * PURE MODULE, deliberately: no AST node types, no `MutationOperator` shape, no import from
 * `@lethal/engine`. Every function here is string-in, string-out, so it is testable in complete
 * isolation from the tree-sitter grammar and from BC. The one import, `build` from
 * `@lethal/operator-sdk`, is itself a pure string-builder with no AST surface (confirmed by
 * reading `packages/operator-sdk/src/build.ts` in full before depending on it); it is used only to
 * share the AL string-literal escape with the rest of the product rather than re-deriving it here
 * (spec §2.5).
 *
 * The refuse-by-default posture (spec §2.2, proposal 3) means every function below returns `null`
 * (never a guessed value) for any shape it does not explicitly recognise. `mutateFilterContent` is
 * the only function that MUTATES; everything else only classifies.
 */

/** The single highest-precedence mutation `mutateFilterContent` found, or the ladder rule that made it. */
export interface FilterMutation {
  readonly mutated: string;
  readonly rule: "flip-negation" | "shift-boundary" | "flip-open-range" | "drop-alternative";
}

/**
 * One AL comparator token recognised by rule 1 (`<>`) and rule 2 (`<`, `<=`, `>`, `>=`), plus the
 * bare `=` a comparator alternative may already carry. Checked longest-match first (`COMPARATOR_TOKENS`
 * below) so `<=` is never misread as `<` followed by a garbage remainder.
 */
type ComparatorToken = "<>" | "<=" | ">=" | "<" | ">" | "=";

const COMPARATOR_TOKENS: readonly ComparatorToken[] = ["<>", "<=", ">=", "<", ">", "="];

/**
 * Rule 2's paired boundary swap, kept as data (mirroring `swap-find-direction.ts`'s `DIRECTIONS`
 * table) so the mapping this operator emits cannot drift from the mapping a reader sees documented
 * here. `<>` and `=` are deliberately absent: rule 1 owns `<>`, and a bare `=` comparator has no
 * boundary-shift counterpart in the spec's ladder.
 */
const BOUNDARY_PAIRS: Readonly<Partial<Record<ComparatorToken, ComparatorToken>>> = {
  "<": "<=",
  "<=": "<",
  ">": ">=",
  ">=": ">",
};

/**
 * The characters spec §2.2 step 2 refuses outright, checked on the UNESCAPED content (after
 * `unquoteALString`, never on the raw AL source with its doubled quotes): `*`/`?` (filter
 * wildcards), `@` (case-insensitive prefix), `(`/`)` (no recognised shape uses parens), `'` (the
 * filter DSL's own inner quoting layer, which this parser does not implement), `&` (the AND
 * combinator). Any one of these refuses the WHOLE site before classification is attempted.
 */
const REFUSED_CHARACTERS = /[*?@()'&]/;

/** A single classified filter alternative (one `|`-separated slice of the filter content). */
export type ClassifiedAlternative =
  | { readonly kind: "comparator"; readonly token: ComparatorToken; readonly atom: string }
  | { readonly kind: "range"; readonly left: string; readonly right: string }
  | { readonly kind: "atom"; readonly value: string };

/**
 * Is `s` an ATOM under spec §2.2 step 4's shared predicate? Defined once, over a STRING, because
 * rule 1 needs it applied to a comparator's remainder, rule 2 needs it applied to each side of a
 * `..`, and rule 3 (via `classifyAlternative`'s range branch) needs it applied to each side too:
 * treating "atom" as three separately-restated notions is exactly how the pre-amendment draft let
 * an empty comparator remainder (`'<>'`) satisfy an unwritten notion of "atom" by accident (spec
 * §2.2 step 4, BLOCKER 1).
 *
 * `s` is an atom iff it is NON-EMPTY, contains no `..`, contains none of `<`, `>`, `=`, and either
 * matches a clean whole-string placeholder (`/^%\d+$/`) or contains no `%` at all. A `%` that is
 * present but does not form a clean, whole-string placeholder (`50%`, `%A`, `%1x`) satisfies
 * neither disjunct and therefore fails: `isAtom` is not a wildcard-`%` scanner.
 *
 * The non-empty check is the load-bearing line (red-checked: removing it lets `'<>'`'s empty
 * remainder classify as a comparator, and the ladder would then emit an unmeasured `'='`).
 */
function isAtom(s: string): boolean {
  if (s.length === 0) return false;
  if (s.includes("..")) return false;
  if (/[<>=]/.test(s)) return false;
  if (/^%\d+$/.test(s)) return true;
  return !s.includes("%");
}

/**
 * Rule 1/2 classification: does `s` start with one of `COMPARATOR_TOKENS` (longest match first)
 * with an ATOM remainder? Returns `null` for anything else, including a token whose remainder is
 * not an atom (`'<>'`'s empty remainder, `'<>1..5'`'s `..`-carrying remainder), so those fall
 * through to range/atom classification and, finding no match there either, refuse the whole site.
 */
function classifyComparator(
  s: string,
): { readonly kind: "comparator"; readonly token: ComparatorToken; readonly atom: string } | null {
  for (const token of COMPARATOR_TOKENS) {
    if (s.startsWith(token)) {
      const remainder = s.slice(token.length);
      if (isAtom(remainder)) return { kind: "comparator", token, atom: remainder };
    }
  }
  return null;
}

/**
 * Rule 3 classification: does `s` contain exactly one `..`, with each non-empty side an atom?
 * `left`/`right` empty-string denotes the OPEN side (`..X` has `left === ""`, `X..` has
 * `right === ""`); both non-empty is a CLOSED range (`X..Y`), a shape that classifies successfully
 * here but that no ladder rule targets (spec §2.2 step 4, §5). Both sides empty (`..` alone)
 * refuses: neither side is a shape any rule can act on.
 */
function classifyRange(
  s: string,
): { readonly kind: "range"; readonly left: string; readonly right: string } | null {
  const parts = s.split("..");
  if (parts.length !== 2) return null;
  const left = parts[0];
  const right = parts[1];
  if (left === undefined || right === undefined) return null;
  if (left === "" && right === "") return null;
  if (left !== "" && !isAtom(left)) return null;
  if (right !== "" && !isAtom(right)) return null;
  return { kind: "range", left, right };
}

/**
 * Classify one `|`-separated alternative into exactly one of the three recognised shapes
 * (comparator, range, atom), tried in that order per spec §2.2 step 4, or `null` if it matches
 * none. Classification is all-or-nothing PER ALTERNATIVE; `classifyContent` below is what makes it
 * all-or-nothing across a whole site.
 */
function classifyAlternative(s: string): ClassifiedAlternative | null {
  const comparator = classifyComparator(s);
  if (comparator !== null) return comparator;
  const range = classifyRange(s);
  if (range !== null) return range;
  if (isAtom(s)) return { kind: "atom", value: s };
  return null;
}

/**
 * Steps 2-4 of spec §2.2, run over a full filter CONTENT string: the cheap character refusal, the
 * split on top-level `|` with the empty-alternative and whitespace-mismatch refusals, and the
 * per-alternative classification. Returns the classified alternatives in original order, or `null`
 * if any step refuses.
 *
 * This is the ONE function spec §2.2 step 5 requires be reused, unchanged, to re-validate the
 * ladder's OUTPUT before `mutateFilterContent` returns a mutation: the same refusal surface that
 * governs a site's INPUT governs what any rule (this ladder's four, or a future one) is allowed to
 * emit. Exported so a unit test can call it directly, mirroring how `mutate-helpers.ts` exports
 * each of its pieces individually — in particular so the "rejoin leaves a stray `|`" hazard (spec
 * §2.2 step 5's own example) can be tested against the exact function step 5 relies on, not just
 * inferred from `mutateFilterContent`'s end-to-end behaviour.
 */
export function classifyContent(content: string): readonly ClassifiedAlternative[] | null {
  if (REFUSED_CHARACTERS.test(content)) return null;
  const parts = content.split("|");
  const classified: ClassifiedAlternative[] = [];
  for (const part of parts) {
    if (part.length === 0) return null;
    if (part !== part.trim()) return null;
    const c = classifyAlternative(part);
    if (c === null) return null;
    classified.push(c);
  }
  return classified;
}

/** Every `%` followed by one or more digits in `s`, sorted, for the placeholder-multiset check. */
export function extractPlaceholders(s: string): readonly string[] {
  return (s.match(/%\d+/g) ?? []).slice().sort();
}

/**
 * The placeholder-arity invariant (spec §2.4): the multiset of `%N` tokens must be identical
 * before and after. By construction, none of the four ladder rules below can violate this — rules
 * 1-3 rewrite only a leading token and leave the atom byte-for-byte unchanged, and rule 4 only ever
 * drops an alternative already proven placeholder-free — so this is a backstop against a bug in
 * that reasoning or in the classifier, not a case expected to fire. Per this repo's convention, a
 * caller-contract violation throws rather than silently proceeding.
 */
function assertPlaceholdersPreserved(before: string, after: string): void {
  const beforeList = extractPlaceholders(before);
  const afterList = extractPlaceholders(after);
  const same =
    beforeList.length === afterList.length && beforeList.every((v, i) => v === afterList[i]);
  if (!same) {
    throw new Error(
      `flip-filter-literal: placeholder multiset changed from [${beforeList.join(",")}] to ` +
        `[${afterList.join(",")}] (before: ${JSON.stringify(before)}, after: ${JSON.stringify(after)})`,
    );
  }
}

function replaceAt(parts: readonly string[], index: number, value: string): readonly string[] {
  return parts.map((p, i) => (i === index ? value : p));
}

/**
 * Step 5 (spec §2.2): re-classify the ladder's candidate output with the SAME `classifyContent`
 * used on input, refuse (return `null`, not a corrupted mutant) if it does not classify, then
 * assert the placeholder invariant and return the accepted mutation. Every ladder rule below routes
 * its candidate through this one function so no rule's output escapes re-validation.
 */
function finalizeMutation(
  originalContent: string,
  mutatedContent: string,
  rule: FilterMutation["rule"],
): FilterMutation | null {
  if (classifyContent(mutatedContent) === null) return null;
  assertPlaceholdersPreserved(originalContent, mutatedContent);
  return { mutated: mutatedContent, rule };
}

/**
 * The mutation ladder (spec §2.3): rules 1-4, tried in that fixed order. At each rule, every
 * alternative is scanned LEFT TO RIGHT; the first one matching that rule's shape is mutated and the
 * ladder stops — later rules are never tried once an earlier one has fired. Returns the single
 * highest-precedence applicable mutation, or `null` to REFUSE the site (either because `content`
 * itself does not classify under steps 2-4, or because classification succeeds but no rule in the
 * ladder finds anything to do — "ladder exhaustion", a distinct outcome from parser refusal per
 * spec §5, e.g. a closed range or a lone placeholder atom).
 */
export function mutateFilterContent(content: string): FilterMutation | null {
  const classified = classifyContent(content);
  if (classified === null) return null;
  const parts = content.split("|");

  // Rule 1: negation flip. '<>' -> '='.
  for (let i = 0; i < classified.length; i++) {
    const c = classified[i];
    if (c !== undefined && c.kind === "comparator" && c.token === "<>") {
      return finalizeMutation(
        content,
        replaceAt(parts, i, `=${c.atom}`).join("|"),
        "flip-negation",
      );
    }
  }

  // Rule 2: boundary shift. '<' <-> '<=', '>' <-> '>='.
  for (let i = 0; i < classified.length; i++) {
    const c = classified[i];
    if (c !== undefined && c.kind === "comparator") {
      const replacement = BOUNDARY_PAIRS[c.token];
      if (replacement !== undefined) {
        return finalizeMutation(
          content,
          replaceAt(parts, i, `${replacement}${c.atom}`).join("|"),
          "shift-boundary",
        );
      }
    }
  }

  // Rule 3: open-range flip. '..X' <-> 'X..'. A closed range (both sides non-empty) never matches.
  for (let i = 0; i < classified.length; i++) {
    const c = classified[i];
    if (c !== undefined && c.kind === "range") {
      if (c.left === "" && c.right !== "") {
        return finalizeMutation(
          content,
          replaceAt(parts, i, `${c.right}..`).join("|"),
          "flip-open-range",
        );
      }
      if (c.right === "" && c.left !== "") {
        return finalizeMutation(
          content,
          replaceAt(parts, i, `..${c.left}`).join("|"),
          "flip-open-range",
        );
      }
    }
  }

  // Rule 4: drop the first placeholder-free alternative. Requires two or more alternatives.
  if (parts.length >= 2) {
    for (let i = 0; i < classified.length; i++) {
      const c = classified[i];
      if (c !== undefined && c.kind === "atom" && !c.value.includes("%")) {
        const dropped = parts.filter((_, idx) => idx !== i);
        return finalizeMutation(content, dropped.join("|"), "drop-alternative");
      }
    }
  }

  return null;
}

/**
 * Inverse of `build.textLiteral` (`packages/operator-sdk/src/build.ts`): strip the delimiting `'`
 * and unescape `''` back to `'`. Returns `null` for anything that is not a plain `'...'` literal
 * shape (unbalanced delimiters, no delimiters at all), rather than throwing — this function is a
 * general-purpose primitive, not a check that already knows its input is a `text_literal` node's
 * text; a caller that DOES already know that (the operator built on top of this module) is the one
 * with grounds to treat a `null` here as a caller-contract violation.
 */
export function unquoteALString(literal: string): string | null {
  const match = /^'((?:[^']|'')*)'$/.exec(literal);
  if (match === null) return null;
  const inner = match[1];
  if (inner === undefined) return null;
  return inner.replace(/''/g, "'");
}

/**
 * Re-encode `content` as an AL string literal, delegating to `build.textLiteral` (spec §2.5) rather
 * than a second, hand-rolled escaper, so the encode and decode halves of this module can never
 * drift from each other or from the rest of the product's own AL emission.
 */
export function quoteALString(content: string): string {
  return build.textLiteral(content).toAL();
}
