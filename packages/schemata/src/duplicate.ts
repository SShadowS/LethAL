import type { ALSyntaxNode } from "@lethal/engine";

export interface DuplicateInput {
  readonly mutantId: string;
  readonly enclosingStatement: ALSyntaxNode;
  readonly mutatedStatement: string;
}

export function duplicateEnclosing(input: DuplicateInput): string {
  return (
    `if MutationSelector.Active('${input.mutantId}') then begin\n` +
    `  ${input.mutatedStatement}\n` +
    `end else begin\n` +
    `  ${input.enclosingStatement.text}\n` +
    `end;`
  );
}
