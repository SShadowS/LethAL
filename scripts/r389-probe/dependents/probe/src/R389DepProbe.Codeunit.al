codeunit 91560 "R389 Dep Probe"
{
    // Throwaway. Counts published packages that declare AppId as a dependency.
    procedure DependentCount(AppId: Text): Integer
    var
        Dep: Record "Application Dependency";
        Id: Guid;
    begin
        Evaluate(Id, AppId);
        Dep.SetRange("Dependency App ID", Id);
        exit(Dep.Count());
    end;

    // Same count with the table's primary key left at its default (no SetCurrentKey call).
    procedure DependentCountNoKey(AppId: Text): Integer
    var
        Dep: Record "Application Dependency";
        Id: Guid;
    begin
        Evaluate(Id, AppId);
        Dep.SetFilter("Dependency App ID", '%1', Id);
        exit(Dep.Count());
    end;
}
