// Invented repro for aldevtools/BusinessCentral.AL.Runner#8084, cause 3: RecordRef.GetTable of a Variant holding an empty Text.
codeunit 80843 "R986 GetTable"
{
    Subtype = Test;

    [Test]
    procedure GetTableOfEmptyText() // BC: fails (a Text is not a record)
    var
        RecRef: RecordRef;
        V: Variant;
    begin
        V := '';
        RecRef.GetTable(V);
    end;
}
