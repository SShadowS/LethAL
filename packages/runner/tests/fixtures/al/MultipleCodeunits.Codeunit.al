codeunit 79210 "First Suite"
{
    Subtype = Test;

    [Test]
    procedure FirstTest()
    begin
    end;
}

codeunit 79211 "Second Suite"
{
    Subtype = Test;

    [Test]
    procedure SecondTest()
    begin
    end;
}

codeunit 79212 "Third Suite"
{
    // No Subtype = Test, should not contribute any tests

    [Test]
    procedure ThirdTest()
    begin
    end;
}
