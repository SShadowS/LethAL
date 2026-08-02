// R13 arm A1's target: the shape a `PermissionReduce` mutant would emit.
//
// `Permissions = tabledata 79201 = r` grants READ on the table this codeunit then INSERTS into —
// a maximally reduced set relative to what the write needs. Whether that refuses the insert is
// the whole question: BC's permission model is documented as a UNION of the user's rights and the
// executing object's granted rights, in which case an object property can only ever ADD, never
// subtract, and no `PermissionReduce` mutant can be killed. Documented is not measured.
codeunit 79223 "Tier3 Perm Reduced"
{
    Permissions = tabledata 79201 = r;

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
