// The control app's RunMutant runs a test only for a target with a registered artifact
// (TryBeginRun refuses 'artifact-mismatch' otherwise). Copied from R658's probe, new ids.
codeunit 91500 "R826B Probe Register"
{
    Subtype = Install;

    trigger OnInstallAppPerCompany()
    var
        State: Codeunit "LC Control State";
    begin
        State.RegisterArtifact('12b7a3d5-ccbf-4000-b053-c955967ca57d', '3e69467842d34de0a63e6514564ddc57');
    end;
}
