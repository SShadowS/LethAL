// R13: the third arm — an object carrying NO `Permissions` property at all, which is what the
// overwhelming majority of AL objects look like. It bounds the other two: if this one behaves
// identically to both the reduced and the granting object, the property is inert on this path and
// `PermissionReduce` has nothing to mutate that BC reads.
codeunit 79227 "Tier3 Perm None"
{
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
