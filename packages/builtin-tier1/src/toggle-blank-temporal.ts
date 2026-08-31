import {
  ALNodeKind,
  type ALSyntaxNode,
  type MutationOperator,
  type MutationSpec,
  type SemanticContext,
} from "@lethal/operator-sdk";
import { synthesizeAfter } from "./mutate-helpers";

const OPERATOR_NAME = "lethal.toggle-blank-temporal";
const OPERATOR_VERSION = "1.0.0";

/**
 * The non-blank stand-ins, one per temporal type.
 *
 * Chosen to be unmistakably non-blank while being the least plausible real business values in a BC
 * file, so a reader meeting one in a diff cannot mistake it for domain data. Unlike
 * `toggle-blank-string`'s single character, there is no overflow constraint to satisfy: a `Date` has
 * no length to overflow.
 *
 * The DateTime form is a CALL, not a literal, and that is forced rather than chosen. AL has no
 * non-blank DateTime literal; non-blank DateTimes are constructed. Measured on `do-rel2/Cloud`, all
 * 44 datetime literals in the corpus are `0DT`. `alc` 18.0.40.47373 compiles this form clean in both
 * positions this operator emits into, assignment and `=` comparison operand.
 */
const NON_BLANK: Readonly<Record<string, string>> = {
  [ALNodeKind.date_literal]: "17530101D",
  [ALNodeKind.time_literal]: "000001T",
  [ALNodeKind.datetime_literal]: "CREATEDATETIME(17530101D, 000001T)",
};

/** The blank form of each temporal type, which is what 92 of the 96 claimable sites already are. */
const BLANK: Readonly<Record<string, string>> = {
  [ALNodeKind.date_literal]: "0D",
  [ALNodeKind.time_literal]: "0T",
  [ALNodeKind.datetime_literal]: "0DT",
};

/**
 * Parent kinds where a temporal literal is a value the program BRANCHES ON or STORES.
 *
 * The same set `toggle-blank-string` uses, and for the same measured reason. Of 125 temporal
 * literals in procedure and trigger bodies on `do-rel2/Cloud`, 96 sit here (50 comparison operands,
 * 46 assigned values). The 29 dropped are 27 in an `argument_list`, where the literal's meaning
 * depends on a callee this layer cannot resolve, plus one `exit_statement` and one
 * `additive_expression`.
 */
const BEHAVIOURAL_PARENTS: ReadonlySet<string> = new Set([
  ALNodeKind.comparison_expression,
  ALNodeKind.assignment_statement,
]);

/**
 * `ToggleBlankTemporal`: a blank date, time or datetime literal becomes non-blank, and a non-blank
 * one becomes blank.
 *
 * ROADMAP [[R159]], and the first candidate admitted under [[R013]]'s amended bar. Priced at **96
 * marginal sites** against a floor of 36, which is 2.7x and clears the 36-to-44 band that rule calls
 * undecided. Spike: `docs/superpowers/specs/2026-08-31-toggle-blank-temporal-spike.md`.
 *
 * **The corpus chose the shape, not taste.** The obvious temporal operator shifts a date by a day,
 * the `conditional-boundary` analogue. It was measured and refused: **92 of the 96 claimable
 * literals are blank**, so a shift operator would have had four sites. `0D` is AL's blank date and
 * `if Rec."Due Date" = 0D then` is the idiomatic "is it set" check, so blank against not-blank is
 * the question worth asking.
 *
 * **Sizing took three passes and the first two were wrong**, the same trap `toggle-blank-string`
 * records: 125 raw kind count, 96 once filtered to behavioural parents, of which 92 blank. An
 * operator scoped from the raw count would have claimed 29 sites it cannot mutate meaningfully.
 *
 * **No `PlatformKillMechanism`, following `toggle-blank-string` and `remove-assignment` rather than
 * re-deciding it.** Blanking a date that a later `TestField` or key depends on can raise with no test
 * asserting anything. That is ordinary changed behaviour, not a skipped trigger, and R121's screen is
 * what tells a reader a kill carried no assertion. R138's mechanisms are for mutations that skip a
 * TRIGGER while leaving control flow alone.
 *
 * **Documented limits:**
 *   - Equivalence is not detected. A blank check whose blank branch no test drives is an equivalent
 *     mutant here, and no source-derived layer can see that.
 *   - The non-blank forms are stand-ins, not meaningful values. This operator answers "does anything
 *     depend on this being set or not", never "does anything depend on this exact instant".
 *   - The DateTime arm's replacement is a call, so it is the one arm whose mutant text is longer than
 *     its original. Nothing in the schemata compiler cares, and the compile probe proves it, but it
 *     is the arm to look at first if an artifact ever fails to build.
 */
