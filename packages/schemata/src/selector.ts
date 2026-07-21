export interface SelectorConfig {
  readonly selectorId: number;
  readonly controlId: number;
  readonly tableId: number;
}

// DEAD since Layer 5C-A Task 4: the active-mutant state moved out of the instrumented target
// into the `LethAL Control` extension (extensions/lethal-control/). `emitMutationActiveTable`,
// `emitMutationControl`, and `emitWebServicesXml` below are no longer written by
// `writeInstrumentedProject` — the control extension owns the table, the SetActive/ClearActive
// control surface, and the OData web-service registration. Kept exported (and unit-tested) only
// so the historical shape stays documented; do not re-wire them into emission.
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

/**
 * The instrumented target's `Mutation Selector` — since Layer 5C-A Task 4 a thin DELEGATE into
 * the `LethAL Control` extension. `Active(MutantId)` forwards the full identity tuple
 * `(targetAppId, artifactId, mutantId)` to `LC Control State.IsActive`, which owns the active
 * state (the target no longer holds a `Mutation Active` table or caches anything). The dispatch
 * seam is UNCHANGED — guards still emit `MutationSelector.Active('<id>')` and `compile.ts` still
 * injects `var MutationSelector: Codeunit "Mutation Selector";`; only what `Active` DOES changed.
 *
 * `LC Control State` resolves by unqualified name across the `LethAL Control` app dependency
 * (added to the target's `app.json` — see `project.ts` / orchestrator). No `using LethAL.Control;`
 * directive: the target declares no namespace, so a `using` would be ignored anyway (alc AL0789)
 * — verified live on Cronus281 that the bare reference resolves without it.
 *
 * al-runner never compiles this: `AlRunnerBackend.activate()` overwrites the whole selector file
 * with `emitStaticSelector` (self-contained, no control dependency) before its lazy `alc` run.
 * The procedure set here (`Active`, `ArtifactId`) MUST stay identical to `emitStaticSelector`'s.
 */
export function emitMutationSelector(
  cfg: SelectorConfig & { artifactId: string; targetAppId: string },
): string {
  return `codeunit ${cfg.selectorId} "Mutation Selector"
{
    procedure Active(MutantId: Text): Boolean
    var
        ControlState: Codeunit "LC Control State";
    begin
        exit(ControlState.IsActive('${cfg.targetAppId}', '${cfg.artifactId}', MutantId));
    end;

    procedure ArtifactId(): Text
    begin
        exit('${cfg.artifactId}');
    end;
}
`;
}

/**
 * The instrumented target's install codeunit — registers this target's
 * `(targetAppId -> artifactId)` into the `LethAL Control` extension on install, so `RunMutant`'s
 * artifact guard can read the deployed artifact id WITHOUT the control extension depending on the
 * target (the dependency runs target -> control only). Its object id is the freed `controlId`
 * (the in-target Mutation Control codeunit is gone). Belt-and-suspenders alongside the client's
 * post-publish OData `RegisterArtifact` call.
 */
export function emitRegisterInstall(cfg: {
  objectId: number;
  targetAppId: string;
  artifactId: string;
}): string {
  return `codeunit ${cfg.objectId} "Mutation Register"
{
    Subtype = Install;

    trigger OnInstallAppPerCompany()
    var
        ControlState: Codeunit "LC Control State";
    begin
        ControlState.RegisterArtifact('${cfg.targetAppId}', '${cfg.artifactId}');
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

    procedure Identity(): Text
    var
        MutationSelector: Codeunit "Mutation Selector";
    begin
        exit(MutationSelector.ArtifactId());
    end;
}
`;
}

export function emitStaticSelector(cfg: {
  objectId: number;
  activeId: string;
  artifactId: string;
}): string {
  const body =
    cfg.activeId === "" ? "        exit(false);" : `        exit(MutantId = '${cfg.activeId}');`;
  // ArtifactId must be present here too: AlRunnerBackend.activate() replaces the entire
  // generated selector with this output on every activation, so an emitter missing a procedure
  // MutationControl calls would break the NEXT compile.
  return `codeunit ${cfg.objectId} "Mutation Selector"
{
    procedure Active(MutantId: Text): Boolean
    begin
${body}
    end;

    procedure ArtifactId(): Text
    begin
        exit('${cfg.artifactId}');
    end;
}
`;
}

export function emitWebServicesXml(cfg: SelectorConfig): string {
  // ObjectType must be exactly "CodeUnit" (capital U) — verified against both the AL
  // compiler's embedded TenantWebServicesV1(Runtime6).xsd (Microsoft.Dynamics.Nav.CodeAnalysis.dll,
  // enum "Page"|"CodeUnit"|"Query") and the AL extension's own "twebservices" snippet
  // (snippets/xml.json). The lowercase "Codeunit" this used to emit doesn't validate, so alc
  // silently drops the file — it never appears in the compiled .app's package listing
  // (confirmed 2026-07-18: absent from a real compiled fixture .app; the "MutationControl"
  // service was never reachable at /ODataV4/ afterwards).
  return `<?xml version="1.0" encoding="utf-8"?>
<ExportedData>
  <TenantWebServiceCollection>
    <TenantWebService>
      <ObjectType>CodeUnit</ObjectType>
      <ObjectID>${cfg.controlId}</ObjectID>
      <ServiceName>MutationControl</ServiceName>
      <Published>true</Published>
    </TenantWebService>
  </TenantWebServiceCollection>
</ExportedData>
`;
}
