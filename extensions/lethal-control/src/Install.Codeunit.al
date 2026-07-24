namespace LethAL.Control;

using System.Integration;

/// <summary>Registers the control API codeunit as a web service (reachable over OData V4 unbound
/// actions). Reconciles the ACTUAL service-row fields (object id, Published) on every install, so a
/// stale registration pointing at another object is corrected — not merely skipped by name.</summary>
codeunit 71004 "LC Control Install"
{
    Subtype = Install;

    trigger OnInstallAppPerCompany()
    var
        State: Codeunit "LC Control State";
    begin
        ReconcileWebService();
        State.EnsureLeaseSeeded();
    end;

    procedure ReconcileWebService()
    var
        Tws: Record "Tenant Web Service";
        ServiceName: Text[240];
    begin
        ServiceName := 'LethALControl';
        if Tws.Get(Tws."Object Type"::Codeunit, ServiceName) then begin
            // Full-row reconcile: a stale row pointing at a different object is corrected.
            if (Tws."Object ID" <> Codeunit::"LC Control API") or (not Tws.Published) then begin
                Tws."Object ID" := Codeunit::"LC Control API";
                Tws.Published := true;
                Tws.Modify(true);
            end;
            exit;
        end;
        Tws.Init();
        Tws."Object Type" := Tws."Object Type"::Codeunit;
        Tws."Object ID" := Codeunit::"LC Control API";
        Tws."Service Name" := ServiceName;
        Tws.Published := true;
        Tws.Insert(true);
    end;
}
