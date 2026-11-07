import { claimsSystemCall } from "@lethal/engine";
import {
  ALNodeKind,
  type ALSyntaxNode,
  type MutationOperator,
  type MutationSpec,
  type SemanticContext,
  isStatementPosition,
} from "@lethal/operator-sdk";
import { countArguments, synthesizeAfter } from "./mutate-helpers";

/**
 * `SwapWorkDateToday` (R856, #33), OPT-IN: `WorkDate()` -> `Today()` and `Today()` -> `WorkDate()`,
 * one mutant per site, in statement and expression position (a date getter is mostly read as a
 * value, so there is no statement-slot test here).
 *
 * WHAT A SURVIVOR MEANS: no test depends on which date is read. Where a test sets no work date the
 * two getters return the same day, so the swap is invisible; only a test that sets its own date
 * with `WorkDate(D)` and asserts a value derived from it tells the two apart. Name this operator
 * (`--operator swap-workdate-today`) on a project whose tests set their own date. It is not part of
 * a default run: on code whose tests never set a date every mutant would survive and say nothing.
 *
 * Claims, all of them:
 *   1. `claimsSystemCall` on the SOURCE name: receiverless, and no project procedure of that name
 *      shadows the system function.
 *   2. `countArguments === 0`: `WorkDate(D)` is the setter and is never swapped.
 *   3. The TARGET name must be free too. A project that declares a variable, parameter, return
 *      name, field or procedure called `Today` (or `WorkDate`) anywhere would bind the replacement
 *      to that declaration and fail to compile, so the site is refused. Project-wide and
 *      conservative: a namesake in an unrelated object also refuses.
 *   4. The hang rule is NOT here (Tier 2 cannot read the loop analysis): the dispatch in
 *      `generateMutationSet` calls `clockSwapHangs`, which refuses a site in a loop's exit parts,
 *      a value that feeds such an exit, and a getter inside a `WorkDate(...)` setter argument in a
 *      loop. Both directions are refused at such a site, and the refusal is counted.
 *
 * Named limits (not refused):
 *   - A deadline computed BEFORE a loop, `Deadline := CreateDateTime(WorkDate(), T)`, then
 *     `until CurrentDateTime > Deadline`: the swap moves the deadline, and the loop is not frozen
 *     by it, but the verdict reads the clock. Only the feed rule above can see it.
 *   - A helper in the exit, `until Expired()` with `Expired` reading the clock: the getter is
 *     outside the loop and is not seen as an exit part.
 *   - The parenthesis-less forms (`Today`, `WorkDate`) parse as identifiers and are not claimed.
 *   - A base-application table or page procedure named `Today` or `WorkDate` is invisible here, as
 *     it is to `claimsSystemCall`.
 *   - Day dependence: both getters read the calendar day, so a test that compares them with a fixed
 *     date literal can change its verdict with the day. The fixture sets its own date and asserts
 *     only values derived from it. R856's measurements: a `WorkDate(D)` set by one test leaks to
 *     later tests of the same codeunit on al-runner v3 and does not on BC (one method per call).
 *   - BC and v3 differ on a set date. bcdev runs one test method per call, so a date a test set is
 *     gone for the next one; v3 sends a whole codeunit, so the date leaks to the tests after it
 *     within that codeunit. A verdict can differ for a test that reads a date after an earlier test
 *     set it. The `sandbox-dates` fixture does not exercise that.
 *   - A setter in a helper, `repeat AdvanceHelper(); until WorkDate() > E`: a clock site this
 *     operator claims inside the helper is outside the loop and is not refused (see
 *     `clockSwapHangs`).
 */
export const swapWorkDateToday: MutationOperator = {
  name: "lethal.swap-workdate-today",
  version: "1.0.0",
  tier: 2,
  optIn: true,
  targetNodeKinds: [ALNodeKind.procedure_call],
  producesNodeKinds: [ALNodeKind.procedure_call],
  requiresSemantic: ["symbol-table"],

  targets(node: ALSyntaxNode, ctx: SemanticContext): boolean {
    return replacementFor(node, ctx) !== null;
  },

  generate(node: ALSyntaxNode, ctx: SemanticContext): readonly MutationSpec[] {
    const after = replacementFor(node, ctx);
    if (after === null) return [];
    return [
      {
        operatorName: "lethal.swap-workdate-today",
        operatorVersion: "1.0.0",
        astNodeId: `${node.startIndex}-${node.endIndex}`,
        before: node,
        after: synthesizeAfter(node, after),
        parentContext: isStatementPosition(node) ? "statement-position" : "expression-position",
      },
    ];
  },

  conformanceTests: [
    {
      name: "swaps WorkDate() for Today() in expression position",
      sourceAL: `codeunit 50190 "C" { procedure P(): Date begin exit(WorkDate()); end; }`,
      expectedSpecs: [
        { parentContext: "expression-position", beforeText: "WorkDate()", afterText: "Today()" },
      ],
    },
    {
      name: "swaps Today() for WorkDate() in an assignment",
      sourceAL: `codeunit 50191 "C" { procedure P() var D: Date; begin D := Today(); end; }`,
      expectedSpecs: [
        { parentContext: "expression-position", beforeText: "Today()", afterText: "WorkDate()" },
      ],
    },
    {
      name: "refuses the WorkDate(D) setter",
      sourceAL: `codeunit 50192 "C" { procedure P(D: Date) begin WorkDate(D); end; }`,
      expectedSpecs: [],
    },
    {
      name: "refuses when the other name is a local variable",
      sourceAL: `codeunit 50193 "C" { procedure P() var Today: Date; D: Date; begin D := WorkDate(); end; }`,
      expectedSpecs: [],
    },
  ],
};

function replacementFor(node: ALSyntaxNode, ctx: SemanticContext): string | null {
  if (node.kind !== ALNodeKind.procedure_call) return null;
  if (countArguments(node) !== 0) return null;
  const [from, to] = claimsSystemCall(node, ctx, "WorkDate")
    ? (["WorkDate", "Today"] as const)
    : claimsSystemCall(node, ctx, "Today")
      ? (["Today", "WorkDate"] as const)
      : [null, null];
  if (from === null) return null;
  if (declaredNames(ctx).has(to.toLowerCase())) return null;
  return `${to}()`;
}

const NAMES = new WeakMap<object, ReadonlySet<string>>();
const DECLARING = new Set([
  "variable_declaration",
  "parameter",
  "procedure",
  "preproc_split_procedure",
  "field_declaration",
  "report_dataitem",
]);

/**
 * Every name the project declares as a variable, parameter, procedure, field or named return,
 * lowercased and unquoted, across all files. Memoised per context. A context without `files` (hand
 * built) answers with both clock names, so every site is refused: the safe direction.
 */
function declaredNames(ctx: SemanticContext): ReadonlySet<string> {
  const hit = NAMES.get(ctx);
  if (hit !== undefined) return hit;
  const names = new Set<string>();
  if (ctx.files === undefined) {
    names.add("workdate");
    names.add("today");
  } else {
    const visit = (n: ALSyntaxNode): void => {
      if (DECLARING.has(n.rawKind)) {
        for (const c of n.namedChildren) {
          if (c.rawKind === "identifier" || c.rawKind === "quoted_identifier") {
            names.add(c.text.replace(/^"(.*)"$/, "$1").toLowerCase());
          }
        }
      }
      for (const c of n.namedChildren) visit(c);
    };
    for (const f of ctx.files) visit(f.root);
  }
  NAMES.set(ctx, names);
  return names;
}
