// The control app's RunMutant runs a test only for a target with a registered artifact
// (TryBeginRun refuses 'artifact-mismatch' otherwise). Copied from R639's probe, new ids.
codeunit 92920 "R649 Probe Register"
{
    Subtype = Install;

    trigger OnInstallAppPerCompany()
    var
        State: Codeunit "LC Control State";
    begin
        State.RegisterArtifact('7937c2a9-5c42-4e98-bd9b-9de8151b55fe', '588155e99f794541ac96f1d42821b803');
    end;
}
