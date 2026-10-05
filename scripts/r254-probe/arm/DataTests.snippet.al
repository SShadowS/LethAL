// R254 arm (DRAFT r3): two [Test] procedures to add to codeunit 79310 "Data Tests"
// (fixtures/sandbox-data-tests/src/DataTests.Codeunit.al). Bare Error(...) like the rest of it.

    [Test]
    procedure BandClassifiesDirectly()
    var
        Rep: Report "Data Band Report";
    begin
        // Reaches the extension's Band procedure through the base report's variable, no report run.
        if Rep.Band(3) <> 2 then
            Error('Band(3) should be 2, got %1', Rep.Band(3));
        if Rep.Band(2) <> 1 then
            Error('Band(2) should be 1, got %1', Rep.Band(2));
    end;

    [Test]
    procedure BandReportSumsBands()
    var
        Rep: Report "Data Band Report";
    begin
        // Runs the report over four seeded 'BAND' rows (Entry No. 1..4): the modify(BandItem)
        // trigger adds Band(1..4) = 1+1+2+2 = 6. The seed rolls back after the test (R32).
        // MEASURED (probe, al-runner and BC) that the report variable keeps the extension's
        // globals after RunModal, and that RunModal after an uncommitted write works fenced.
        ClearRelated('BAND');
        AddRelated(1, 'BAND', 0);
        AddRelated(2, 'BAND', 0);
        AddRelated(3, 'BAND', 0);
        AddRelated(4, 'BAND', 0);
        Rep.UseRequestPage(false);
        Rep.RunModal();
        if Rep.GetTotal() <> 6 then
            Error('band total should be 6, got %1', Rep.GetTotal());
    end;
