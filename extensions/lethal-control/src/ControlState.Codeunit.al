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
        ExpectedTargetAppId: Text;
        ExpectedArtifactId: Text;
        ObservedAny: Boolean;
        ObservedIdentityMismatch: Boolean;

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
        ExpectedTargetAppId := TargetAppId;
        ExpectedArtifactId := ArtifactId;
        ObservedAny := false;
        ObservedIdentityMismatch := false;
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
        ObservedAny := false;
        ObservedIdentityMismatch := false;
        ExpectedTargetAppId := '';
        ExpectedArtifactId := '';
    end;

    /// <summary>The guard predicate the instrumented target calls. True only when the active tuple
    /// matches AND the deployed artifact is the one active (so a guard on a replaced artifact never
    /// activates).</summary>
    procedure IsActive(TargetAppId: Text; ArtifactId: Text; MutantId: Text): Boolean
    begin
        ObservedAny := true;
        if (TargetAppId <> ExpectedTargetAppId) or (ArtifactId <> ExpectedArtifactId) then
            ObservedIdentityMismatch := true;
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

    procedure AttestationObservedAny(): Boolean
    begin
        exit(ObservedAny);
    end;

    procedure AttestationMismatch(): Boolean
    begin
        exit(ObservedIdentityMismatch);
    end;

    /// <summary>Seeds the single "LC Lease" row on first install/upgrade with a fresh Server
    /// Generation. Never resets an existing row — a restarted service instance re-running install
    /// or upgrade must not clobber an in-progress lease (recovery from a stale generation is a
    /// later task's job).</summary>
    procedure EnsureLeaseSeeded()
    var
        Lease: Record "LC Lease";
    begin
        if Lease.Get('') then
            exit;
        Lease.Init();
        Lease."Primary Key" := '';
        Lease."Server Generation" := NewToken();
        Lease."Op Kind" := Lease."Op Kind"::none;
        Lease.Insert();
        Commit();
    end;

    /// <summary>A fresh 32-char lowercase-hex token derived from a new GUID. Shared generator for
    /// the lease's Server Generation, Token, etc. (Tasks 2-4 reuse this).</summary>
    procedure NewToken(): Text
    begin
        exit(DelChr(LowerCase(Format(CreateGuid())), '=', '{}-'));
    end;

    /// <summary>Documented client contract (design §4): a holder of the lease MUST renew faster than
    /// this period while idle between operations. Not enforced directly — GraceMs() is derived from
    /// it and absorbs a briefly-late renew/clock jitter without flipping a live holder to orphaned.</summary>
    local procedure RenewPeriodMs(): Integer
    begin
        exit(5000);
    end;

    /// <summary>A HARD constant &gt;= 3x the documented renew period (design §4, R4 fable F1), so a
    /// single stalled renew never flips a live op holder to orphaned. Used only to classify an
    /// unresolved op marker as operation-busy (holder presumed alive) vs operation-orphaned (holder
    /// presumed dead) on AcquireLease — it does NOT change what RenewLease/RunMutant honor.</summary>
    local procedure GraceMs(): Integer
    begin
        exit(3 * RenewPeriodMs());
    end;

    /// <summary>Attempts to acquire the machine-global lease under a short LockTable critical section
    /// (design §4, R4-hardened). Order matters and is deliberate:
    /// 1. generation-changed — ALWAYS first; a stale acquire that predates a ForceResetLease must
    ///    never land in the new generation, regardless of any other row state.
    /// 2. operation-busy / operation-orphaned — an unresolved op (Op Kind &lt;&gt; none) is never
    ///    stolen; busy (holder presumed alive, within grace) backs off, orphaned (past grace) is
    ///    reported for the caller's re-check-once + reconcilable quarantine. Takes priority over the
    ///    idempotent-nonce replay below.
    /// 3. idempotent-nonce replay — ONLY when the row is currently Held (Token &lt;&gt; '') AND the
    ///    stored Client Nonce matches (generation already matched in step 1). Fires before a fresh
    ///    grant so a lost-ack retry from the SAME caller gets back the SAME {epoch, token,
    ///    serverGeneration} instead of a fresh grant OR a false "held" refusal — but a nonce carried
    ///    over from a since-released/reset lease (Token = '') can never be mistaken for a live grant
    ///    (the empty-vs-empty false-match hazard this project treats as its signature bug).
    /// 4. free (Token = '') or expired-and-idle (Op Kind = none AND CurrentDateTime &gt; Expires At)
    ///    -> fresh grant.
    /// 5. else (held, unexpired, different caller) -> refuse with reason "held".
    /// The pre-seeded row must always Get(''); if it somehow does not, fail loudly rather than
    /// silently grant.</summary>
    procedure TryAcquire(Owner: Text; TtlSeconds: Integer; ClientNonce: Text; ExpectedGeneration: Text; var Granted: Boolean; var Epoch: Integer; var Token: Text; var ServerGeneration: Text; var LastCompletedOpSeq: BigInteger; var ExpiresAt: DateTime; var Reason: Text; var Holder: Text; var OpAttemptId: Text; var OpStartedAt: DateTime)
    var
        Lease: Record "LC Lease";
    begin
        Granted := false;
        Epoch := 0;
        Token := '';
        ServerGeneration := '';
        LastCompletedOpSeq := 0;
        ExpiresAt := 0DT;
        Reason := '';
        Holder := '';
        OpAttemptId := '';
        OpStartedAt := 0DT;

        if ClientNonce = '' then
            Error(BlankClientNonceErr());

        Lease.LockTable();
        if not Lease.Get('') then
            Error(LeaseRowMissingErr());

        // 1. Generation check.
        if ExpectedGeneration <> Lease."Server Generation" then begin
            Reason := 'generation-changed';
            exit;
        end;

        // 2. Op-marker check.
        if Lease."Op Kind" <> Lease."Op Kind"::none then begin
            if CurrentDateTime <= (Lease."Expires At" + GraceMs()) then begin
                Reason := 'operation-busy';
                Holder := Lease.Owner;
                ExpiresAt := Lease."Expires At";
            end else begin
                Reason := 'operation-orphaned';
                OpAttemptId := Lease."Op Attempt Id";
                OpStartedAt := Lease."Op Started At";
            end;
            exit;
        end;

        // 3. Idempotent-nonce replay (Held only — Token <> ''). ClientNonce <> '' is redundant with
        // the top-of-procedure guard but kept here as defense in depth: this branch must never
        // false-match on a blank nonce regardless of any future caller path that bypasses that guard.
        if (Lease.Token <> '') and (ClientNonce <> '') and (Lease."Client Nonce" = ClientNonce) then begin
            Granted := true;
            Epoch := Lease.Epoch;
            Token := Lease.Token;
            ServerGeneration := Lease."Server Generation";
            LastCompletedOpSeq := Lease."Last Completed Op Seq";
            ExpiresAt := Lease."Expires At";
            exit;
        end;

        // 4. Free or expired-and-idle -> fresh grant.
        if (Lease.Token = '') or (CurrentDateTime > Lease."Expires At") then begin
            Lease.Epoch += 1;
            Lease.Token := CopyStr(NewToken(), 1, MaxStrLen(Lease.Token));
            Lease.Owner := CopyStr(Owner, 1, MaxStrLen(Lease.Owner));
            Lease."Expires At" := CurrentDateTime + (TtlSeconds * 1000);
            Lease."Op Kind" := Lease."Op Kind"::none;
            Lease."Client Nonce" := CopyStr(ClientNonce, 1, MaxStrLen(Lease."Client Nonce"));
            Lease.Modify();
            Commit();

            Granted := true;
            Epoch := Lease.Epoch;
            Token := Lease.Token;
            ServerGeneration := Lease."Server Generation";
            LastCompletedOpSeq := Lease."Last Completed Op Seq";
            ExpiresAt := Lease."Expires At";
            exit;
        end;

        // 5. Held, unexpired, idle, different caller -> refuse.
        Reason := 'held';
        Holder := Lease.Owner;
        ExpiresAt := Lease."Expires At";
    end;

    /// <summary>Extends the lease under a short LockTable critical section (design §4). A matching
    /// (Epoch, Token, Generation) is honored EVEN IF momentarily past Expires At — a matching token
    /// proves no steal occurred (a steal would have changed the token), and an op marker would have
    /// blocked any competing acquire in the meantime. Any mismatch (stale epoch/token, wrong
    /// generation, or a released/reset lease) -> renewed:false; no partial state is written.</summary>
    procedure TryRenew(Epoch: Integer; Token: Text; Generation: Text; TtlSeconds: Integer; var Renewed: Boolean; var ExpiresAt: DateTime)
    var
        Lease: Record "LC Lease";
    begin
        Renewed := false;
        ExpiresAt := 0DT;

        Lease.LockTable();
        if not Lease.Get('') then
            Error(LeaseRowMissingErr());

        if (Lease.Epoch = Epoch) and (Lease.Token = Token) and (Lease."Server Generation" = Generation) then begin
            Lease."Expires At" := CurrentDateTime + (TtlSeconds * 1000);
            Lease.Modify();
            Commit();
            Renewed := true;
            ExpiresAt := Lease."Expires At";
        end;
    end;

    /// <summary>Releases the lease under a short LockTable critical section (design §4). Only a
    /// matching (Epoch, Token, Generation) AND an idle op marker (Op Kind = none) may release — an
    /// in-flight op is never released out from under itself. A successful release INVALIDATES
    /// renewal credentials (Token := '', Epoch += 1, Expires At := 0DT, Client Nonce := '') so a
    /// delayed renew for the old (epoch, token) can never resurrect a released lease. A non-matching
    /// call is treated as an idempotent success (released:true, no reason) — a prior release already
    /// bumped the epoch, so a retry of that same release is not an error.</summary>
    procedure TryRelease(Epoch: Integer; Token: Text; Generation: Text; var Released: Boolean; var Reason: Text)
    var
        Lease: Record "LC Lease";
    begin
        Released := false;
        Reason := '';

        Lease.LockTable();
        if not Lease.Get('') then
            Error(LeaseRowMissingErr());

        if (Lease.Epoch = Epoch) and (Lease.Token = Token) and (Lease."Server Generation" = Generation) then begin
            if Lease."Op Kind" <> Lease."Op Kind"::none then begin
                Reason := 'op-in-flight';
                exit;
            end;
            Lease.Token := '';
            Lease.Epoch += 1;
            Lease."Expires At" := 0DT;
            Lease."Client Nonce" := '';
            Lease.Modify();
            Commit();
            Released := true;
            exit;
        end;

        // No match: idempotent success — a prior release/reset already invalidated these credentials.
        Released := true;
    end;

    local procedure LeaseRowMissingErr(): Text
    begin
        exit('The "LC Lease" pre-seeded row is missing (primary key ''''). Refusing to silently grant a lease without it — reinstall or upgrade "LethAL Control" to re-seed it.');
    end;

    /// <summary>ClientNonce is a required AcquireLease parameter (design §4). A blank value is a
    /// caller-contract violation, not a legitimate replay key: "Client Nonce" is blank on the pristine
    /// pre-seeded row and is reset to '' by every TryRelease, so a blank incoming nonce could otherwise
    /// false-match an unrelated held lease and leak its live credentials to the wrong caller.</summary>
    local procedure BlankClientNonceErr(): Text
    begin
        exit('AcquireLease requires a non-blank clientNonce. Refusing to evaluate the idempotent-nonce replay against a blank value — a blank nonce could false-match an unrelated held lease''s blank "Client Nonce" and leak its credentials.');
    end;
}
