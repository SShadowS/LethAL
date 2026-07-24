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

    /// <summary>Begins a publish operation under the op-marker state machine (design §4, sol#4/fable
    /// R2-5; opSeq per R4 sol#3/F4), under a short LockTable critical section. Order is deliberate and
    /// mirrors the priority already established for AcquireLease:
    /// 1. blank AttemptId -&gt; fail loud (see BlankAttemptIdErr) — never let a blank value reach the
    ///    marker, where it could later false-match another blank-AttemptId caller as branch 3 below.
    /// 2. (Epoch, Token, Generation) mismatch -&gt; refuse (Begun=false, AlreadyCompleted=false) — no
    ///    reason is reported (the JSON shape has none); mirrors TryRenew's silent-refusal convention.
    /// 3. opSeq &lt;= Last Completed Op Seq -&gt; tombstoned: {begun:false, alreadyCompleted:true}. A
    ///    delayed duplicate Begin of an already-completed attempt can never reopen it. Checked BEFORE
    ///    the same-active check below; by construction (Op Seq is only ever set to
    ///    Last-Completed-Op-Seq-at-the-time + 1, and Last Completed Op Seq only advances when THAT
    ///    same op ends) an active marker's Op Seq is always &gt; Last Completed Op Seq, so this branch
    ///    and the next are mutually exclusive regardless of order — checked first anyway, tombstone
    ///    priority first, per the design's emphasis on that invariant.
    /// 4. SAME active (opSeq, attemptId) -&gt; idempotent success (Begun=true) — a retry of the caller's
    ///    own in-flight Begin, not a fresh acquire of the marker.
    /// 5. opSeq = Last Completed Op Seq + 1 AND Op Kind = none -&gt; fresh begin: set the marker and
    ///    stamp "Op Started At" (AcquireLease's orphan classification depends on this timestamp only
    ///    being set here, never restamped on the idempotent replay in branch 4).
    /// 6. Else (a different attempt claiming the active seq, or any other non-match) -&gt; refuse
    ///    (Begun=false, AlreadyCompleted=false).</summary>
    procedure TryBeginPublish(Epoch: Integer; Token: Text; Generation: Text; AttemptId: Text; OpSeq: BigInteger; var Begun: Boolean; var AlreadyCompleted: Boolean)
    var
        Lease: Record "LC Lease";
    begin
        Begun := false;
        AlreadyCompleted := false;

        if AttemptId = '' then
            Error(BlankAttemptIdErr());

        Lease.LockTable();
        if not Lease.Get('') then
            Error(LeaseRowMissingErr());

        // 1. Tuple check.
        if (Lease.Epoch <> Epoch) or (Lease.Token <> Token) or (Lease."Server Generation" <> Generation) then
            exit;

        // 2. Tombstone check (priority over same-active/fresh-begin — see doc comment).
        if OpSeq <= Lease."Last Completed Op Seq" then begin
            AlreadyCompleted := true;
            exit;
        end;

        // 3. Same active (opSeq, attemptId) -> idempotent success. Deliberately does NOT restamp
        // "Op Started At" — AcquireLease's orphan classification depends on the ORIGINAL start time.
        if (Lease."Op Kind" = Lease."Op Kind"::publish) and (Lease."Op Seq" = OpSeq) and (Lease."Op Attempt Id" = AttemptId) then begin
            Begun := true;
            exit;
        end;

        // 4. Fresh begin.
        if (OpSeq = Lease."Last Completed Op Seq" + 1) and (Lease."Op Kind" = Lease."Op Kind"::none) then begin
            Lease."Op Kind" := Lease."Op Kind"::publish;
            Lease."Op Attempt Id" := CopyStr(AttemptId, 1, MaxStrLen(Lease."Op Attempt Id"));
            Lease."Op Seq" := OpSeq;
            Lease."Op Started At" := CurrentDateTime;
            Lease.Modify();
            Commit();
            Begun := true;
            exit;
        end;

        // 5. Different attempt claiming the active seq (or any other non-match) -> refuse.
    end;

    /// <summary>Ends (tombstones) a publish operation (design §4). Under a short LockTable critical
    /// section. Clears the marker and advances the tombstone ONLY on an exact match of
    /// (Epoch, Token, Generation) + Op Kind = publish + Op Attempt Id = attemptId + Op Seq = opSeq —
    /// never a different attempt's op, and never a kind other than publish. Idempotent:
    /// opSeq &lt;= Last Completed Op Seq -&gt; {ended:true, alreadyCompleted:true} (note the asymmetry
    /// with TryBeginPublish's tombstone branch, which reports Begun=FALSE — End's tombstone branch
    /// reports Ended=TRUE because "already ended" IS the truthful, idempotent answer to "did my End
    /// take effect", whereas Begin's truthful answer to "did my Begin take effect" is no, it's already
    /// past that point). Outcome is NOT a parameter here — design §4 does not have it change the
    /// transition, and the caller (ControlApi.EndPublish) does not invent behavior for it either; the
    /// state machine itself has no use for it. A delayed End of a tombstoned attempt can never reclear
    /// a later op, by the same invariant argument as TryBeginPublish (an active marker's Op Seq is
    /// always &gt; Last Completed Op Seq).</summary>
    procedure TryEndPublish(Epoch: Integer; Token: Text; Generation: Text; AttemptId: Text; OpSeq: BigInteger; var Ended: Boolean; var AlreadyCompleted: Boolean)
    var
        Lease: Record "LC Lease";
    begin
        Ended := false;
        AlreadyCompleted := false;

        if AttemptId = '' then
            Error(BlankAttemptIdErr());

        Lease.LockTable();
        if not Lease.Get('') then
            Error(LeaseRowMissingErr());

        // 1. Tuple check.
        if (Lease.Epoch <> Epoch) or (Lease.Token <> Token) or (Lease."Server Generation" <> Generation) then
            exit;

        // 2. Tombstone check (idempotent success — see doc comment on the Begin/End asymmetry).
        if OpSeq <= Lease."Last Completed Op Seq" then begin
            Ended := true;
            AlreadyCompleted := true;
            exit;
        end;

        // 3. Exact match -> clear + tombstone.
        if (Lease."Op Kind" = Lease."Op Kind"::publish) and (Lease."Op Attempt Id" = AttemptId) and (Lease."Op Seq" = OpSeq) then begin
            Lease."Op Kind" := Lease."Op Kind"::none;
            Lease."Last Completed Op Seq" := OpSeq;
            Lease.Modify();
            Commit();
            Ended := true;
            exit;
        end;

        // 4. A different attempt's op, a non-publish kind, or any other non-match -> refuse.
    end;

    /// <summary>Lost-ack reconciliation read for any op, publish or run (design §4: "GetOperationStatus
    /// ... lost-ack reconciliation of any op"). Under a short LockTable critical section, for a
    /// consistent snapshot alongside the mutating Try* procedures above.
    ///
    /// Deliberately does NOT gate the read on (Epoch, Token, Generation) matching the current row —
    /// unlike TryBeginPublish/TryEndPublish, which are WRITES and must refuse a stale/wrong tuple, this
    /// is a READ whose entire purpose is to let a caller who has lost an ack (or lost track of its own
    /// credentials — e.g. after a container recycle changed the Server Generation) learn the truth
    /// regardless. Gating it the same way the writes are gated would silently defeat exactly the
    /// scenario reconciliation exists for: the caller most likely to need this call is the one whose
    /// tuple no longer matches. AttemptId is accepted for interface symmetry with
    /// TryBeginPublish/TryEndPublish but is NOT used to filter or authorize the read — the design's
    /// `completed` formula depends only on OpSeq vs "Last Completed Op Seq", and OpKind/OpAttemptId/
    /// CurrentOpSeq are always the CURRENT marker's fields (whatever op — publish or run — is active
    /// right now, if any), not necessarily the op the caller is asking about.</summary>
    procedure TryGetOperationStatus(Epoch: Integer; Token: Text; Generation: Text; AttemptId: Text; OpSeq: BigInteger; var OpKind: Text; var OpAttemptId: Text; var CurrentOpSeq: BigInteger; var LastCompletedOpSeq: BigInteger; var Completed: Boolean)
    var
        Lease: Record "LC Lease";
    begin
        OpKind := '';
        OpAttemptId := '';
        CurrentOpSeq := 0;
        LastCompletedOpSeq := 0;
        Completed := false;

        Lease.LockTable();
        if not Lease.Get('') then
            Error(LeaseRowMissingErr());

        OpKind := Format(Lease."Op Kind");
        OpAttemptId := Lease."Op Attempt Id";
        CurrentOpSeq := Lease."Op Seq";
        LastCompletedOpSeq := Lease."Last Completed Op Seq";
        Completed := OpSeq <= Lease."Last Completed Op Seq";
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

    /// <summary>AttemptId is a required parameter for both TryBeginPublish and TryEndPublish (design
    /// §4). A blank value is a caller-contract violation, not a legitimate idempotency key: allowing a
    /// blank AttemptId to persist into "Op Attempt Id" would let an unrelated later caller who ALSO
    /// supplies a blank AttemptId false-match the "same active (opSeq, attemptId)" idempotent-replay
    /// check in TryBeginPublish (or the exact-match clear in TryEndPublish) and be treated as the
    /// original caller retrying its own op — the same empty-vs-empty false-match hazard already closed
    /// for ClientNonce in TryAcquire (BlankClientNonceErr).</summary>
    local procedure BlankAttemptIdErr(): Text
    begin
        exit('BeginPublish/EndPublish require a non-blank attemptId. Refusing to evaluate the op-marker state machine against a blank value — a blank attemptId could persist into "Op Attempt Id" and later false-match an unrelated caller''s own blank attemptId as the idempotent retry of the same op.');
    end;
}
