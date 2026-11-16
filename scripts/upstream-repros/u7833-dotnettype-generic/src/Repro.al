// Invented repro for aldevtools/BusinessCentral.AL.Runner#7833: GetDotNetType of an unassigned DotNet variable of an open generic type.
dotnet
{
    assembly(mscorlib)
    {
        type("System.Collections.Generic.Dictionary`2"; "MyDict") { }
        type("System.Type"; "MyType") { }
    }
}

codeunit 78331 "DN Tests"
{
    Subtype = Test;

    [Test]
    procedure TypeOfUnassignedDictionary() // BC: passes (inferred from the maintainer's probe: the open type definition has a name)
    var
        D: DotNet MyDict;
        T: DotNet MyType;
    begin
        T := GetDotNetType(D);
        if T.Name = '' then
            Error('empty');
    end;
}
