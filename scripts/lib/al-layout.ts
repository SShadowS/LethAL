/**
 * Lay out a compact AL snippet across lines, for presentation.
 *
 * This exists because the conformance fixtures are written as one-liners, which is right for a test
 * fixture and unreadable on a slide:
 *
 *     codeunit 51302 "C" { procedure P(A: Integer) begin if A > 0 then exit(1); end; }
 *
 * It is NOT a general AL formatter and does not try to be. It handles the shape those fixtures use,
 * and its correctness bar is narrow and checkable: the token stream must come out identical, which
 * `al-layout.test.ts` asserts over every committed conformance source. A layout pass that changed
 * what the code MEANS would be worse than no layout at all, so that check is the point.
 *
 * The alternative considered was `al-prettier`, which is a real AL formatter and does this properly.
 * It is not published to npm, only to the VS Code marketplace, so using it would mean vendoring an
 * ANTLR parser and plugin source into this repository to typeset a slide deck. That is a large
 * dependency for a small need, and this repository already ships an AL parser whose output can be
 * compared before and after.
 */
import { parseAL } from "../../packages/engine/src/ast/parser";
import { type ALSyntaxNode, wrapRoot } from "../../packages/engine/src/ast/syntax-node";

/** Every leaf token of the tree, in source order. */
export function leafTokens(node: ALSyntaxNode): ALSyntaxNode[] {
  if (node.children.length === 0) return [node];
  return node.children.flatMap(leafTokens);
}

/**
 * The token texts of a source, concatenated with all whitespace removed.
 *
 * Two sources with the same stream are the same program as far as the parser is concerned, which is
 * what makes it a usable equivalence check for a layout pass.
 */
export function alTokenStream(src: string): string {
  return leafTokens(wrapRoot(parseAL(src)))
    .map((t) => t.text)
    .filter((s) => s.trim() !== "")
    .join("");
}

const INDENT = "    ";

/** Tokens that take no space before them, so a call reads `P(A)` rather than `P ( A )`. */
const NO_SPACE_BEFORE = new Set(["(", ")", ",", ".", ";", ":"]);

export function layoutAL(src: string): string {
  const out: string[] = [];
  let depth = 0;
  let line = "";
  let inVarSection = false;
  let parenDepth = 0;

  const flush = (): void => {
    if (line.trim() !== "") out.push(INDENT.repeat(Math.max(0, depth)) + line.trim());
    line = "";
  };

  for (const token of leafTokens(wrapRoot(parseAL(src)))) {
    const text = token.text;
    if (text === "") continue;
    const lower = text.toLowerCase();

    if (text === "{") {
      line += (line === "" ? "" : " ") + text;
      flush();
      depth += 1;
      continue;
    }

    if (text === "}") {
      flush();
      depth -= 1;
      line = text;
      flush();
      continue;
    }

    // A `var` SECTION goes on its own line and indents the declarations under it. Only outside
    // parentheses: inside, `var` is a by-reference parameter modifier (`procedure P(var Rec: ...)`)
    // and breaking there would be wrong.
    if (lower === "var" && parenDepth === 0) {
      flush();
      line = text;
      flush();
      depth += 1;
      inVarSection = true;
      continue;
    }

    // `begin` starts its own line, and closes any preceding `var` section first.
    if (lower === "begin") {
      if (inVarSection) {
        depth -= 1;
        inVarSection = false;
      }
      flush();
      line = text;
      flush();
      depth += 1;
      continue;
    }

    if (lower === "end") {
      flush();
      depth -= 1;
      line = text;
      continue;
    }

    if (text === ";") {
      line += text;
      flush();
      continue;
    }

    if (NO_SPACE_BEFORE.has(text)) {
      if (text === "(") parenDepth += 1;
      if (text === ")") parenDepth = Math.max(0, parenDepth - 1);
      line += text;
      continue;
    }

    const noSpaceAfterPrevious = line.endsWith("(") || line.endsWith(".");
    line += (line === "" || noSpaceAfterPrevious ? "" : " ") + text;
  }

  flush();
  return out.join("\n");
}
