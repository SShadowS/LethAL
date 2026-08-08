import {
  ALNodeKind,
  type ALSyntaxNode,
  type PlatformKillMechanism,
  isStatementPosition,
  visit,
} from "@lethal/operator-sdk";

/** The AL system call whose refusal this recognises. Case-insensitive, as all AL identifiers are. */
const RUN_RECEIVER = "Codeunit";
const RUN_MEMBER = "Run";

/** The tag this module produces. Named once so the operator and its tests cannot drift apart. */
export const WRITE_TXN_CODEUNIT_RUN: PlatformKillMechanism = "write-txn-codeunit-run";

function equalsIgnoreCase(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Narrowest `procedure` or `trigger_declaration` ancestor, or `null` outside both. */
function enclosingBody(node: ALSyntaxNode): ALSyntaxNode | null {
  let current: ALSyntaxNode | null = node.parent;
  while (current !== null) {
    if (current.kind === ALNodeKind.procedure || current.kind === ALNodeKind.trigger) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

/**
 * Is `node` a `Codeunit.Run(...)` call whose RETURN VALUE is consumed?
 *
 * Consumed means "not in statement position": `Ran := Codeunit.Run(X)`, `if not Codeunit.Run(X)
 * then ...`, `exit(Codeunit.Run(X))`. The bare statement `Codeunit.Run(X);` is not, and it is
 * measured NOT to abort. Arity is deliberately not checked — AL's `Codeunit.Run` takes one or two
 * arguments and both forms return the same Boolean.
 */
function isConsumedCodeunitRun(node: ALSyntaxNode): boolean {
  if (node.kind !== ALNodeKind.procedure_call) return false;
  if (isStatementPosition(node)) return false;
  const callee = node.childForFieldName("function");
  if (callee === null) return false;
  if (callee.kind !== ALNodeKind.field_access) return false;
  const object = callee.childForFieldName("object");
  const member = callee.childForFieldName("member");
  if (object === null || member === null) return false;
  return equalsIgnoreCase(object.text, RUN_RECEIVER) && equalsIgnoreCase(member.text, RUN_MEMBER);
}

/**
 * Does deleting the `Commit()` at `commitNode` expose the write-transaction refusal R72 measured?
 *
 * The rule is one syntactic question: does a `Codeunit.Run` whose return value is CONSUMED appear
 * later in the same procedure or trigger body? Measured 2026-08-08 on Cronus281
 * (`scripts/r72-probe/`, and `docs/measurements/README.md` §R72) — with a write transaction open,
 * the consumed form aborts the whole transaction in both call frames, with and without a prior
 * `Commit()`, while the bare statement form survives in every cell. The abort is raised at the call
 * itself and the caller never regains control, so the adversarial re-wrap
 * `if not Codeunit.Run(X) then Error(Err, GetLastErrorText())` cannot hide it: that shape was
 * measured too (probe arms B1/B2) and it aborts identically.
 *
 * TWO APPROXIMATIONS, both in the over-flagging direction, both deliberate:
 *
 *   1. **Later in the body, not later on the executed path.** A `Codeunit.Run` inside a branch the
 *      covering test never takes still counts here. Deciding otherwise needs a control-flow
 *      analysis the engine does not have (`SemanticCapability` "cfg" is unimplemented), and the
 *      cost of the two errors is not symmetric: a missed warning silently credits a platform
 *      refusal to the suite, which is the direction R86 measured as the flattering one.
 *   2. **The write is not required to be visible here.** `Commit()` only matters when a write is
 *      open, but the write may have been opened by a CALLER — the probe measured the frame to be
 *      irrelevant — so demanding a syntactically visible write in the same procedure would produce
 *      false negatives on exactly the cross-frame shape that motivated this.
 *
 * Both are why the report words this as best-effort and never as a classification, and why the
 * verdict does not move.
 */
export function detectWriteTxnCodeunitRun(commitNode: ALSyntaxNode): PlatformKillMechanism | null {
  const body = enclosingBody(commitNode);
  if (body === null) return null;
  let found = false;
  visit(body, (n) => {
    if (found) return;
    // Strictly AFTER the deleted statement. A consumed `Codeunit.Run` BEFORE the `Commit()` is
    // unaffected by deleting it — the write it would have seen is the same either way.
    if (n.startIndex < commitNode.endIndex) return;
    if (isConsumedCodeunitRun(n)) found = true;
  });
  return found ? WRITE_TXN_CODEUNIT_RUN : null;
}
