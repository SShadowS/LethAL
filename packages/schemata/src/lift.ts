import type { ALSyntaxNode } from "@lethal/engine";

export interface LiftInput {
  readonly mutantId: string;
  readonly original: ALSyntaxNode;
  readonly replacementSource: string;
  readonly inferredType: string;
}

export interface LiftArtifacts {
  readonly varDeclaration: string;
  readonly conditionalAssign: string;
  readonly replacementReference: string;
}

export function liftExpression(input: LiftInput): LiftArtifacts {
  const local = `_m${input.mutantId.slice(1)}`;
  return {
    varDeclaration: `${local}: ${input.inferredType};`,
    conditionalAssign:
      `if MutationSelector.Active('${input.mutantId}') then\n` +
      `  ${local} := ${input.replacementSource}\n` +
      `else\n` +
      `  ${local} := ${input.original.text.trim()};`,
    replacementReference: local,
  };
}
