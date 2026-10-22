/**
 * A member's attribute run (R-278, R420), moved here from runner's testpage-scan.ts by R474 so
 * schemata can hash a member WITH its attributes. One copy: runner's `memberRun` keeps its policy
 * (widen for a test procedure, narrow otherwise, `andTrivia` for R-371's parts) on top of this.
 */
import { ARM_MARKERS as PREPROC_BRANCH_MARKER, TRIVIA_KINDS as TRIVIA } from "./preproc-arms";
import type { ALSyntaxNode } from "./syntax-node";

/** Every `attribute_item` in an `#if` that holds attributes only, every arm, in source order. */
function attributesInConditional(n: ALSyntaxNode, out: ALSyntaxNode[] = []): ALSyntaxNode[] {
  for (const c of n.namedChildren) {
    if (c.rawKind === "attribute_item") out.push(c);
    else if (c.rawKind === "preproc_conditional") attributesInConditional(c, out);
  }
  return out;
}

/**
 * R420: whether `n` is an `#if` whose every arm holds attributes only (comments and nested
 * attribute-only `#if`s allowed), with at least one attribute: `#if X [HandlerFunctions('H')]
 * #endif` in a member's attribute run. Its attributes belong to the member after it.
 */
function isAttributeConditional(n: ALSyntaxNode): boolean {
  if (n.rawKind !== "preproc_conditional") return false;
  const onlyAttributes = (c: ALSyntaxNode): boolean =>
    c.namedChildren.every(
      (x) =>
        x.rawKind === "attribute_item" ||
        PREPROC_BRANCH_MARKER.has(x.rawKind) ||
        TRIVIA.has(x.rawKind) ||
        (x.rawKind === "preproc_conditional" && onlyAttributes(x)),
    );
  return onlyAttributes(n) && attributesInConditional(n).length > 0;
}

/** Where an arm of a `preproc_conditional` starts. */
const ARM_START = new Set(["preproc_if", "preproc_elif", "preproc_else"]);

/** A member's attribute run: the source it spans and the attributes in it. */
export interface AttributeRun {
  /** `[from, to)` pieces in source order; the last ends at the member's end. One piece, except
   *  for S11 below. */
  readonly pieces: ReadonlyArray<readonly [number, number]>;
  /** Every attribute in the run, every `#if` arm's included, nearest first. */
  readonly attributes: readonly ALSyntaxNode[];
  /** Whether the run took an `#if` (an attribute-only one, or S11's arm): only then are the
   *  handler lists a union (`procOf`). */
  readonly conditional: boolean;
}

/**
 * `decl`'s attribute run, R-278's span rule as R420 extends it. The run is the siblings directly
 * before `decl`: attributes, trivia between them, and (R420) an `#if` that holds attributes only,
 * whose attributes are taken from EVERY arm (the union: the digest walks every handler a build
 * might use, the TestPage scan sees every TestPage one might touch). The span starts at the run's
 * first node, so editing a handler list inside `#if` edits the test.
 *
 * With `andTrivia`, trivia directly before is taken too: R-371's object parts leave a doc comment
 * above a procedure out, so adding a commented test to a codeunit does not read as an edit to its
 * header.
 *
 * S11 (`[Test]` then `#if X procedure A ... #else procedure B ... #endif`): the compiler gives
 * each arm's procedure the attributes before the `#if`. When the run inside the arm reaches the
 * arm's start, and the run before the `#if` holds an attribute, that run is the procedure's too.
 * The span is then two pieces, that outer run and the arm's own run to the procedure's end, so
 * an edit to the other arm's procedure is not an edit to this one.
 *
 * Without `widen`, neither R420 extension applies: R-278's pre-R420 run (`memberRun` chooses).
 */
export function attributeRun(
  decl: ALSyntaxNode,
  andTrivia: boolean,
  end: number,
  widen: boolean,
): AttributeRun {
  let start = decl.startIndex;
  const attributes: ALSyntaxNode[] = [];
  const siblings = decl.parent?.namedChildren ?? [];
  let i = siblings.findIndex((x) => x.startIndex === decl.startIndex);
  let atArmStart = false;
  let conditional = false;
  for (i -= 1; i >= 0; i -= 1) {
    const x = siblings[i];
    if (x === undefined) break;
    if (x.rawKind === "attribute_item") {
      attributes.push(x);
      start = x.startIndex;
    } else if (widen && isAttributeConditional(x)) {
      attributes.push(...attributesInConditional(x).reverse());
      start = x.startIndex;
      conditional = true;
    } else if (TRIVIA.has(x.rawKind)) {
      if (andTrivia) start = x.startIndex;
    } else {
      atArmStart = ARM_START.has(x.rawKind);
      break;
    }
  }
  const own: AttributeRun = { pieces: [[start, end]], attributes, conditional };
  const cond = decl.parent;
  if (!widen || !atArmStart || cond === null || cond.rawKind !== "preproc_conditional") return own;
  const outer = attributeRun(cond, andTrivia, cond.startIndex, true);
  if (outer.attributes.length === 0) return own;
  return {
    pieces: [...outer.pieces, [start, end]],
    attributes: [...attributes, ...outer.attributes],
    conditional: true,
  };
}

/** A span's text: its pieces joined by a newline (one piece is the plain slice, as before R420). */
export const spanText = (source: string, run: AttributeRun): string =>
  run.pieces.map(([from, to]) => source.slice(from, to)).join("\n");

/**
 * R474: `member`'s RAW source from its first attribute to its end: the WIDENED run (attribute-only
 * `#if` wrappers and S11's outer run in), whether or not it is a test, without the trivia above.
 * Nothing is normalised, so a CRLF/LF difference reads as an edit (a safe false refusal).
 */
export const memberSpanText = (source: string, member: ALSyntaxNode): string =>
  spanText(source, attributeRun(member, false, member.endIndex, true));
