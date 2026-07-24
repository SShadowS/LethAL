namespace LethAL.Control;

using System.TestTools.TestRunner;

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

    /// <summary>
    /// Run-scoped, single-method execution primitive (spec §5). Activate the mutant, run exactly one
    /// named method under Codeunit isolation, ALWAYS clear the active state before returning. No lease
    /// yet — leaseEpoch/leaseToken are reserved and MUST be empty in 5C-A.
    /// </summary>
    procedure RunMutant(TargetAppId: Text; ArtifactId: Text; AttemptId: Text; MutantId: Text; TestCodeunitId: Integer; TestMethod: Text; LeaseEpoch: Text; LeaseToken: Text) ResultJson: Text
    var
        State: Codeunit "LC Control State";
        CodeunitResults: Text;
        ObservedAny: Boolean;
        IdentityMismatch: Boolean;
    begin
        // 1. Reserved-param guard — the lease belongs to 5C-B.
        if (LeaseEpoch <> '') or (LeaseToken <> '') then
            exit(BuildStatus('reserved-params', TargetAppId, ArtifactId, AttemptId, MutantId, TestCodeunitId, TestMethod, '', false, false));

        // 2. Artifact guard (detector; 5C-B makes it a fence). Registry-based — no target dependency.
        if State.RegisteredArtifact(TargetAppId) <> ArtifactId then
            exit(BuildStatus('artifact-mismatch', TargetAppId, ArtifactId, AttemptId, MutantId, TestCodeunitId, TestMethod, '', false, false));

        // 3. Activate (run-scoped). Empty MutantId = baseline (nothing active).
        State.SetActive(TargetAppId, ArtifactId, MutantId);

        // 4-5. Run exactly one method. RunAllTests records test failures in the lines (does not throw),
        //      so control returns here and step 6 always clears. (A catastrophic AL error would escape
        //      to the caller as an OData error -> client classifies in-flight-unknown -> 5B quarantine.)
        CodeunitResults := RunOneMethod(State.NextSuiteName(), TestCodeunitId, TestMethod);
        ObservedAny := State.AttestationObservedAny();
        IdentityMismatch := State.AttestationMismatch();

        // 6. Clear (run-scoped) — the container is left unmutated after every call.
        State.ClearActive();

        exit(BuildStatus('ran', TargetAppId, ArtifactId, AttemptId, MutantId, TestCodeunitId, TestMethod, CodeunitResults, ObservedAny, IdentityMismatch));
    end;

    /// <summary>Build a fresh suite, run EXACTLY the one named method (Run flags, since RunAllTests
    /// resets input filters), return the codeunit's per-method result JSON. Fail closed unless exactly
    /// one method matches.</summary>
    local procedure RunOneMethod(SuiteName: Code[10]; TestCodeunitId: Integer; TestMethod: Text): Text
    var
        ALTestSuite: Record "AL Test Suite";
        Line: Record "Test Method Line";
        CodeunitLine: Record "Test Method Line";
        Mgt: Codeunit "Test Suite Mgt.";
        ErrObj: JsonObject;
        ErrJson: Text;
        MatchCount: Integer;
    begin
        if ALTestSuite.Get(SuiteName) then
            ALTestSuite.Delete(true);
        Mgt.CreateTestSuite(SuiteName);
        ALTestSuite.Get(SuiteName);
        Mgt.SelectTestMethodsByRange(ALTestSuite, Format(TestCodeunitId));

        Line.SetRange("Test Suite", SuiteName);
        Line.SetRange("Line Type", Line."Line Type"::"Function");
        if Line.FindSet() then
            repeat
                Line.Validate(Run, false);
                Line.Modify(true);
            until Line.Next() = 0;

        Line.Reset();
        Line.SetRange("Test Suite", SuiteName);
        Line.SetRange("Line Type", Line."Line Type"::"Function");
        Line.SetRange(Name, TestMethod);
        MatchCount := Line.Count();
        if MatchCount <> 1 then begin
            ErrObj.Add('error', StrSubstNo('expected exactly one method %1, found %2', TestMethod, MatchCount));
            ErrObj.WriteTo(ErrJson);
            exit(ErrJson);
        end;
        Line.FindFirst();
        Line.Validate(Run, true);
        Line.Modify(true);

        Line.Reset();
        Line.SetRange("Test Suite", SuiteName);
        Line.FindFirst();
        Mgt.RunAllTests(Line);

        CodeunitLine.SetRange("Test Suite", SuiteName);
        CodeunitLine.SetRange("Line Type", CodeunitLine."Line Type"::Codeunit);
        CodeunitLine.FindFirst();
        exit(Mgt.TestResultsToJSON(CodeunitLine));
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