export const toggleBlankTemporal: MutationOperator = {
  name: OPERATOR_NAME,
  version: OPERATOR_VERSION,
  tier: 1,
  // R120's hazard: these are ENUM KEYS whose values are the raw tree-sitter type names. For these
  // three the key and the value happen to coincide, unlike `text_literal` -> `"string_literal"`,
  // which is exactly the asymmetry that makes writing the raw name by hand a mistake waiting to
  // happen. The conformance suite is what proves the predicate matches anything at all.
  targetNodeKinds: [ALNodeKind.date_literal, ALNodeKind.time_literal, ALNodeKind.datetime_literal],
  producesNodeKinds: [
    ALNodeKind.date_literal,
    ALNodeKind.time_literal,
    ALNodeKind.datetime_literal,
  ],
  requiresSemantic: [],
  // R172: it rewrites a written value, like `toggle-blank-string` and `remove-assignment`.
  equivalenceRisk: "value-rewrite",

  targets(node: ALSyntaxNode, _ctx: SemanticContext): boolean {
    return toggled(node) !== null;
  },

  generate(node: ALSyntaxNode, _ctx: SemanticContext): readonly MutationSpec[] {
    const after = toggled(node);
    if (after === null) return [];
    return [
      {
        operatorName: OPERATOR_NAME,
        operatorVersion: OPERATOR_VERSION,
        astNodeId: `${node.startIndex}-${node.endIndex}`,
        before: node,
        after: synthesizeAfter(node, after),
        parentContext: "statement-position",
      },
    ];
  },

  conformanceTests: [
    {
      name: "UN-blanks a blank date comparison operand: 92 of 96 claimable sites are this shape",
      sourceAL: `codeunit 51910 "S" { procedure P(D: Date): Integer begin if D = 0D then exit(1); exit(0); end; }`,
      expectedSpecs: [
        { parentContext: "statement-position", beforeText: "0D", afterText: "17530101D" },
      ],
    },
    {
      name: "blanks a non-blank assigned date",
      sourceAL: `codeunit 51911 "S" { procedure P() var D: Date; begin D := 20240402D; end; }`,
      expectedSpecs: [
        { parentContext: "statement-position", beforeText: "20240402D", afterText: "0D" },
      ],
    },
    {
      name: "UN-blanks a blank time",
      sourceAL: `codeunit 51912 "S" { procedure P() var T: Time; begin T := 0T; end; }`,
      expectedSpecs: [
        { parentContext: "statement-position", beforeText: "0T", afterText: "000001T" },
      ],
    },
    {
      name: "UN-blanks a blank datetime with a CALL, because AL has no non-blank DateTime literal",
      sourceAL: `codeunit 51913 "S" { procedure P() var DT: DateTime; begin DT := 0DT; end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: "0DT",
          afterText: "CREATEDATETIME(17530101D, 000001T)",
        },
      ],
    },
    {
      name: "REFUSES an argument-list literal, whose meaning depends on a callee this layer cannot resolve",
      sourceAL: `codeunit 51914 "S" { procedure P() begin Foo(0D); end; procedure Foo(D: Date) begin end; }`,
      expectedSpecs: [],
    },
    {
      name: "REFUSES a declarative property, which R135 rules out",
      sourceAL: `table 51915 "T" { fields { field(1; "D"; Date) { InitValue = 0D; } } }`,
      expectedSpecs: [],
    },
  ],
};

/** The toggled literal text, or `null` where this operator does not claim the site. */
function toggled(node: ALSyntaxNode): string | null {
  const kind = node.rawKind;
  const blank = BLANK[kind];
  const nonBlank = NON_BLANK[kind];
  if (blank === undefined || nonBlank === undefined) return null;
  const parent = node.parent;
  if (parent === null || !BEHAVIOURAL_PARENTS.has(parent.rawKind)) return null;
  // Executable only. An allow-list, for the reason `flip-boolean-literal` learned the hard way: a
  // deny-list of declarative parents is only ever as complete as the last person's memory.
  if (!inExecutableBody(node)) return null;
  // Case-insensitive: AL accepts `0d` and `0D`, and a literal written either way is the same blank.
  return node.text.trim().toUpperCase() === blank ? nonBlank : blank;
}

function inExecutableBody(node: ALSyntaxNode): boolean {
  for (let p: ALSyntaxNode | null = node.parent; p !== null; p = p.parent) {
    if (p.rawKind === "procedure" || p.rawKind === "trigger_declaration") return true;
  }
  return false;
}
