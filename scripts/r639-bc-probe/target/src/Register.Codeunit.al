// The control app's RunMutant runs a test only for a target with a registered artifact
// (TryBeginRun refuses 'artifact-mismatch' otherwise). An instrumented target registers on
// install; this probe does the same with a fixed id the driver sends back.
codeunit 92901 "R639 Probe Register"
{
    Subtype = Install;

    trigger OnInstallAppPerCompany()
    var
        State: Codeunit "LC Control State";
    begin
        State.RegisterArtifact('d371a89d-d1c8-4c83-aca5-49261b816c3b', 'd1618dd6c92c4a3982febac2e5339f21');
    end;
}
