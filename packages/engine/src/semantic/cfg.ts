/**
 * Control-flow graph (CFG) builder — per-procedure.
 *
 * A CFG node is a basic block (linear statement sequence); edges are control
 * transitions (branch, fall-through, exit). Used later by dataflow advisories
 * (design §7) and unreachable-mutation-site detection (§3.3).
 *
 * Grammar-field adjustments (SShadowS/tree-sitter-al v3.0.1):
 *   - `if_statement` field names are `then_branch` and `else_branch`
 *     (NOT `consequence` / `alternative` as the design plan suggested).
 *     `childForFieldName("then_branch")` returns the then-branch statement
 *     (it may also match a trailing `;` in raw children, but field lookup
 *     surfaces the first match which is the statement itself).
 *   - `code_block` (AL `begin...end`) lists `begin_keyword` and `end_keyword`
 *     as named children alongside its `statement_block`. The CFG builder
 *     filters the keyword tokens out so they don't appear as "statements" in
 *     basic blocks, and walks through `statement_block` via `blockStatements`
 *     (see `ast/tree-walks.ts`) to reach the actual statement nodes.
 *   - `procedure` names the body as `code_block` (ALNodeKind.block).
 */
import { ALNodeKind } from "../ast/node-kinds";
import type { ALSyntaxNode } from "../ast/syntax-node";
import { blockStatements } from "../ast/tree-walks";

export interface CFG {
  readonly entry: BasicBlock;
  readonly exit: BasicBlock;
  readonly blocks: readonly BasicBlock[];
}

export interface BasicBlock {
  readonly id: number;
  readonly statements: readonly ALSyntaxNode[];
  readonly successors: BasicBlock[];
  readonly reachable: boolean;
}

/**
 * Raw-kind tokens the grammar emits as named children of `code_block` /
 * `if_statement` that should not be treated as statements by the CFG.
 */
const NON_STATEMENT_KINDS: ReadonlySet<string> = new Set([
  "begin_keyword",
  "end_keyword",
  "if_keyword",
  "then_keyword",
  "else_keyword",
  ";",
]);

function isStatementNode(n: ALSyntaxNode): boolean {
  return !NON_STATEMENT_KINDS.has(n.rawKind);
}

export function buildCFG(procedure: ALSyntaxNode): CFG {
  const body = procedure.namedChildren.find((c) => c.kind === ALNodeKind.block);
  const builder = new Builder();
  const entry = builder.newBlock();
  const exit = builder.newBlock();
  if (body === undefined) {
    entry.successors.push(exit);
    builder.markReachable(entry);
    return builder.finalize(entry, exit);
  }
  const tails = builder.emitBlock(body, entry, exit);
  for (const tail of tails) {
    if (!tail.successors.includes(exit)) tail.successors.push(exit);
  }
  builder.markReachable(entry);
  return builder.finalize(entry, exit);
}

class Builder {
  private readonly allBlocks: MutableBlock[] = [];

  newBlock(): MutableBlock {
    const block: MutableBlock = {
      id: this.allBlocks.length,
      statements: [],
      successors: [],
      reachable: false,
    };
    this.allBlocks.push(block);
    return block;
  }

  emitBlock(block: ALSyntaxNode, current: MutableBlock, exitBlock: MutableBlock): MutableBlock[] {
    let tails: MutableBlock[] = [current];
    for (const stmt of blockStatements(block)) {
      if (!isStatementNode(stmt)) continue;
      if (tails.length === 0) {
        // Previous statement terminated control flow (e.g. exit). Subsequent
        // statements are dead code — collect them into a fresh block that
        // stays unreachable.
        tails = [this.newBlock()];
      }
      tails = this.emitStatement(stmt, tails, exitBlock);
    }
    return tails;
  }

  emitStatement(
    stmt: ALSyntaxNode,
    tails: MutableBlock[],
    exitBlock: MutableBlock,
  ): MutableBlock[] {
    if (stmt.kind === ALNodeKind.if_statement) {
      const thenBranch = stmt.childForFieldName("then_branch");
      const elseBranch = stmt.childForFieldName("else_branch");
      const merged = this.newBlock();
      for (const tail of tails) {
        tail.statements.push(stmt);
        const thenStart = this.newBlock();
        tail.successors.push(thenStart);
        const thenTails =
          thenBranch === null
            ? [thenStart]
            : this.emitStatement(thenBranch, [thenStart], exitBlock);
        for (const t of thenTails) t.successors.push(merged);

        if (elseBranch !== null) {
          const elseStart = this.newBlock();
          tail.successors.push(elseStart);
          const elseTails = this.emitStatement(elseBranch, [elseStart], exitBlock);
          for (const t of elseTails) t.successors.push(merged);
        } else {
          tail.successors.push(merged);
        }
      }
      return [merged];
    }

    if (stmt.kind === ALNodeKind.exit_statement) {
      for (const tail of tails) {
        tail.statements.push(stmt);
        tail.successors.push(exitBlock);
      }
      return [];
    }

    if (stmt.kind === ALNodeKind.block) {
      let current = tails;
      for (const inner of blockStatements(stmt)) {
        if (!isStatementNode(inner)) continue;
        if (current.length === 0) {
          // Dead code following a terminating statement inside this block.
          current = [this.newBlock()];
        }
        current = this.emitStatement(inner, current, exitBlock);
      }
      return current;
    }

    for (const tail of tails) tail.statements.push(stmt);
    return tails;
  }

  markReachable(from: MutableBlock): void {
    const visited = new Set<number>();
    const queue: MutableBlock[] = [from];
    while (queue.length > 0) {
      const block = queue.shift() as MutableBlock;
      if (visited.has(block.id)) continue;
      visited.add(block.id);
      block.reachable = true;
      for (const succ of block.successors) {
        queue.push(succ as MutableBlock);
      }
    }
  }

  finalize(entry: MutableBlock, exit: MutableBlock): CFG {
    return {
      entry,
      exit,
      blocks: this.allBlocks.slice(),
    };
  }
}

interface MutableBlock {
  id: number;
  statements: ALSyntaxNode[];
  successors: MutableBlock[];
  reachable: boolean;
}
