// R856. One codeunit per verdict, one file each. A work date set by a test can reach the next test
// of the same codeunit on al-runner v3 and not on BC, so every test that sets a date is alone in
// its codeunit, and the test that sets nothing is in a third. No test compares Today() with a literal.

codeunit 77150 "Dates Kill Workdate Test"
{
    Subtype = Test;

    [Test]
    procedure StampFollowsWorkDate()
    var
        Logic: Codeunit "Dates Logic";
        D: Date;
    begin
        D := 20200315D;
        WorkDate(D);
        if Logic.StampDate() <> D then
            Error('Expected the stamp to be the work date %1, got %2.', D, Logic.StampDate());
    end;
}
