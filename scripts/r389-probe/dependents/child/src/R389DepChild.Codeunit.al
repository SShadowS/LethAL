codeunit 91570 "R389 Dep Child"
{
    // Throwaway. Exists only to depend on the Dependents Probe app.
    procedure Touch(): Integer
    var
        P: Codeunit "R389 Dep Probe";
    begin
        exit(P.DependentCount('00000000-0000-0000-0000-000000000000'));
    end;
}
