// Invented repro for aldevtools/BusinessCentral.AL.Runner#7827: a second Query.Open() on an open, read query with no filter change between.
table 78270 "R782 Row"
{
    fields
    {
        field(1; Id; Integer) { }
        field(2; Amount; Integer) { }
    }
    keys
    {
        key(PK; Id) { Clustered = true; }
    }
}

query 78270 "R782 Sum"
{
    QueryType = Normal;
    elements
    {
        dataitem(Row; "R782 Row")
        {
            filter(IdFilter; Id) { }
            column(Id; Id) { }
            column(Total; Amount) { Method = Sum; }
        }
    }
}

codeunit 78271 "R782 Tests"
{
    Subtype = Test;

    local procedure Seed()
    var
        R: Record "R782 Row";
    begin
        R.DeleteAll();
        R.Id := 1; R.Amount := 10; R.Insert();
        R.Id := 2; R.Amount := 20; R.Insert();
    end;

    [Test]
    procedure ReopenAfterSetFilter()
    var
        Q: Query "R782 Sum";
    begin
        Seed();
        Q.SetFilter(IdFilter, '1');
        if not Q.Open() then Error('open 1');
        if not Q.Read() then Error('read 1');
        Q.SetFilter(IdFilter, '2');
        if not Q.Open() then Error('open 2');
        if not Q.Read() then Error('read 2');
        if Q.Total <> 20 then Error('total %1', Q.Total);
    end;

    [Test]
    procedure ReopenWithoutSetFilter()
    var
        Q: Query "R782 Sum";
    begin
        Seed();
        Q.SetFilter(IdFilter, '1');
        if not Q.Open() then Error('open 1');
        if not Q.Read() then Error('read 1');
        if not Q.Open() then Error('open 2');
        if not Q.Read() then Error('read 2');
    end;
}
