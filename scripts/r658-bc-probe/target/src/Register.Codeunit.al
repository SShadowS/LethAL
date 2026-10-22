// The control app's RunMutant runs a test only for a target with a registered artifact
// (TryBeginRun refuses 'artifact-mismatch' otherwise). Copied from R649's probe, new ids.
codeunit 92940 "R658 Probe Register"
{
    Subtype = Install;

    trigger OnInstallAppPerCompany()
    var
        State: Codeunit "LC Control State";
    begin
        State.RegisterArtifact('d1d2d26c-a3b4-4a26-804f-903c1f1497f8', '46f0516107e9ecda24671e5c5ddbabd0');
    end;
}
