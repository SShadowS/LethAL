// R807: one test that reports the values al-runner draws from its run seed (Random, CreateGuid, a new row's
// SystemId), as the Reader reports state, so leg O1 can compare two separate requests. It always fails by Error().
codeunit 77055 "Order Seed Reader"
{
    Subtype = Test;

    [Test]
    procedure ReadSeedValues()
    var
        R: Record "Order Local Row";
    begin
        R.Id := 1;
        R.Insert();
        Error('SEEDVALUES=%1|%2|%3', Random(1000000), CreateGuid(), R.SystemId);
    end;
}
