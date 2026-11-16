// Invented repro for aldevtools/BusinessCentral.AL.Runner#8001, cause 2: KeyRef.FieldCount of a KeyRef that was never assigned.
codeunit 80012 "R962 KeyRef"
{
    Subtype = Test;

    [Test]
    procedure FieldCountOfUnassignedKeyRef()
    var
        K: KeyRef;
        N: Integer;
    begin
        N := K.FieldCount();
    end;
}
