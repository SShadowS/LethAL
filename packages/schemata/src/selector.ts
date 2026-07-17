export interface SelectorConfig {
  readonly selectorId: number;
  readonly controlId: number;
  readonly tableId: number;
}

export function emitMutationActiveTable(cfg: SelectorConfig): string {
  return `table ${cfg.tableId} "Mutation Active"
{
    DataPerCompany = false;

    fields
    {
        field(1; PrimaryKey; Code[10]) { }
        field(2; ActiveId; Text[64]) { }
    }

    keys
    {
        key(PK; PrimaryKey) { Clustered = true; }
    }
}
`;
}

export function emitMutationSelector(cfg: SelectorConfig): string {
  return `codeunit ${cfg.selectorId} "Mutation Selector"
{
    SingleInstance = true;

    var
        CachedId: Text;
        Loaded: Boolean;

    procedure Active(MutantId: Text): Boolean
    var
        MutationActive: Record "Mutation Active";
    begin
        if not Loaded then begin
            if MutationActive.Get('') then
                CachedId := MutationActive.ActiveId;
            Loaded := true;
        end;
        if CachedId = '' then
            exit(false);
        exit(CachedId = MutantId);
    end;
}
`;
}

export function emitMutationControl(cfg: SelectorConfig): string {
  return `codeunit ${cfg.controlId} "Mutation Control"
{
    procedure SetActive(MutantId: Text): Text
    var
        MutationActive: Record "Mutation Active";
    begin
        if not MutationActive.Get('') then begin
            MutationActive.Init();
            MutationActive.PrimaryKey := '';
            MutationActive.Insert();
        end;
        MutationActive.ActiveId := CopyStr(MutantId, 1, MaxStrLen(MutationActive.ActiveId));
        MutationActive.Modify();
        Commit();
        exit(MutantId);
    end;

    procedure ClearActive()
    var
        MutationActive: Record "Mutation Active";
    begin
        if MutationActive.Get('') then begin
            MutationActive.ActiveId := '';
            MutationActive.Modify();
            Commit();
        end;
    end;
}
`;
}

export function emitStaticSelector(cfg: { objectId: number; activeId: string }): string {
  const body =
    cfg.activeId === ""
      ? "        exit(false);"
      : `        exit(MutantId = '${cfg.activeId}');`;
  return `codeunit ${cfg.objectId} "Mutation Selector"
{
    procedure Active(MutantId: Text): Boolean
    begin
${body}
    end;
}
`;
}

export function emitWebServicesXml(cfg: SelectorConfig): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<ExportedData>
  <TenantWebServiceCollection>
    <TenantWebService>
      <ObjectType>Codeunit</ObjectType>
      <ObjectID>${cfg.controlId}</ObjectID>
      <ServiceName>MutationControl</ServiceName>
      <Published>true</Published>
    </TenantWebService>
  </TenantWebServiceCollection>
</ExportedData>
`;
}
