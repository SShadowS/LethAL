// R13: the UNMUTATED side of a `PermissionReduce` pair — the same work, granting exactly what the
// write needs. Paired with `Tier3 Perm Reduced` (grants only `r`) it isolates the property as the
// single variable, which is the only way to tell "the property refused this" from "nothing in this
// fixture can be refused".
codeunit 79224 "Tier3 Perm Grant"
{
    Permissions = tabledata 79201 = rimd;

    procedure InsertRow(No: Code[20])
    var
        Probe: Record "Rec XRec Probe";
    begin
        Probe.Init();
        Probe."No." := No;
        Probe.Amount := 1;
        Probe.Insert(false);
    end;
}
