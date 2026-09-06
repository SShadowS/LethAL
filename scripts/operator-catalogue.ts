/**
 * Build a catalogue of every mutation LethAL can make, as data for a presentation page.
 *
 * The examples are not written for the slide deck. They ARE the operators' own conformance cases,
 * the ones `bun test` proves on every run, so a slide can never drift from what the tool does. A
 * case whose golden says the operator emits nothing is rendered as a REFUSAL, which is often the
 * more interesting slide: it is where LethAL declines a site on purpose and can say why.
 *
 * Offsets are taken by re-running the operator against the LAID-OUT source rather than the
 * one-liner, so the highlighted span points into the text actually shown. That is also a check: if
 * an operator produced a different number of mutations against the formatted source, the layout
 * pass changed meaning, and this script says so instead of drawing a wrong picture.
 *
 * Usage: bun scripts/operator-catalogue.ts <out.json>
 */
import { writeFile } from "node:fs/promises";
import { tier1Operators } from "../packages/builtin-tier1/src/index";
import { tier2Operators } from "../packages/builtin-tier2/src/index";
import { initParser, parseAL } from "../packages/engine/src/ast/parser";
import { type ALSyntaxNode, wrapRoot } from "../packages/engine/src/ast/syntax-node";
import type { MutationOperator, MutationSpec } from "../packages/engine/src/operator/interface";
import { buildSemanticContext } from "../packages/engine/src/semantic/context";
import { layoutAL, leafTokens } from "./lib/al-layout";

const [outPath] = process.argv.slice(2);
if (outPath === undefined) {
  console.error("usage: bun scripts/operator-catalogue.ts <out.json>");
  process.exit(2);
}

await initParser();

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Which CSS class a leaf token gets.
 *
 * Driven by the grammar rather than by a keyword list, because a list is only ever as complete as
 * the last person's memory. The tree-sitter grammar names a keyword node after the keyword itself
 * (`if`, `then`, `var`, `codeunit`, `record`), so a leaf whose KIND equals its own lowercased text
 * is a keyword, and the `_keyword` suffix catches `begin_keyword` and `end_keyword`.
 */
function classOf(kind: string, text: string): string {
  if (kind === "integer" || kind === "decimal") return "num";
  if (kind === "string_literal") return "str";
  if (kind === "quoted_identifier") return "qid";
  if (kind === "identifier") return "id";
  if (kind === "basic_type") return "ty";
  if (kind === "comment") return "cm";
  // Punctuation must be tested BEFORE the keyword rule. The grammar names a `{` node `{`, so
  // `kind === text` is true for every bracket and operator and would paint them all as keywords.
  if (!/^[A-Za-z_]/.test(text)) return "pn";
  if (kind.endsWith("_keyword") || kind === text.toLowerCase()) return "kw";
  return "pn";
}

/**
 * Syntax-highlighted HTML for `src`, with the half-open range `[markStart, markEnd)` wrapped so a
 * reader's eye lands on the mutated span without hunting for it. A mutation slide where the change
 * has to be searched for is a failed slide.
 */
function highlight(src: string, markStart?: number, markEnd?: number): string {
  let tokens: ALSyntaxNode[];
  try {
    tokens = leafTokens(wrapRoot(parseAL(src)));
  } catch {
    return escapeHtml(src);
  }

  const pieces: string[] = [];
  let cursor = 0;
  let marking = false;

  const openMarkIfDue = (at: number): void => {
    if (markStart !== undefined && !marking && at >= markStart) {
      pieces.push('<mark class="mut">');
      marking = true;
    }
  };
  const closeMarkIfDue = (at: number): void => {
    if (marking && markEnd !== undefined && at >= markEnd) {
      pieces.push("</mark>");
      marking = false;
    }
  };

  for (const t of tokens) {
    if (t.startIndex < cursor) continue;
    if (t.startIndex > cursor) {
      // Whitespace between tokens, kept verbatim so indentation survives.
      closeMarkIfDue(cursor);
      openMarkIfDue(cursor);
      pieces.push(escapeHtml(src.slice(cursor, t.startIndex)));
      cursor = t.startIndex;
    }
    closeMarkIfDue(cursor);
    openMarkIfDue(cursor);
    pieces.push(`<span class="${classOf(t.rawKind, t.text)}">${escapeHtml(t.text)}</span>`);
    cursor = t.endIndex;
  }
  closeMarkIfDue(cursor);
  if (cursor < src.length) pieces.push(escapeHtml(src.slice(cursor)));
  if (marking) pieces.push("</mark>");
  return pieces.join("");
}

