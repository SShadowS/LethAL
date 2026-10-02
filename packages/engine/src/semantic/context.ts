/**
 * SemanticContext — composition root for Layer 1 semantic services.
 *
 * Ties together the symbol table, type table, and caller index produced by the
 * previous tasks, and exposes a memoized `cfgFor(procedure)` that builds a CFG
 * on first access and caches it keyed on the procedure symbol identity.
 *
 * Callers (analyses, operators) receive a single `SemanticContext` and ask it
 * the four canonical questions:
 *   - "What symbol is this?"            via `symbols`
 *   - "What type does this node have?"  via `types`
 *   - "Who calls this procedure?"       via `callers`
 *   - "What is the control flow here?"  via `cfgFor(procedure)`
 *
 * The CFG cache is a WeakMap so CFGs are released when their procedure symbol
 * becomes unreachable (e.g. on re-parse).
 */
import { type ArmEvaluation, startsInInactiveArm } from "../ast/preproc-arms";
import type { ALSyntaxNode } from "../ast/syntax-node";
import type { CallerIndex } from "./callers";
import { buildCallerIndex } from "./callers";
import type { CFG } from "./cfg";
import { buildCFG } from "./cfg";
import type { ProcedureSymbol, SourceFile, SymbolTable } from "./symbol-table";
import { buildSymbolTable } from "./symbol-table";
import type { TypeTable } from "./types";
import { buildTypeTable } from "./types";

export interface SemanticContext {
  readonly symbols: SymbolTable;
  readonly types: TypeTable;
  readonly callers: CallerIndex;
  cfgFor(procedure: ProcedureSymbol): CFG;
  /**
   * R378: whether the build compiles `node`, from its file's `evaluateArms` result: "inactive" when
   * it starts in an arm the build compiles out, "undecided" when its file's directives could not be
   * evaluated. Present only on a context built with an arm map (`generateMutationSet`'s); a
   * context built without one (hand-built in tests) has no arms, and callers read absent as
   * "active". Throws when the map has no entry for the node's tree: a caller-contract violation.
   */
  armOf?(node: ALSyntaxNode): NodeArm;
}

/** R378: see `SemanticContext.armOf`. */
export type NodeArm = "active" | "inactive" | "undecided";

/** R378: `ctx.armOf(node)`, or "active" on a context built without an arm map. */
export function armOfNode(ctx: SemanticContext | undefined, node: ALSyntaxNode): NodeArm {
  return ctx?.armOf?.(node) ?? "active";
}

export function buildSemanticContext(
  files: readonly SourceFile[],
  arms?: ReadonlyMap<ALSyntaxNode, ArmEvaluation>,
): SemanticContext {
  const symbols = buildSymbolTable(files);
  const types = buildTypeTable(files, symbols);
  const callers = buildCallerIndex(files, symbols);
  const cfgCache = new WeakMap<object, CFG>();
  return {
    symbols,
    types,
    callers,
    ...(arms !== undefined
      ? {
          armOf(node: ALSyntaxNode): NodeArm {
            let root = node;
            while (root.parent !== null) root = root.parent;
            const arm = arms.get(root);
            if (arm === undefined) {
              throw new Error(
                `R378: the arm map has no entry for the tree holding the node at line ${node.startPosition.row + 1}; every file the context indexes must be evaluated`,
              );
            }
            if (arm.kind === "undecided") return "undecided";
            return startsInInactiveArm(arm.inactive, node.startIndex) ? "inactive" : "active";
          },
        }
      : {}),
    cfgFor(procedure) {
      const cached = cfgCache.get(procedure);
      if (cached !== undefined) return cached;
      const cfg = buildCFG(procedure.node);
      cfgCache.set(procedure, cfg);
      return cfg;
    },
  };
}
