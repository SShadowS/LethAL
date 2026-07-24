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

    /// <summary>Writes the active tuple (table + the in-memory attestation expectations this run is
    /// judged against). Deliberately does NOT Commit: it is called from inside RunMutant phase 1's
    /// single locked transaction (design §5), which owns the one Commit — so the op marker and the
    /// active row land atomically or not at all. Local by construction: under the fence, the ONLY
    /// legitimate writer of "LC Mutation Active" is a phase 1 that has just proven it holds the
    /// lease; an unfenced public SetActive would be a way around that proof.</summary>
    local procedure WriteActive(TargetAppId: Text; ArtifactId: Text; MutantId: Text)
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
        CachedTargetAppId := TargetAppId;
        CachedArtifactId := ArtifactId;
        CachedMutantId := MutantId;
        Loaded := true;
    end;

    /// <summary>Replaces 5C-A's ClearActive (design §5). Two deliberately DIFFERENT scopes:
    ///
    /// The TABLE write is CONDITIONAL — it blanks "LC Mutation Active" only when the row still holds
    /// THIS attempt's exact tuple, so a phase 3 that arrives after another attempt legitimately
    /// re-activated the row never blanks that attempt's mutant out from under it. The comparison is
    /// against the CopyStr-bounded values WriteActive actually stored, not the raw arguments: an
    /// over-long id would otherwise make our OWN row un-clearable and strand a live mutant in the
    /// container — the worst failure direction available here.
    ///
    /// The IN-MEMORY reset is UNCONDITIONAL (design §5, R4 fable F3), matching 5C-A ClearActive's
    /// in-memory behavior: a surviving ExpectedArtifactId/ObservedAny would fake a clean attestation
    /// for the wrong artifact on the next call — precisely the false verdict this layer exists to
    /// prevent.
    ///
    /// NO Commit: phase 3 is ONE transaction with exactly one Commit, which it owns (R2 fix). The
    /// Commit that 5C-A's ClearActive did has moved there.
    ///
    /// LOCAL by construction (human decision overriding the brief's pseudo-code, which had this public):
    /// same reasoning as WriteActive — an unfenced public clear of "LC Mutation Active" bypasses the
    /// ownership proof exactly as much as an unfenced public write would. Its only caller is
    /// TryFinishRun, in this same codeunit, which has already proven it holds the lease before calling
    /// it.</summary>
    local procedure ClearActiveIf(TargetAppId: Text; ArtifactId: Text; MutantId: Text)
    var
        Active: Record "LC Mutation Active";
    begin
        // Nested rather than `if Active.Get('') and (...)`: AL does not guarantee short-circuit
        // evaluation of `and`, so a single flat condition could reach Modify() on a record whose
        // Get() failed.
        if Active.Get('') then
            if (Active."Target App Id" = CopyStr(TargetAppId, 1, MaxStrLen(Active."Target App Id"))) and
               (Active."Artifact Id" = CopyStr(ArtifactId, 1, MaxStrLen(Active."Artifact Id"))) and
               (Active."Mutant Id" = CopyStr(MutantId, 1, MaxStrLen(Active."Mutant Id"))) then begin
                Active."Target App Id" := '';
                Active."Artifact Id" := '';
                Active."Mutant Id" := '';
                Active.Modify();
            end;
        ResetAttestationState();
    end;

    /// <summary>Blanks the active tuple UNCONDITIONALLY (table + in-memory), no Commit — the caller
    /// owns the single Commit of its transaction. Used ONLY by the two recovery paths whose
    /// authorization already proves ownership of whatever the row holds: TryRecoverOp (the caller's
    /// (epoch, token, generation, attemptId, opSeq) matched the ACTIVE marker, and under the fence
    /// only a marker holder's phase 1 can have written the row) and TryForceResetLease (design §8,
    /// R4 sol#5 — a recovered container must not keep a committed mutant that the next fresh session
    /// would execute and move a verdict with). Everything else must use the tuple-conditional
    /// ClearActiveIf.</summary>
    local procedure ForceClearActive()
    var
        Active: Record "LC Mutation Active";
    begin
        if Active.Get('') then begin
            Active."Target App Id" := '';
            Active."Artifact Id" := '';
            Active."Mutant Id" := '';
            Active.Modify();
        end;
        ResetAttestationState();
    end;

    /// <summary>Clears every in-memory field the SingleInstance instance carries between calls: the
    /// cached active tuple AND the attestation expectations/observations. Extracted from 5C-A's
    /// ClearActive so both phase-3 exits (matched and lease-invalid) can run it unconditionally.
    /// Loaded stays TRUE with a blank cache on purpose — that makes IsActive fail closed (no mutant
    /// activates) instead of re-reading a table row that may now belong to another attempt.</summary>
    local procedure ResetAttestationState()
    begin
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

    /// <summary>Read-only accessor for HarnessInfo v2 (design §7, Task 5): reports the live "Server
    /// Generation" so a client can obtain the echo ForceResetLease authenticates against (design §8, R4
    /// sol#4) in the exact recovery situation the action exists for — a session killed mid-run. No OTHER
    /// endpoint returns this value unless an acquire is GRANTED, and a still-active op or a live
    /// holder's own token refuses a grant; without this accessor, ForceResetLease would be uninvokable
    /// in precisely that case. Follows this codeunit's established Get('') + fail-loud pattern. No
    /// LockTable: a plain informational read, not part of any mutating critical section, so it never
    /// takes a lock the fenced operations above would otherwise contend on.</summary>
    procedure CurrentServerGeneration(): Text
    var
        Lease: Record "LC Lease";
    begin
        if not Lease.Get('') then
            Error(LeaseRowMissingErr());
        exit(Lease."Server Generation");
    end;

    /// <summary>Documented client contract (design §4/§6): a holder of the lease MUST renew AT LEAST AS
    /// OFTEN AS this period, CONTINUOUSLY — design §6's single-flight renew heartbeat runs at ttl/3 in
    /// the runner as a background timer that keeps firing for the whole duration of an in-flight
    /// operation, not only while idle between operations. Not enforced directly — GraceMs() is derived
    /// from it and absorbs a briefly-late renew/clock jitter without flipping a live holder to orphaned.
    /// For the contract to hold, the client's ttlSeconds must be at most 3 x RenewPeriodMs() (15s at the
    /// current 5000ms value) — a ttl/3 heartbeat on a longer ttl would renew less often than this period
    /// requires. AT EXACTLY 15s the heartbeat interval equals the period, and that is genuinely fine —
    /// the contract is "at least as often as", never "strictly faster than"; do not tighten this bound.
    /// NOTE: "3 x RenewPeriodMs()" here and GraceMs() below are numerically equal (both 15000ms) at the
    /// CURRENT constants only, because each is independently defined as "3 x RenewPeriodMs()" — this is
    /// a coincidence of today's constants, not a derivation of one from the other, and a reader must not
    /// assume the ttl bound and GraceMs() are the same obligation just because they share a value today.
    /// RenewPeriodMs() itself is `local` — Task 8's client-side heartbeat cannot read it and must
    /// hardcode the 15s bound; cite THIS comment when it does, so the constant's provenance is not
    /// lost.</summary>
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

    /// <summary>The minimum runway a run claim guarantees on "Expires At" (design §5: a phase-1 tuple
    /// match is honored even if momentarily past "Expires At", and the claim extends it atomically).
    /// Deliberately GraceMs() + one renew period: AcquireLease classifies an unresolved marker as
    /// orphaned only past "Expires At" + GraceMs(), so this guarantees a run that was just claimed
    /// cannot be called orphaned before the holder's next heartbeat renew is a full period late.
    /// It is a FLOOR, never a ceiling — ExtendRunClaim never shortens a longer deadline the holder's
    /// own RenewLease already set, and it is not the run's time budget: a long run stays alive by
    /// renewing, exactly as an idle holder does — the client's ttl/3 heartbeat (design §6) keeps firing
    /// for the whole duration of an in-flight operation, not only while idle. This runway is SLACK on
    /// top of that continuous heartbeat, never a substitute for it: it covers the gap between the claim
    /// landing and the holder's next scheduled renew, not the run's actual duration.</summary>
    local procedure RunClaimRunwayMs(): Integer
    begin
        exit(GraceMs() + RenewPeriodMs());
    end;

    /// <summary>Pushes "Expires At" out to at least RunClaimRunwayMs() from now, never inwards. Called
    /// only from the ONE branch of TryBeginRun that actually claims (the fresh-claim branch) — the
    /// same-active branch that used to also claim was hardened to refuse outright, touching nothing, so
    /// it no longer calls this — inside the locked transaction, so the "honored even if momentarily past
    /// Expires At" rule (design §5 sol#6, same as TryRenew) cannot leave a live run sitting on an
    /// already-lapsed deadline for a competing acquire to classify as orphaned.</summary>
    local procedure ExtendRunClaim(var Lease: Record "LC Lease")
    var
        Runway: DateTime;
    begin
        Runway := CurrentDateTime + RunClaimRunwayMs();
        if Lease."Expires At" < Runway then
            Lease."Expires At" := Runway;
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

        // 2. Tombstone check (priority over same-active/fresh-begin — see doc comment). Keep in sync
        // with the other three opSeq classification blocks (TryEndPublish, TryBeginRun, TryRecoverOp).
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

        // 2. Tombstone check (idempotent success — see doc comment on the Begin/End asymmetry). Keep in
        // sync with the other three opSeq classification blocks (TryBeginPublish, TryBeginRun, TryRecoverOp).
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

    /// <summary>PHASE 1 of the two-phase RunMutant fence (design §5) — CLAIM. A short LockTable
    /// critical section, ONE transaction, exactly one Commit at the end of each claiming branch (the
    /// Commit releases the lock BY DESIGN, so phase 2 runs with no lease lock held).
    ///
    /// The opSeq rules mirror TryBeginPublish EXACTLY, and must keep doing so. The whole op-marker
    /// state machine rests on one cross-op invariant: WHILE "Op Kind" &lt;&gt; none, "Op Seq" is always
    /// "Last Completed Op Seq" + 1. TryBeginPublish's/TryEndPublish's safety argument (their tombstone
    /// branch and their same-active branch are mutually exclusive regardless of order) is derived from
    /// that invariant alone, so a run claim assigning "Op Seq" by any other rule would retroactively
    /// break publish. Order:
    /// 1. blank/zero credentials or blank AttemptId -&gt; fail loud (ValidateFenceCredentials) — never
    ///    let a blank value equality-match a blank stored value into a success path.
    /// 2. (Epoch, Token, Generation) mismatch -&gt; Reason 'lease-invalid', touch nothing. Checked BEFORE
    ///    the artifact guard on purpose: a caller that has genuinely lost the lease must always be told
    ///    'lease-invalid', because that is the status the client latches on to invalidate the batch's
    ///    verdicts (design §8); handing it the weaker 'artifact-mismatch' instead would silently skip
    ///    that latch when BOTH are wrong. A match is honored EVEN IF momentarily past "Expires At" —
    ///    same holder, same rule as TryRenew (design §5 sol#6) — and the claim extends it atomically.
    /// 3. artifact guard -&gt; Reason 'artifact-mismatch', claim nothing. Placed before any write so a
    ///    mismatched artifact can never strand a marker, and can never briefly activate a mutant for
    ///    an artifact that is not the deployed one.
    /// 4. OpSeq &lt;= "Last Completed Op Seq" -&gt; the op is already tombstoned; refuse. A delayed
    ///    duplicate of a completed run must never re-run it (and its result can no longer be recorded:
    ///    phase 3 would find the marker gone).
    /// 5. SAME active (run, OpSeq, AttemptId) -&gt; REFUSE, Reason 'op-in-flight'. Design §5's phase-1
    ///    rule requires "Op Kind" = none for admission — UNLIKE TryBeginPublish, a same-active match is
    ///    NEVER treated as an idempotent re-claim here. For publish, admitting a re-claim merely
    ///    re-affirms a marker; for a run, admission IS the authorization to execute phase 2, so admitting
    ///    a duplicate here would let it enter phase 2 CONCURRENTLY with the still-running original
    ///    against shared "AL Test Suite" state — and because the marker carries no MutantId, a duplicate
    ///    with the same (OpSeq, AttemptId) but a DIFFERENT MutantId would still reach WriteActive and
    ///    swap the committed active tuple out from under the original, yielding a verdict for the wrong
    ///    mutant. Touches nothing (no Modify/WriteActive/Commit). 'op-in-flight' reuses TryRelease's
    ///    existing vocabulary for this exact condition, not a new term. NOTE the client-side counterpart:
    ///    design §5 forbids retrying a RunMutant whose op is still ACTIVE (the caller polls/quarantines
    ///    instead) — this refusal is the server-side enforcement of that rule, not merely documentation
    ///    of it.
    /// 6. OpSeq = "Last Completed Op Seq" + 1 AND "Op Kind" = none -&gt; fresh claim.
    /// 7. else (a different attempt claiming the active seq, a publish in flight, any other non-match)
    ///    -&gt; refuse 'lease-invalid'.</summary>
    procedure TryBeginRun(Epoch: Integer; Token: Text; Generation: Text; AttemptId: Text; OpSeq: BigInteger; TargetAppId: Text; ArtifactId: Text; MutantId: Text; var Claimed: Boolean; var Reason: Text)
    var
        Lease: Record "LC Lease";
    begin
        Claimed := false;
        Reason := '';

        ValidateFenceCredentials(Epoch, Token, Generation, AttemptId);

        Lease.LockTable();
        if not Lease.Get('') then
            Error(LeaseRowMissingErr());

        // 1. Tuple check — highest priority (see doc comment).
        if (Lease.Epoch <> Epoch) or (Lease.Token <> Token) or (Lease."Server Generation" <> Generation) then begin
            Reason := 'lease-invalid';
            exit;
        end;

        // 2. Artifact guard (5C-A's detector, now inside the fence and before any write). Blank ids
        // are refused outright: RegisteredArtifact returns '' for an unknown target, so a blank
        // TargetAppId with a blank ArtifactId would otherwise equality-match ('' = '') and claim a run
        // for no artifact at all — the empty-vs-empty false match this project treats as its signature
        // bug.
        if (TargetAppId = '') or (ArtifactId = '') or (RegisteredArtifact(TargetAppId) <> ArtifactId) then begin
            Reason := 'artifact-mismatch';
            exit;
        end;

        // 3. Tombstone check (priority over same-active/fresh-claim — see TryBeginPublish's argument).
        // Keep in sync with the other three opSeq classification blocks (TryBeginPublish, TryEndPublish,
        // TryRecoverOp). OpSeq <= 0 is not fail-loud here (unlike Epoch/Token/Generation/AttemptId in
        // ValidateFenceCredentials): "Last Completed Op Seq" starts at 0 on a pristine row, so
        // OpSeq <= 0 always satisfies this branch (0 <= 0 holds) and is therefore always refused here,
        // never able to reach the same-active or fresh-claim branches below.
        if OpSeq <= Lease."Last Completed Op Seq" then begin
            Reason := 'lease-invalid';
            exit;
        end;

        // 4. Same active (run, OpSeq, AttemptId) -> REFUSE, Reason 'op-in-flight' (design §5: phase 1
        // admission requires Op Kind = none — no same-active re-claim on the run path; see doc comment).
        // Deliberately touches nothing: no Modify, no WriteActive, no Commit, Claimed stays false.
        if (Lease."Op Kind" = Lease."Op Kind"::run) and (Lease."Op Seq" = OpSeq) and (Lease."Op Attempt Id" = AttemptId) then begin
            Reason := 'op-in-flight';
            exit;
        end;

        // 5. Fresh claim.
        if (OpSeq = Lease."Last Completed Op Seq" + 1) and (Lease."Op Kind" = Lease."Op Kind"::none) then begin
            Lease."Op Kind" := Lease."Op Kind"::run;
            Lease."Op Attempt Id" := CopyStr(AttemptId, 1, MaxStrLen(Lease."Op Attempt Id"));
            Lease."Op Seq" := OpSeq;
            Lease."Op Started At" := CurrentDateTime;
            ExtendRunClaim(Lease);
            Lease.Modify();
            WriteActive(TargetAppId, ArtifactId, MutantId);
            Commit();
            Claimed := true;
            exit;
        end;

        // 6. Anything else -> refuse.
        Reason := 'lease-invalid';
    end;

    /// <summary>PHASE 3 of the two-phase RunMutant fence (design §5) — VERIFY-AND-CLEAR. A short
    /// LockTable critical section, ONE transaction, EXACTLY ONE Commit, and no internal Commit
    /// anywhere below it (ClearActiveIf deliberately does not commit — R2 fix).
    ///
    /// The result of a mutant run is recorded ONLY on an exact match of (Epoch, Token, Generation)
    /// AND "Op Kind" = run AND "Op Attempt Id" = AttemptId AND "Op Seq" = OpSeq. A run that cannot
    /// prove it still holds the lease it started under must not have its result recorded — that is the
    /// entire point of the layer. On a match, the SAME transaction clears this attempt's active tuple
    /// (tuple-conditional), clears the marker and advances "Last Completed Op Seq" to "Op Seq", so the
    /// container is left unmutated and the op tombstoned atomically; by the cross-op invariant an
    /// active marker's "Op Seq" is always "Last Completed Op Seq" + 1, so the tombstone only ever
    /// advances.
    ///
    /// Any mismatch -&gt; Verified = false (the caller reports 'lease-invalid'): BOTH the "LC Lease" row
    /// and the "LC Mutation Active" row are left completely untouched — they belong to whoever holds
    /// the lease now.
    ///
    /// The in-memory attestation reset runs UNCONDITIONALLY on BOTH exits (design §5, R4 fable F3):
    /// via ClearActiveIf on the matched path, and directly on the lease-invalid path. A surviving
    /// ExpectedArtifactId/ObservedAny would fake a clean attestation for the wrong artifact on the
    /// next call.</summary>
    procedure TryFinishRun(Epoch: Integer; Token: Text; Generation: Text; AttemptId: Text; OpSeq: BigInteger; TargetAppId: Text; ArtifactId: Text; MutantId: Text; var Verified: Boolean)
    var
        Lease: Record "LC Lease";
    begin
        Verified := false;

        // Re-validates the same (Epoch, Token, Generation, AttemptId) shape phase 1's TryBeginRun
        // already validated identically, since RunMutant passes it the SAME values for both phases —
        // reachable as a failure only if RunMutant is ever changed to pass different values to the two
        // phases. If it did fire here, the Error would unwind past phase 3 and strand the marker (no
        // phase-3 Commit ever runs to clear it).
        ValidateFenceCredentials(Epoch, Token, Generation, AttemptId);

        Lease.LockTable();
        if not Lease.Get('') then
            Error(LeaseRowMissingErr());

        if (Lease.Epoch = Epoch) and (Lease.Token = Token) and (Lease."Server Generation" = Generation) and
           (Lease."Op Kind" = Lease."Op Kind"::run) and (Lease."Op Attempt Id" = AttemptId) and (Lease."Op Seq" = OpSeq) then begin
            ClearActiveIf(TargetAppId, ArtifactId, MutantId);
            Lease."Op Kind" := Lease."Op Kind"::none;
            Lease."Last Completed Op Seq" := OpSeq;
            Lease.Modify();
            Commit();
            Verified := true;
            exit;
        end;

        // lease-invalid: touch no row. The in-memory reset is still unconditional.
        ResetAttestationState();
    end;

    /// <summary>Server-side recovery of the caller's OWN stranded op marker (design §5/§8). A short
    /// LockTable critical section, ONE transaction, exactly one Commit on the recovering branch.
    ///
    /// Authorization is the full proof-of-ownership tuple: (Epoch, Token, Generation) must match the
    /// current row AND the ACTIVE marker must be exactly this caller's ("Op Attempt Id" = AttemptId
    /// AND "Op Seq" = OpSeq) — never another attempt's op. Kind-agnostic ("Op Kind" &lt;&gt; none), so it
    /// recovers a stranded run or a stranded publish alike; the active-tuple clear is a no-op for a
    /// publish, which never writes that row.
    ///
    /// The active clear is UNCONDITIONAL (ForceClearActive) rather than tuple-conditional because
    /// RecoverOp receives no (targetAppId, artifactId, mutantId) — and it does not need them: under
    /// the fence, only a marker holder's phase 1 can have written that row, and the marker match IS
    /// the ownership proof. Leaving it set is the dangerous direction (R4 sol#5).
    ///
    /// Idempotent: OpSeq &lt;= "Last Completed Op Seq" -&gt; {Recovered = true, AlreadyCompleted = true},
    /// mirroring TryEndPublish's tombstone branch — "is my op resolved" is truthfully yes.
    ///
    /// CLIENT CONTRACT (design §5, R4 sol#1/fable F2): RecoverOp is permitted ONLY after a PARSED
    /// application-level terminal response, which proves the AL invocation unwound — NEVER after a
    /// bare HTTP status (a proxy 502/504), a connection error or a client timeout, which are
    /// indistinguishable from a still-running AL op and must poll/quarantine instead. The server
    /// cannot see that difference; the gate is enforced client-side.</summary>
    procedure TryRecoverOp(Epoch: Integer; Token: Text; Generation: Text; AttemptId: Text; OpSeq: BigInteger; var Recovered: Boolean; var AlreadyCompleted: Boolean)
    var
        Lease: Record "LC Lease";
    begin
        Recovered := false;
        AlreadyCompleted := false;

        ValidateFenceCredentials(Epoch, Token, Generation, AttemptId);

        Lease.LockTable();
        if not Lease.Get('') then
            Error(LeaseRowMissingErr());

        // 1. Tuple check.
        if (Lease.Epoch <> Epoch) or (Lease.Token <> Token) or (Lease."Server Generation" <> Generation) then
            exit;

        // 2. Tombstone check — already resolved, nothing to recover. Keep in sync with the other three
        // opSeq classification blocks (TryBeginPublish, TryEndPublish, TryBeginRun).
        if OpSeq <= Lease."Last Completed Op Seq" then begin
            Recovered := true;
            AlreadyCompleted := true;
            exit;
        end;

        // 3. Exact match on the ACTIVE marker -> clear marker + active tuple + tombstone, one txn.
        if (Lease."Op Kind" <> Lease."Op Kind"::none) and (Lease."Op Attempt Id" = AttemptId) and (Lease."Op Seq" = OpSeq) then begin
            ForceClearActive();
            Lease."Op Kind" := Lease."Op Kind"::none;
            Lease."Last Completed Op Seq" := OpSeq;
            Lease.Modify();
            Commit();
            Recovered := true;
            exit;
        end;

        // 4. A different attempt's op, an idle marker, or any other non-match -> refuse.
    end;

    /// <summary>Operator recovery action (design §8). A short LockTable critical section, ONE
    /// transaction, exactly one Commit.
    ///
    /// OPERATIONAL CONTRACT — the recovery is ONE procedure, in this order, and a restart alone is not
    /// enough (the marker and the active tuple are committed TABLE ROWS that survive a restart):
    /// 1. Restart the NST/container. That is what actually kills a surviving AL op — the running
    ///    session and every SingleInstance codeunit die with it. THIS STEP IS TAKEN ON TRUST: "Server
    ///    Generation" is a persistent table field (minted at install/upgrade and by this action itself),
    ///    not something an NST restart changes, so this action has no server-side way to verify the
    ///    operator actually restarted anything before calling it — that is procedural discipline, not a
    ///    mechanism this action enforces.
    /// 2. Read the CURRENT "Server Generation" from a live status/harness call against the RESTARTED
    ///    service instance.
    /// 3. Call ForceResetLease passing that value as ExpectedGeneration.
    /// 4. Probe that the container is clean (baseline run / active-state read), then clear the
    ///    'container-needs-recycle' quarantine record.
    ///
    /// AUTHORIZATION (R4 sol#4): a KNOWING, DOCUMENTED DEVIATION from design §8's requirement to "bind
    /// authorization to a newly-observed NST/process incarnation" — not an oversight. Binding to an
    /// actual incarnation proved infeasible in AL: there is no reachable API that observes "this process
    /// just restarted" (the same category of platform limit as HarnessInfo's tenant-count gap — see
    /// ControlApi.HarnessInfo's doc comment). This takes the plan's Task-4-Step-4 fallback clause ("if
    /// infeasible in AL, document the operational binding and gate via permission") and substitutes the
    /// ExpectedGeneration echo below; recorded as such in the Task 10 docs. The reset is refused unless
    /// the echo equals the row's CURRENT "Server Generation". What this actually delivers is REPLAY PROTECTION
    /// ACROSS RESETS, not incarnation binding: every successful reset mints a NEW generation, so (a) a
    /// pre-recorded or replayed reset request cannot fire a second time — its echo goes stale the moment
    /// the reset it was meant for succeeds — and (b) a caller holding a generation from before the LAST
    /// reset is refused. It does NOT prove the caller observed a post-restart state that differs from a
    /// pre-restart one: the generation value is byte-identical before and after a bare NST restart, and
    /// only a subsequent ForceResetLease call changes it. A blank echo fails loud rather than being
    /// compared. This is deliberately NOT an invented NST-incarnation API: it is replay protection on the
    /// generation token, no more.
    ///
    /// In one transaction: mint a new "Server Generation" (every pre-reset credential is now dead at
    /// every fence, including a stale pre-recovery client's), "Op Kind" = none, clear Token / "Client
    /// Nonce" / Owner / "Op Attempt Id" / "Op Started At" / "Op Seq" / "Expires At", Epoch += 1, AND
    /// clear the committed "LC Mutation Active" row (R4 sol#5 — otherwise a stale active mutant would
    /// be executed by the next fresh session and move a verdict). "Last Completed Op Seq" is
    /// deliberately PRESERVED: it is a monotonic tombstone, and rewinding it would allow a sequence
    /// number to be reused.</summary>
    procedure TryForceResetLease(ExpectedGeneration: Text; var ResetDone: Boolean; var NewGeneration: Text; var NewEpoch: Integer; var Reason: Text)
    var
        Lease: Record "LC Lease";
    begin
        ResetDone := false;
        NewGeneration := '';
        NewEpoch := 0;
        Reason := '';

        if ExpectedGeneration = '' then
            Error(BlankExpectedGenerationErr());

        Lease.LockTable();
        if not Lease.Get('') then
            Error(LeaseRowMissingErr());

        if ExpectedGeneration <> Lease."Server Generation" then begin
            Reason := 'generation-changed';
            exit;
        end;

        Lease."Server Generation" := CopyStr(NewToken(), 1, MaxStrLen(Lease."Server Generation"));
        Lease.Epoch += 1;
        Lease.Token := '';
        Lease.Owner := '';
        Lease."Expires At" := 0DT;
        Lease."Client Nonce" := '';
        Lease."Op Kind" := Lease."Op Kind"::none;
        Lease."Op Attempt Id" := '';
        Lease."Op Started At" := 0DT;
        Lease."Op Seq" := 0;
        Lease.Modify();
        ForceClearActive();
        Commit();

        ResetDone := true;
        NewGeneration := Lease."Server Generation";
        NewEpoch := Lease.Epoch;
    end;

    /// <summary>Caller-contract gate shared by every fenced operation (TryBeginRun, TryFinishRun,
    /// TryRecoverOp). Validated BEFORE taking the lock — a malformed call never gets a critical
    /// section.</summary>
    local procedure ValidateFenceCredentials(Epoch: Integer; Token: Text; Generation: Text; AttemptId: Text)
    begin
        if (Epoch <= 0) or (Token = '') or (Generation = '') then
            Error(BlankLeaseCredentialsErr());
        if AttemptId = '' then
            Error(BlankAttemptIdErr());
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

    /// <summary>AttemptId is a required parameter for every op-marker operation — TryBeginPublish,
    /// TryEndPublish, and the run fence's TryBeginRun/TryFinishRun/TryRecoverOp (design §4/§5). A blank
    /// value is a caller-contract violation, not a legitimate idempotency key: allowing a blank
    /// AttemptId to persist into "Op Attempt Id" would let an unrelated later caller who ALSO supplies
    /// a blank AttemptId false-match the "same active (opSeq, attemptId)" idempotent-replay check (or
    /// the exact-match clear in TryEndPublish/TryFinishRun/TryRecoverOp) and be treated as the original
    /// caller retrying its own op — the same empty-vs-empty false-match hazard already closed for
    /// ClientNonce in TryAcquire (BlankClientNonceErr).</summary>
    local procedure BlankAttemptIdErr(): Text
    begin
        exit('BeginPublish/EndPublish/RunMutant/RecoverOp require a non-blank attemptId. Refusing to evaluate the op-marker state machine against a blank value — a blank attemptId could persist into "Op Attempt Id" and later false-match an unrelated caller''s own blank attemptId as the idempotent retry of the same op.');
    end;

    /// <summary>The fenced operations authenticate on the FULL (Epoch, Token, Generation) tuple. A
    /// blank Token, a blank Generation or a non-positive Epoch is a caller-contract violation, never a
    /// legitimate credential — and each one is exactly the value some legitimate row state already
    /// holds: TryRelease sets Token = '', and the pristine pre-seeded row has Epoch = 0. A blank/zero
    /// credential could therefore equality-match those stored values and walk a caller that holds NO
    /// lease straight into a success path. A granted epoch is always &gt;= 1 (a grant does
    /// Epoch += 1 from 0) and a granted token is always 32 hex chars, so no legitimate caller is
    /// refused here.</summary>
    local procedure BlankLeaseCredentialsErr(): Text
    begin
        exit('The fenced control operations (RunMutant, RecoverOp) require a non-blank leaseToken, a non-blank serverGeneration and a leaseEpoch >= 1. Refusing to evaluate the fence against a blank/zero credential — a blank token could equality-match a released lease''s blank "Token" and admit a caller that holds no lease at all.');
    end;

    /// <summary>ForceResetLease authenticates on an echo of the CURRENT "Server Generation" (design §8,
    /// R4 sol#4). A blank echo is a caller-contract violation: it proves nothing about which service
    /// incarnation the operator observed, and the whole point of the echo is that it can only be
    /// obtained by reading live post-restart state.</summary>
    local procedure BlankExpectedGenerationErr(): Text
    begin
        exit('ForceResetLease requires a non-blank expectedGeneration echoing the CURRENT "Server Generation", read from a live status/harness call AFTER the container/NST restart. Refusing to reset the lease without proof that the caller observed live post-restart state.');
    end;
}
