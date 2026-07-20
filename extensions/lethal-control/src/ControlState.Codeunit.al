namespace LethAL.Control;

/// <summary>
/// Authoritative active-mutant state + target-artifact registry access, SingleInstance so the
/// guard's repeated Active() checks within one run don't re-hit the DB. Owns the reads/writes of
/// its two tables.
///
/// InherentPermissions: the OData runner session runs under the CALLING USER, which does not hold
/// this extension's permission set (proven by the 5C-A live spike: a guard read failed with "the
/// current permissions prevented the action"). Declaring the permissions inherently lets this
/// codeunit access its own tables regardless of the caller's assigned permission sets.
/// </summary>
codeunit 71002 "LC Control State"
{
    SingleInstance = true;

    var
        CachedTargetAppId: Text;
        CachedArtifactId: Text;
        CachedMutantId: Text;
        Loaded: Boolean;
        SuiteCounter: Integer;

    /// <summary>Control-owned monotonic suite name within Code[10] (spec §5.4). SingleInstance, so
    /// consecutive runs never collide on one shared suite name. Wraps to stay in 10 chars.</summary>
    procedure NextSuiteName(): Code[10]
    begin
        SuiteCounter += 1;
        if SuiteCounter > 999999 then
            SuiteCounter := 1;
        exit(CopyStr('LC' + Format(SuiteCounter), 1, 10));
    end;

    local procedure EnsureLoaded()
    var
        Active: Record "LC Mutation Active";
    begin
        if Loaded then
            exit;
        if Active.Get('') then begin
            CachedTargetAppId := Active."Target App Id";
            CachedArtifactId := Active."Artifact Id";
            CachedMutantId := Active."Mutant Id";
        end;
        Loaded := true;
    end;

    procedure SetActive(TargetAppId: Text; ArtifactId: Text; MutantId: Text)
    var
        Active: Record "LC Mutation Active";
    begin
        if not Active.Get('') then begin
            Active.Init();
            Active."Primary Key" := '';
            Active.Insert();
        end;
        Active."Target App Id" := CopyStr(TargetAppId, 1, MaxStrLen(Active."Target App Id"));
        Active."Artifact Id" := CopyStr(ArtifactId, 1, MaxStrLen(Active."Artifact Id"));
        Active."Mutant Id" := CopyStr(MutantId, 1, MaxStrLen(Active."Mutant Id"));
        Active.Modify();
        Commit();
        CachedTargetAppId := TargetAppId;
        CachedArtifactId := ArtifactId;
        CachedMutantId := MutantId;
        Loaded := true;
    end;

    procedure ClearActive()
    var
        Active: Record "LC Mutation Active";
    begin
        if Active.Get('') then begin
            Active."Target App Id" := '';
            Active."Artifact Id" := '';
            Active."Mutant Id" := '';
            Active.Modify();
            Commit();
        end;
        CachedTargetAppId := '';
        CachedArtifactId := '';
        CachedMutantId := '';
        Loaded := true;
    end;

    /// <summary>The guard predicate the instrumented target calls. True only when the active tuple
    /// matches AND the deployed artifact is the one active (so a guard on a replaced artifact never
    /// activates).</summary>
    procedure IsActive(TargetAppId: Text; ArtifactId: Text; MutantId: Text): Boolean
    begin
        EnsureLoaded();
        if CachedMutantId = '' then
            exit(false);
        exit((CachedTargetAppId = TargetAppId) and (CachedArtifactId = ArtifactId) and (CachedMutantId = MutantId));
    end;

    procedure RegisterArtifact(TargetAppId: Text; ArtifactId: Text)
    var
        Registry: Record "LC Target Artifact Registry";
        RegKey: Text[40];
    begin
        RegKey := CopyStr(TargetAppId, 1, MaxStrLen(Registry."Target App Id"));
        if not Registry.Get(RegKey) then begin
            Registry.Init();
            Registry."Target App Id" := RegKey;
            Registry."Artifact Id" := CopyStr(ArtifactId, 1, MaxStrLen(Registry."Artifact Id"));
            Registry.Insert();
        end else begin
            Registry."Artifact Id" := CopyStr(ArtifactId, 1, MaxStrLen(Registry."Artifact Id"));
            Registry.Modify();
        end;
        Commit();
    end;

    procedure RegisteredArtifact(TargetAppId: Text): Text
    var
        Registry: Record "LC Target Artifact Registry";
    begin
        if Registry.Get(CopyStr(TargetAppId, 1, MaxStrLen(Registry."Target App Id"))) then
            exit(Registry."Artifact Id");
        exit('');
    end;
}
