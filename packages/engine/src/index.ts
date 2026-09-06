// AST
export { initParser, parseAL } from "./ast/parser";
export { ALNodeKind, isALNodeKind } from "./ast/node-kinds";
export { BINARY_EXPRESSION_KINDS, isBinaryExpressionKind } from "./ast/node-kinds";
export type { ALSyntaxNode } from "./ast/syntax-node";
export { wrapRoot, findFirst, findAll, visit } from "./ast/syntax-node";
export { maskAlNonCode } from "./ast/mask";
export type { AlMaskOptions } from "./ast/mask";
export { print, printWithRewrites } from "./ast/printer";
export { astSubtreeHash } from "./ast/hash";
export { canonicalize } from "./ast/canonicalization";
export type { CanonicalForm } from "./ast/canonicalization";
export {
  findEnclosingStatement,
  findEnclosingProcedure,
  findEnclosingCodeBlock,
  isStatementPosition,
  isStatementSlot,
  declarationMembers,
} from "./ast/tree-walks";

// Semantic
export type {
  SourceFile,
  SymbolTable,
  ObjectSymbol,
  ExtensionSymbol,
  ProcedureSymbol,
  VarSymbol,
} from "./semantic/symbol-table";
export {
  buildSymbolTable,
  collectVarDeclarations,
  extensionScopeKey,
  objectScopeKey,
  objectScopeKeyOfNode,
} from "./semantic/symbol-table";
export type { CFG, BasicBlock } from "./semantic/cfg";
export { buildCFG } from "./semantic/cfg";
export type { TypeTable } from "./semantic/types";
export { buildTypeTable } from "./semantic/types";
export {
  claimsRecordMethod,
  claimsSystemCall,
  calleeNameNode,
  resolveReceiverTable,
} from "./semantic/receiver";
export type { CallerIndex, CallSite } from "./semantic/callers";
export { buildCallerIndex } from "./semantic/callers";
export type { SemanticContext } from "./semantic/context";
export { buildSemanticContext } from "./semantic/context";
export type { VarScope } from "./semantic/resolve-var-ref";
export { enclosingScope, normalizeAlName, resolveVarRef } from "./semantic/resolve-var-ref";

// Operator contract
export type {
  MutationOperator,
  MutationSpec,
  ConformanceCase,
  ParentContextHint,
  EquivalenceHint,
  EquivalenceRisk,
  PlatformKillMechanism,
  SemanticCapability,
  AstNodeId,
} from "./operator/interface";
export { buildSpanIndex, validateSpec } from "./operator/spec-validation";
export type { ValidationResult } from "./operator/spec-validation";
export { createRegistry } from "./operator/registry";
export type { Registry } from "./operator/registry";
