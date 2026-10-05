// AST
export { initParser, parseAL } from "./ast/parser";
export {
  NativeParserMissingError,
  initNativeParser,
  liveParseResults,
  nativeInfo,
  parseALNative,
  parsesSinceStart,
} from "./ast/native-parser";
export { ALNodeKind, isALNodeKind } from "./ast/node-kinds";
export { BINARY_EXPRESSION_KINDS, isBinaryExpressionKind } from "./ast/node-kinds";
export type { ALSyntaxNode } from "./ast/syntax-node";
export { wrapRoot, findFirst, findAll, visit, withText } from "./ast/syntax-node";
export { maskAlNonCode } from "./ast/mask";
export type { AlMaskOptions } from "./ast/mask";
export { print, printWithRewrites } from "./ast/printer";
export { planEdits } from "./ast/rewrite-plan";
export type { SpanEdit } from "./ast/rewrite-plan";
export { joinEdits } from "./ast/join-edits";
export { FILE_REFUSAL_SITES, FileRefusedError, formatRefusal } from "./file-refused";
export type {
  FileRefusalFields,
  FileRefusalShape,
  FileRefusalSite,
  RefusedObject,
} from "./file-refused";
export { astSubtreeHash } from "./ast/hash";
export { canonicalize } from "./ast/canonicalization";
export type { CanonicalForm } from "./ast/canonicalization";
export {
  findEnclosingStatement,
  findEnclosingProcedure,
  findEnclosingCodeBlock,
  isStatementPosition,
  isStatementSlot,
  gapBlockOf,
  isProcedureLike,
  inMemberBody,
  memberArms,
  swallowedSplitMembers,
  allProcedureLikes,
  procedureLikeReturnType,
  procedureLikeArmNames,
  procedureLikeNameNode,
  renamedMemberCoverageNames,
  declarationMembers,
  liveMembers,
  isObjectContainer,
  objectDeclarationsOf,
} from "./ast/tree-walks";
export type { MemberPlace, PlacedMember } from "./ast/tree-walks";
export { evaluateArms, hasDirectiveLine, startsInInactiveArm } from "./ast/preproc-arms";
export { countArguments, exactArguments, soleArgument } from "./ast/arguments";
export type { ArmEvaluation } from "./ast/preproc-arms";

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
export type { RunTriggerMethod } from "./semantic/receiver";
export {
  RUN_TRIGGER_METHODS,
  claimedRunTriggerMethod,
  claimedRunTriggerSkip,
  claimsRecordMethod,
  claimsSystemCall,
  calleeNameNode,
  receiverUnresolved,
  resolveReceiverTable,
  recordScopesAt,
  bareReceiverText,
} from "./semantic/receiver";
export type { RecordScope } from "./semantic/receiver";
export type { CallerIndex, CallSite } from "./semantic/callers";
export { buildCallerIndex } from "./semantic/callers";
export type { NodeArm, SemanticContext } from "./semantic/context";
export { armOfNode, buildSemanticContext, rawArmOf } from "./semantic/context";
export { normalizeAlName, resolveVarRef } from "./semantic/resolve-var-ref";
export type { HarmlessTriggerKind, RunTriggerKind } from "./semantic/trigger-skip";
export {
  deleteSkipCanRaise,
  findTableTrigger,
  forceCanRaise,
  isHarmlessTriggerCall,
  modifySkipCanRaise,
  skipCanRaise,
} from "./semantic/trigger-skip";
export {
  insertSkipCanRaise,
  onInsertAssignsPrimaryKey,
  onInsertTrigger,
  primaryKeyFields,
} from "./semantic/insert-key-assignment";

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
  HangCapableReason,
} from "./operator/interface";
export { buildSpanIndex, validateSpec } from "./operator/spec-validation";
export type { ValidationResult } from "./operator/spec-validation";
export { createRegistry } from "./operator/registry";
export type { Registry } from "./operator/registry";
