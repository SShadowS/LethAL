namespace LethAL.Control;

/// <summary>Re-reconciles the web-service registration on every upgrade, so a version that changed
/// the API object id (or a row that drifted) is corrected rather than left routing to the wrong
/// codeunit.</summary>
codeunit 91005 "LC Control Upgrade"
{
    Subtype = Upgrade;

    trigger OnUpgradePerCompany()
    var
        Install: Codeunit "LC Control Install";
        State: Codeunit "LC Control State";
    begin
        Install.ReconcileWebService();
        State.EnsureLeaseSeeded();
    end;
}