/** Every spec the operator emits for this source, with offsets into `src`. */
function specsFor(op: MutationOperator, src: string): MutationSpec[] {
  const root = wrapRoot(parseAL(src));
  const ctx = buildSemanticContext([{ path: "catalogue.al", root }]);
  const found: MutationSpec[] = [];
  const walk = (n: ALSyntaxNode): void => {
    if (op.targets(n, ctx)) found.push(...op.generate(n, ctx));
    for (const c of n.children) walk(c);
  };
  walk(root);
  return found;
}

interface Mutation {
  readonly beforeHtml: string;
  readonly afterHtml: string;
  readonly beforeText: string;
  readonly afterText: string;
  readonly hangCapable?: string;
}

const operators = [];
let caseCount = 0;
let mutationCount = 0;
let refusalCount = 0;
const layoutDrift: string[] = [];

for (const op of [...tier1Operators, ...tier2Operators].sort((a, b) =>
  a.name.localeCompare(b.name),
)) {
  const cases = [];
  for (const c of op.conformanceTests) {
    caseCount += 1;
    const source = layoutAL(c.sourceAL);
    const specs = specsFor(op, source);

    // The layout pass must not change what the operator sees. The golden says how many mutations
    // this source yields; if the laid-out source yields a different number, the picture would be
    // wrong and this is the only place that would notice.
    if (specs.length !== c.expectedSpecs.length) {
      layoutDrift.push(
        `${op.name} / ${c.name}: golden expects ${c.expectedSpecs.length}, laid-out source yields ${specs.length}`,
      );
    }

    const mutations: Mutation[] = specs.map((spec) => {
      const start = spec.before.startIndex;
      const end = spec.before.endIndex;
      const afterText = (spec.after as { text?: string }).text ?? "";
      const afterSource = source.slice(0, start) + afterText + source.slice(end);
      return {
        beforeHtml: highlight(source, start, end),
        afterHtml: highlight(afterSource, start, start + afterText.length),
        beforeText: spec.before.text,
        afterText,
        ...(spec.hangCapable !== undefined ? { hangCapable: spec.hangCapable } : {}),
      };
    });

    mutationCount += mutations.length;
    if (mutations.length === 0) refusalCount += 1;

    cases.push({
      name: c.name,
      sourceHtml: highlight(source),
      refused: mutations.length === 0,
      mutations,
    });
  }

  operators.push({
    name: op.name,
    tier: op.tier,
    version: op.version,
    requiresSemantic: op.requiresSemantic,
    equivalenceRisk: (op as { equivalenceRisk?: string }).equivalenceRisk ?? null,
    cases,
  });
}

if (operators.length === 0 || caseCount === 0) {
  throw new Error(
    `operator-catalogue: found ${operators.length} operator(s) and ${caseCount} case(s). An empty catalogue is a wiring failure, not a result.`,
  );
}

await writeFile(
  outPath,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString().slice(0, 10),
      operatorCount: operators.length,
      caseCount,
      mutationCount,
      refusalCount,
      layoutDrift,
      operators,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

console.log(
  `${operators.length} operators, ${caseCount} cases, ${mutationCount} mutations, ${refusalCount} refusals -> ${outPath}`,
);
if (layoutDrift.length > 0) {
  console.log(`\nLAYOUT DRIFT (${layoutDrift.length}), the picture would be wrong for these:`);
  for (const d of layoutDrift) console.log(`  ${d}`);
}
