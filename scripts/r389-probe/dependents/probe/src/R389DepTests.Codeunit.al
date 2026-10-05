codeunit 91561 "R389 Dep Tests"
{
    Subtype = Test;

    // Everything is reported in the failure text, marker R389DEP.
    [Test]
    procedure MeasureAll()
    var
        Probe: Codeunit "R389 Dep Probe";
        Ids: List of [Text];
        Id: Text;
        Out: TextBuilder;
        Access: Record "Access Control";
    begin
        Out.AppendLine('R389DEP');
        Out.AppendLine('user=' + UserId());
        Access.SetRange("User Security ID", UserSecurityId());
        if Access.FindSet() then
            repeat
                Out.AppendLine('permset=' + Access."Role ID" + ' scope=' + Format(Access.Scope) + ' company=' + Access."Company Name");
            until Access.Next() = 0;
        Ids.Add('5e7a3c91-0b42-4d6e-a8f1-389e0a1b3d01'); // P
        Ids.Add('5e7a3c91-0b42-4d6e-a8f1-389e0a1b3d02'); // C
        Ids.Add('5e7a3c91-0b42-4d6e-a8f1-389e0a1b2c01'); // 2026-10-04 External
        Ids.Add('63ca2fa4-4f03-4f2b-a480-172fef340d3f'); // System Application
        foreach Id in Ids do begin
            Measure(Out, Probe, Id, false);
            Measure(Out, Probe, Id, true);
        end;
        Error(Out.ToText());
    end;

    local procedure Measure(var Out: TextBuilder; var Probe: Codeunit "R389 Dep Probe"; Id: Text; NoKey: Boolean)
    var
        T: DateTime;
        I: Integer;
        N: Integer;
        Vals: array[5] of Integer;
        J: Integer;
        Tmp: Integer;
    begin
        for I := 1 to 5 do begin
            T := CurrentDateTime();
            if NoKey then
                N := Probe.DependentCountNoKey(Id)
            else
                N := Probe.DependentCount(Id);
            Vals[I] := CurrentDateTime() - T;
        end;
        for I := 1 to 4 do
            for J := I + 1 to 5 do
                if Vals[J] < Vals[I] then begin
                    Tmp := Vals[I];
                    Vals[I] := Vals[J];
                    Vals[J] := Tmp;
                end;
        Out.AppendLine('id=' + Id + ' variant=' + Format(NoKey) + ' count=' + Format(N) + ' medianMs=' + Format(Vals[3]) + ' minMs=' + Format(Vals[1]) + ' maxMs=' + Format(Vals[5]));
    end;
}
