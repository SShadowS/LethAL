// AST
export { initParser, parseAL } from "./ast/parser";
export { ALNodeKind, isALNodeKind } from "./ast/node-kinds";
export { BINARY_EXPRESSION_KINDS, isBinaryExpressionKind } from "./ast/node-kinds";
export type { ALSyntaxNode } from "./ast/syntax-node";
export { wrapRoot, findFirst, findAll, visit } from "./ast/syntax-node";
export { print, printWithRewrites } from "./ast/printer";
export { astSubtreeHash } from "./ast/hash";
export { canonicalize } from "./ast/canonicalization";
export type { CanonicalForm } from "./ast/canonicalization";
export {
  findEnclosingStatement,
  findEnclosingProcedure,
  findEnclosingCodeBlock,
} from "./ast/tree-walks";

// Semantic
export type {
  SourceFile,
  SymbolTable,
  ObjectSymbol,
  ProcedureSymbol,
  VarSymbol,
} from "./semantic/symbol-table";
export { buildSymbolTable } from "./semantic/symbol-table";
export type { CFG, BasicBlock } from "./semantic/cfg";
export { buildCFG } from "./semantic/cfg";
export type { TypeTable } from "./semantic/types";
export { buildTypeTable } from "./semantic/types";
export type { CallerIndex, CallSite } from "./semantic/callers";
export { buildCallerIndex } from "./semantic/callers";
export type { SemanticContext } from "./semantic/context";
export { buildSemanticContext } from "./semantic/context";

// Operator contract
export type {
  MutationOperator,
  MutationSpec,
  ConformanceCase,
  ParentContextHint,
  EquivalenceHint,
  SemanticCapability,
  AstNodeId,
} from "./operator/interface";
export { validateSpec } from "./operator/spec-validation";
export type { ValidationResult } from "./operator/spec-validation";
export { createRegistry } from "./operator/registry";
export type { Registry } from "./operator/registry";
