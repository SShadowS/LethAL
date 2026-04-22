import type { ALSyntaxNode } from "@lethal/engine";

export interface WrapInput {
  readonly mutantId: string;
  readonly original: ALSyntaxNode;
  readonly replacement: string | null;
}

export function wrapStatement(input: WrapInput): string {
  const originalText = input.original.text;
  if (input.replacement === null) {
    return `if not MutationSelector.Active('${input.mutantId}') then\n  ${originalText}`;
  }
  return `if MutationSelector.Active('${input.mutantId}') then\n  ${input.replacement}\nelse\n  ${originalText}`;
}
