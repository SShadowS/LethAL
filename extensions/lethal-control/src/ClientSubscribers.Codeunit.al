namespace LethAL.Control;

using System.TestTools.TestRunner;

/// <summary>1.0.0.31 (PR-478, B3): the two per-method subscribers on Test Runner - Mgt. BOTH are GATED: they act
/// only when this session is the BOUND session of the in-flight `client-run` op ("LC Control State".
/// IsBoundClientSession). A headless run (RunMutant, RunMutantMany) is never that session, so it writes no row
/// and keeps its latched identity mismatch.
///
/// OnBeforeTestMethodRun resets the observations ONLY (never ResetSinceLoad). OnAfterTestMethodRun writes the
/// attestation row; it reads nothing from the tuple table, it attests what the session loaded. No Commit here:
/// the runner commits after the method.</summary>
codeunit 91016 "LC Client Subscribers"
{
    InherentPermissions = X;

    [EventSubscriber(ObjectType::Codeunit, Codeunit::"Test Runner - Mgt", OnBeforeTestMethodRun, '', false, false)]
    local procedure ResetObservationsBeforeMethod(var CurrentTestMethodLine: Record "Test Method Line"; CodeunitID: Integer; CodeunitName: Text[30]; FunctionName: Text[128]; FunctionTestPermissions: TestPermissions)
    var
        State: Codeunit "LC Control State";
    begin
        if not State.IsBoundClientSession() then
            exit;
        // The third place a test method is counted (the R206 session-freshness counter), GATED: a client session's
        // attestation row then reads 1..N. Headless sites are in LC Run Method and LC Run Many.
        State.NoteTestMethodRun();
        State.ResetObservations();
    end;

    [EventSubscriber(ObjectType::Codeunit, Codeunit::"Test Runner - Mgt", OnAfterTestMethodRun, '', false, false)]
    local procedure WriteAttestationAfterMethod(var CurrentTestMethodLine: Record "Test Method Line"; CodeunitID: Integer; CodeunitName: Text[30]; FunctionName: Text[128]; FunctionTestPermissions: TestPermissions; IsSuccess: Boolean)
    var
        State: Codeunit "LC Control State";
    begin
        if not State.IsBoundClientSession() then
            exit;
        State.WriteClientAttestation(CodeunitID, FunctionName, IsSuccess);
    end;
}
