export interface SelectorConfig {
  readonly objectId: number;
}

export function emitMutationSelector(cfg: SelectorConfig): string {
  return `codeunit ${cfg.objectId} "Mutation Selector"
{
    SingleInstance = true;

    var
        ActiveId: Text;

    procedure Active(MutantId: Text): Boolean
    begin
        if ActiveId = '' then
            exit(false);
        exit(ActiveId = MutantId);
    end;

    procedure SetActive(MutantId: Text)
    begin
        ActiveId := MutantId;
    end;

    procedure ClearActive()
    begin
        ActiveId := '';
    end;
}
`;
}
