// Engine types + utilities re-exposed to operator authors.
// The SDK intentionally surfaces only the subset operators need; engine
// internals may evolve without breaking registered operators.
export type {
  ALSyntaxNode,
  ALNodeKind,
  MutationOperator,
  MutationSpec,
  ConformanceCase,
  ParentContextHint,
  EquivalenceHint,
  SemanticCapability,
  SemanticContext,
  AstNodeId,
} from "@lethal/engine";

export { astSubtreeHash, visit } from "@lethal/engine";

// SDK-owned surface
export { build } from "./build";
export type { BuiltExpression } from "./build";
export { runConformance } from "./conformance";
export type { ConformanceResult, ConformanceFailure } from "./conformance";
