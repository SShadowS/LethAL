import { claimsSystemCall } from "@lethal/engine";
import {
  ALNodeKind,
  type ALSyntaxNode,
  type MutationOperator,
  type MutationSpec,
  type SemanticContext,
  isStatementSlot,
} from "@lethal/operator-sdk";
import { countArguments, synthesizeAfter } from "./mutate-helpers";
import { detectWriteTxnCodeunitRun } from "./write-txn-codeunit-run";

const CALL_NAME = "Commit";

/**
 * `RemoveCommit` — delete `Commit()`.
 *
 * Spec: docs/superpowers/specs/2026-07-25-tier2-mutation-operators-design.md §5.
 *
 * **Fully scored, NOT `likely-equivalent`**, and the spec argues that explicitly: `WriteA;
 * Commit(); Error(...)` rolls `WriteA` back once the `Commit` is gone, which is genuinely
 * observable, and a real transaction-boundary test gap hidden in an excluded bucket is exactly the
 * gap worth reporting.
 *
 * Three guards:
 *
 *   1. `isStatementSlot` — deletion needs a statement SLOT (R161), as for every deletion operator.
 *   2. `claimsSystemCall` — receiverless, and neither the enclosing object nor a `tableextension`
 *      of the enclosing table declares a procedure of that name. A project may legally declare its
 *      own `Commit`, and the fixture does (`Data Shadow`): claiming that call would mislabel the
 *      mutation AND, under §3.2 dedup precedence, delete the correct Tier-1 mutant at the site.
 *   3. `countArguments === 0` — the AL system `Commit` takes none, so any argument means this is
 *      something else. Cheap, and it keeps the operator from riding on guard 2 alone.
 *
 * Documented limits:
 *   - The parenthesis-less form `Commit;` parses as `call_statement`, never as a
 *     `procedure_call`, so it is silently not claimed. Same grammar gap Tier-1
 *     `void-method-call` has; see `claimsRecordMethod`'s doc comment.
 *   - **`Commit()` is permitted and DOES execute inside LethAL's fenced test run** — measured
 *     2026-07-31 on Cronus281 (`fixtures/sandbox-probes/src/Tier2Phase2Probe.Codeunit.al`,
 *     `commit-executed=Yes`), which is the precondition for this operator having any signal at all.
 *     A first version of that probe wrapped the call in a `[TryFunction]` and BC refused the
 *     WRAPPER ("Call to the function 'COMMIT' is not allowed inside the call to 'RunTests' when it
 *     is used as a TryFunction") — the probe measuring itself, R26's mistake, corrected.
 *   - **NOT measured: whether a committed write survives a later uncaught error under the test
 *     runner's isolation** — which is the actual kill mechanism. Until it is, a survivor here is
 *     weak evidence about the suite, and no gate has ever KILLED a `remove-commit` mutant.
 *   - BC's "cannot run codeunit in a write transaction" (spec §5) — an error-kill that says nothing
 *     about assertion quality — IS now distinguished, as of R72's close. `generate` tags a site
 *     whose deleted `Commit()` is followed by a `Codeunit.Run` that consumes its return value with
 *     `platformKillMechanism: "write-txn-codeunit-run"`, and the report screens killed mutants
 *     carrying it. The tag is syntactic, never a message match: BC's own text is generic and
 *     localises (R66). The verdict does NOT move — see `PlatformKillMechanism`.
 */
export const removeCommit: MutationOperator = {
  name: "lethal.remove-commit",
  version: "1.1.0",
  tier: 2,
  targetNodeKinds: [ALNodeKind.procedure_call],
  producesNodeKinds: [ALNodeKind.procedure_call],
  requiresSemantic: ["symbol-table"],

  targets(node: ALSyntaxNode, ctx: SemanticContext): boolean {
    if (node.kind !== ALNodeKind.procedure_call) return false;
    if (!isStatementSlot(node)) return false;
    if (!claimsSystemCall(node, ctx, CALL_NAME)) return false;
    return countArguments(node) === 0;
  },

  generate(node: ALSyntaxNode, _ctx: SemanticContext): readonly MutationSpec[] {
    // R72: a SITE property, decided here because this is the only place that still has the AST.
    // It says which of the operator's two kill mechanisms this site can produce, and it never
    // touches the verdict — see `PlatformKillMechanism`.
    const platformKillMechanism = detectWriteTxnCodeunitRun(node);
    return [
      {
        operatorName: "lethal.remove-commit",
        operatorVersion: "1.1.0",
        astNodeId: `${node.startIndex}-${node.endIndex}`,
        before: node,
        after: synthesizeAfter(node, ""),
        parentContext: "statement-position",
        ...(platformKillMechanism !== null ? { platformKillMechanism } : {}),
      },
    ];
  },

  conformanceTests: [
    {
      name: "deletes a bare Commit() in a codeunit that does not declare one",
      sourceAL: `codeunit 50120 "C" { procedure P() begin Commit(); end; }`,
      expectedSpecs: [
        { parentContext: "statement-position", beforeText: "Commit()", afterText: "" },
      ],
    },
    {
      name: "refuses a Commit() in a codeunit that declares its own",
      sourceAL: `codeunit 50121 "C" { procedure P() begin Commit(); end; procedure Commit() begin end; }`,
      expectedSpecs: [],
    },
  ],
};
