namespace LethAL.Control;

/// <summary>The OData-exposed control surface (registered as a web service by the install codeunit;
/// procedures are OData V4 unbound actions /ODataV4/LethALControl_&lt;Proc&gt;). Layer 5C-A.</summary>
codeunit 71003 "LC Control API"
{
    /// <summary>Identity + capabilities the client verifies before any execution.</summary>
    procedure HarnessInfo() InfoJson: Text
    var
        Obj: JsonObject;
        Isolation: JsonArray;
        TestTypes: JsonArray;
    begin
        Isolation.Add('Codeunit');
        TestTypes.Add('codeunit');
        Obj.Add('appId', '5e7a1c00-1111-4c00-8c00-1e7a1c000701');
        Obj.Add('semver', '1.0.0.0');
        Obj.Add('protocolVersion', 1);
        Obj.Add('isolationModes', Isolation);
        Obj.Add('testTypes', TestTypes);
        Obj.WriteTo(InfoJson);
    end;

    /// <summary>Read-only: the artifact id the target registered for TargetAppId (empty if none).
    /// The DeploymentVerifier reads this as a pre-flight (design §B). No OData WRITE exists — the
    /// registry is written only in-process by the target's install/upgrade codeunits (design §B2).</summary>
    procedure RegisteredArtifact(TargetAppId: Text): Text
    var
        State: Codeunit "LC Control State";
    begin
        exit(State.RegisteredArtifact(TargetAppId));
    end;

    /// <summary>OData action: attempt to acquire the machine-global lease (design §4, R4-hardened).
    /// Thin wrapper — all decision logic (generation-changed / operation-busy / operation-orphaned /
    /// idempotent-nonce replay / fresh grant / held) lives in "LC Control State".TryAcquire. camelCase
    /// JSON result keys: {granted, epoch?, token?, serverGeneration?, lastCompletedOpSeq?, expiresAt?,
    /// reason?, holder?, opAttemptId?, opStartedAt?}.</summary>
    procedure AcquireLease(Owner: Text; TtlSeconds: Integer; ClientNonce: Text; ExpectedGeneration: Text) ResultJson: Text
    var
        State: Codeunit "LC Control State";
        Granted: Boolean;
        Epoch: Integer;
        Token: Text;
        ServerGeneration: Text;
        LastCompletedOpSeq: BigInteger;
        ExpiresAt: DateTime;
        Reason: Text;
        Holder: Text;
        OpAttemptId: Text;
        OpStartedAt: DateTime;
    begin
        State.TryAcquire(Owner, TtlSeconds, ClientNonce, ExpectedGeneration, Granted, Epoch, Token, ServerGeneration, LastCompletedOpSeq, ExpiresAt, Reason, Holder, OpAttemptId, OpStartedAt);
        ResultJson := BuildAcquireResult(Granted, Epoch, Token, ServerGeneration, LastCompletedOpSeq, ExpiresAt, Reason, Holder, OpAttemptId, OpStartedAt);
    end;

    /// <summary>OData action: extend the lease's Expires At (design §4). A matching (epoch, token,
    /// generation) is honored even if momentarily past Expires At. Thin wrapper over
    /// "LC Control State".TryRenew. JSON: {renewed, expiresAt?}.</summary>
    procedure RenewLease(Epoch: Integer; Token: Text; Generation: Text; TtlSeconds: Integer) ResultJson: Text
    var
        State: Codeunit "LC Control State";
        Renewed: Boolean;
        ExpiresAt: DateTime;
        Obj: JsonObject;
    begin
        State.TryRenew(Epoch, Token, Generation, TtlSeconds, Renewed, ExpiresAt);
        Obj.Add('renewed', Renewed);
        if Renewed then
            Obj.Add('expiresAt', ExpiresAt);
        Obj.WriteTo(ResultJson);
    end;

    /// <summary>OData action: release the lease, invalidating its renewal credentials so a delayed
    /// renew cannot resurrect it (design §4). Refused (op-in-flight) while an op marker is set. A
    /// non-matching call is an idempotent success (a prior release already invalidated it). Thin
    /// wrapper over "LC Control State".TryRelease. JSON: {released, reason?}.</summary>
    procedure ReleaseLease(Epoch: Integer; Token: Text; Generation: Text) ResultJson: Text
    var
        State: Codeunit "LC Control State";
        Released: Boolean;
        Reason: Text;
        Obj: JsonObject;
    begin
        State.TryRelease(Epoch, Token, Generation, Released, Reason);
        Obj.Add('released', Released);
        if Reason <> '' then
            Obj.Add('reason', Reason);
        Obj.WriteTo(ResultJson);
    end;

    /// <summary>OData action: begin a publish operation under the op-marker state machine (design §4).
    /// Thin wrapper over "LC Control State".TryBeginPublish — all decision logic (tuple check /
    /// tombstone check / same-active idempotent replay / fresh begin / refuse) lives there. JSON:
    /// {begun, alreadyCompleted?}.</summary>
    procedure BeginPublish(Epoch: Integer; Token: Text; Generation: Text; AttemptId: Text; OpSeq: BigInteger) ResultJson: Text
    var
        State: Codeunit "LC Control State";
        Begun: Boolean;
        AlreadyCompleted: Boolean;
        Obj: JsonObject;
    begin
        State.TryBeginPublish(Epoch, Token, Generation, AttemptId, OpSeq, Begun, AlreadyCompleted);
        Obj.Add('begun', Begun);
        if AlreadyCompleted then
            Obj.Add('alreadyCompleted', AlreadyCompleted);
        Obj.WriteTo(ResultJson);
    end;

    /// <summary>OData action: end (tombstone) a publish operation (design §4). Outcome is part of the
    /// interface contract but does NOT change the state transition — EndPublish clears/tombstones the
    /// marker identically whether the caller reports success or a deterministic failure; only a
    /// genuinely-unknown publish result should leave the marker set, and deciding/acting on that is a
    /// later task's recovery concern (§8), not invented here. Thin wrapper over
    /// "LC Control State".TryEndPublish. JSON: {ended, alreadyCompleted?}.</summary>
    procedure EndPublish(Epoch: Integer; Token: Text; Generation: Text; AttemptId: Text; OpSeq: BigInteger; Outcome: Text) ResultJson: Text
    var
        State: Codeunit "LC Control State";
        Ended: Boolean;
        AlreadyCompleted: Boolean;
        Obj: JsonObject;
    begin
        State.TryEndPublish(Epoch, Token, Generation, AttemptId, OpSeq, Ended, AlreadyCompleted);
        Obj.Add('ended', Ended);
        if AlreadyCompleted then
            Obj.Add('alreadyCompleted', AlreadyCompleted);
        Obj.WriteTo(ResultJson);
    end;

    /// <summary>OData action: lost-ack reconciliation read for any op, publish or run (design §4).
    /// Deliberately does NOT gate on (epoch, token, generation) matching the current row — see
    /// "LC Control State".TryGetOperationStatus's doc comment for why. Thin wrapper. JSON: {opKind,
    /// opAttemptId, opSeq, lastCompletedOpSeq, completed}.</summary>
    procedure GetOperationStatus(Epoch: Integer; Token: Text; Generation: Text; AttemptId: Text; OpSeq: BigInteger) ResultJson: Text
    var
        State: Codeunit "LC Control State";
        OpKind: Text;
        OpAttemptId: Text;
        CurrentOpSeq: BigInteger;
        LastCompletedOpSeq: BigInteger;
        Completed: Boolean;
        Obj: JsonObject;
    begin
        State.TryGetOperationStatus(Epoch, Token, Generation, AttemptId, OpSeq, OpKind, OpAttemptId, CurrentOpSeq, LastCompletedOpSeq, Completed);
        Obj.Add('opKind', OpKind);
        Obj.Add('opAttemptId', OpAttemptId);
        Obj.Add('opSeq', CurrentOpSeq);
        Obj.Add('lastCompletedOpSeq', LastCompletedOpSeq);
        Obj.Add('completed', Completed);
        Obj.WriteTo(ResultJson);
    end;

    /// <summary>OData action: recover the caller's OWN stranded op marker (design §5/§8). Thin wrapper
    /// over "LC Control State".TryRecoverOp — the proof-of-ownership rules, the unconditional
    /// active-tuple clear and the tombstone all live there, as does the client contract this MUST be
    /// gated by (a parsed application-level terminal response only — never a bare HTTP status, a
    /// connection error or a client timeout, which are indistinguishable from a still-running AL op).
    /// JSON: {recovered, alreadyCompleted?}.</summary>
    procedure RecoverOp(Epoch: Integer; Token: Text; Generation: Text; AttemptId: Text; OpSeq: BigInteger) ResultJson: Text
    var
        State: Codeunit "LC Control State";
        Recovered: Boolean;
        AlreadyCompleted: Boolean;
        Obj: JsonObject;
    begin
        State.TryRecoverOp(Epoch, Token, Generation, AttemptId, OpSeq, Recovered, AlreadyCompleted);
        Obj.Add('recovered', Recovered);
        if AlreadyCompleted then
            Obj.Add('alreadyCompleted', AlreadyCompleted);
        Obj.WriteTo(ResultJson);
    end;

    /// <summary>OData action: the operator recovery reset (design §8). Step 3 of a FOUR-step procedure
    /// that a restart alone does not accomplish — restart the NST, read the current serverGeneration
    /// from a live status/harness call against the restarted instance, call this with that value as
    /// expectedGeneration, then probe clean and clear the quarantine. The echo is the authorization:
    /// it binds the reset to a newly-observed service incarnation, because every successful reset mints
    /// a new generation and so an echo can only come from post-reset live state. Thin wrapper over
    /// "LC Control State".TryForceResetLease. JSON: {reset, serverGeneration?, epoch?, reason?}.</summary>
    procedure ForceResetLease(ExpectedGeneration: Text) ResultJson: Text
    var
        State: Codeunit "LC Control State";
        ResetDone: Boolean;
        NewGeneration: Text;
        NewEpoch: Integer;
        Reason: Text;
        Obj: JsonObject;
    begin
        State.TryForceResetLease(ExpectedGeneration, ResetDone, NewGeneration, NewEpoch, Reason);
        Obj.Add('reset', ResetDone);
        if ResetDone then begin
            Obj.Add('serverGeneration', NewGeneration);
            Obj.Add('epoch', NewEpoch);
        end else
            Obj.Add('reason', Reason);
        Obj.WriteTo(ResultJson);
    end;

    /// <summary>
    /// Run-scoped, single-method execution primitive, fenced by the machine-global lease (design §5).
    /// Three phases, and the split is the whole point: a mutant run that cannot PROVE, after the fact,
    /// that it still held the lease it started under must not have its result recorded.
    ///
    /// Phase 1 — claim, under LockTable, one transaction, one Commit (in TryBeginRun). Validates
    /// (leaseEpoch, leaseToken, serverGeneration) + the artifact + the opSeq rules, sets Op Kind = run
    /// and the active tuple together. Refusal -&gt; 'lease-invalid' / 'artifact-mismatch', nothing
    /// claimed, nothing run.
    ///
    /// Phase 2 — run, with NO lease lock held (phase 1's Commit released it), behind a catchable
    /// Codeunit.Run boundary. A server-known terminal error (test framework / AL exception) is captured
    /// as a terminal error outcome instead of unwinding past phase 3 and stranding the marker; it is
    /// reported in codeunitResults as {"error": ...}, the same fail-closed shape RunOneMethod already
    /// uses, so it can never be mistaken for a test verdict.
    ///
    /// Phase 3 — verify-and-clear, under LockTable, ONE transaction with exactly ONE Commit (in
    /// TryFinishRun). Only an exact (epoch, token, generation) + Op Kind = run + attemptId + opSeq
    /// match records the result; anything else returns 'lease-invalid' having touched no row.
    ///
    /// JSON: the 5C-A status shape, with the new status 'lease-invalid'. On any non-'ran' status the
    /// result and attestation are deliberately reported as empty/false — there is no verdict to carry.
    /// </summary>
    procedure RunMutant(TargetAppId: Text; ArtifactId: Text; AttemptId: Text; MutantId: Text; TestCodeunitId: Integer; TestMethod: Text; LeaseEpoch: Integer; LeaseToken: Text; ServerGeneration: Text; OpSeq: BigInteger) ResultJson: Text
    var
        State: Codeunit "LC Control State";
        Runner: Codeunit "LC Run Method";
        Claimed: Boolean;
        ClaimReason: Text;
        Verified: Boolean;
        CodeunitResults: Text;
        ObservedAny: Boolean;
        IdentityMismatch: Boolean;
    begin
        // PHASE 1 — claim under lock. Nothing is written, and nothing runs, unless this succeeds.
        State.TryBeginRun(LeaseEpoch, LeaseToken, ServerGeneration, AttemptId, OpSeq, TargetAppId, ArtifactId, MutantId, Claimed, ClaimReason);
        if not Claimed then
            exit(BuildStatus(ClaimReason, TargetAppId, ArtifactId, AttemptId, MutantId, TestCodeunitId, TestMethod, '', false, false));

        // PHASE 2 — run exactly one method OUTSIDE the lease lock, behind a catchable boundary.
        // GetLastErrorText is read immediately on the failing branch, before any other statement can
        // clear it. Attestation is read here, BEFORE phase 3, because phase 3 resets it unconditionally.
        Runner.SetRequest(State.NextSuiteName(), TestCodeunitId, TestMethod);
        if Runner.Run() then
            CodeunitResults := Runner.Results()
        else
            CodeunitResults := BuildRunError(GetLastErrorText());
        ObservedAny := State.AttestationObservedAny();
        IdentityMismatch := State.AttestationMismatch();

        // PHASE 3 — verify-and-clear under lock, one transaction, one Commit.
        State.TryFinishRun(LeaseEpoch, LeaseToken, ServerGeneration, AttemptId, OpSeq, TargetAppId, ArtifactId, MutantId, Verified);
        if not Verified then
            exit(BuildStatus('lease-invalid', TargetAppId, ArtifactId, AttemptId, MutantId, TestCodeunitId, TestMethod, '', false, false));

        exit(BuildStatus('ran', TargetAppId, ArtifactId, AttemptId, MutantId, TestCodeunitId, TestMethod, CodeunitResults, ObservedAny, IdentityMismatch));
    end;

    /// <summary>Wraps a caught phase-2 terminal error in the SAME {"error": ...} codeunitResults shape
    /// RunOneMethod already uses for its own fail-closed path. Deliberately not a bare string and not a
    /// testResults array: a client parsing codeunitResults finds zero test lines and must classify it
    /// as a typed error, never as a pass/fail verdict.</summary>
    local procedure BuildRunError(ErrorText: Text): Text
    var
        Obj: JsonObject;
        Out: Text;
    begin
        Obj.Add('error', ErrorText);
        Obj.WriteTo(Out);
        exit(Out);
    end;

    /// <summary>Builds the AcquireLease JSON result. On grant: {granted, epoch, token,
    /// serverGeneration, lastCompletedOpSeq, expiresAt}. On refusal: {granted:false, reason} plus
    /// {holder, expiresAt} for "held"/"operation-busy" or {opAttemptId, opStartedAt} for
    /// "operation-orphaned" (generation-changed carries reason only).</summary>
    local procedure BuildAcquireResult(Granted: Boolean; Epoch: Integer; Token: Text; ServerGeneration: Text; LastCompletedOpSeq: BigInteger; ExpiresAt: DateTime; Reason: Text; Holder: Text; OpAttemptId: Text; OpStartedAt: DateTime): Text
    var
        Obj: JsonObject;
        Out: Text;
    begin
        Obj.Add('granted', Granted);
        if Granted then begin
            Obj.Add('epoch', Epoch);
            Obj.Add('token', Token);
            Obj.Add('serverGeneration', ServerGeneration);
            Obj.Add('lastCompletedOpSeq', LastCompletedOpSeq);
            Obj.Add('expiresAt', ExpiresAt);
        end else begin
            Obj.Add('reason', Reason);
            case Reason of
                'held', 'operation-busy':
                    begin
                        Obj.Add('holder', Holder);
                        Obj.Add('expiresAt', ExpiresAt);
                    end;
                'operation-orphaned':
                    begin
                        Obj.Add('opAttemptId', OpAttemptId);
                        Obj.Add('opStartedAt', OpStartedAt);
                    end;
            end;
        end;
        Obj.WriteTo(Out);
        exit(Out);
    end;

    local procedure BuildStatus(Status: Text; TargetAppId: Text; ArtifactId: Text; AttemptId: Text; MutantId: Text; TestCodeunitId: Integer; TestMethod: Text; CodeunitResults: Text; ObservedAny: Boolean; IdentityMismatch: Boolean): Text
    var
        Obj: JsonObject;
        Out: Text;
    begin
        Obj.Add('status', Status);
        Obj.Add('targetAppId', TargetAppId);
        Obj.Add('artifactId', ArtifactId);
        Obj.Add('attemptId', AttemptId);
        Obj.Add('mutantId', MutantId);
        Obj.Add('codeunitId', TestCodeunitId);
        Obj.Add('method', TestMethod);
        if CodeunitResults <> '' then
            Obj.Add('codeunitResults', CodeunitResults);
        Obj.Add('observedAny', ObservedAny);
        Obj.Add('identityMismatch', IdentityMismatch);
        Obj.WriteTo(Out);
        exit(Out);
    end;
}
