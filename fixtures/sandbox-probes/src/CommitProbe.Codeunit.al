// R73: does a COMMITTED write survive a later uncaught error, under the platform test runner's
// isolation?
//
// This is `RemoveCommit`'s actual kill mechanism, and R33 left it unmeasured. The honest fixture
// shape R73 asks for is a transaction-boundary test — write, `Commit`, raise, then assert the write
// survived — and that test is only meaningful if the platform behaves as assumed. If the isolation
// runner rolls back even committed writes, the test fails UNMUTATED, the fixture is unbuildable in
// that shape, and building it first would have produced a red baseline blamed on the wrong thing.
//
// Measure before building. Same rule that turned R72's stated hazard into a non-issue.
codeunit 79221 "Commit Probe"
{
    Subtype = Test;
    // R1: the Permissions Mock refuses writes from a Restrictive test codeunit on every runner.
    TestPermissions = Disabled;

    [Test]
    procedure CommittedWriteSurvivesLaterError()
    var
        Marker: Record "Sandbox Probe Marker";
        Survived: Boolean;
    begin
        // Start clean and DURABLY. A row left behind by an earlier run would answer `survived` for
        // the wrong reason — the empty-vs-empty shape this project treats as its signature bug,
        // pointed the other way.
        if Marker.Get(79221) then begin
            Marker.Delete(false);
            Commit();
        end;

        // The mutation's target shape: write, Commit, then an uncaught error. `asserterror` catches
        // it here so the probe can report; in a real suite the raise is the thing under test.
        asserterror CommitThenFail();

        Survived := Marker.Get(79221);
        Error('MEASURED committedWriteSurvived=%1', Survived);
    end;

    [Test]
    procedure UncommittedWriteIsRolledBack()
    var
        Marker: Record "Sandbox Probe Marker";
        Survived: Boolean;
    begin
        // The CONTROL, and the whole reason the test above means anything: the identical sequence
        // with the `Commit()` removed is exactly what a `remove-commit` mutant produces. If this
        // also reports survived=Yes, then `Commit` is not what makes the row durable here and no
        // assertion on row survival can kill that mutant.
        if Marker.Get(79222) then begin
            Marker.Delete(false);
            Commit();
        end;

        asserterror WriteThenFail();

        Survived := Marker.Get(79222);
        Error('MEASURED uncommittedWriteSurvived=%1', Survived);
    end;

    local procedure CommitThenFail()
    var
        Marker: Record "Sandbox Probe Marker";
    begin
        Marker.Init();
        Marker."Entry No." := 79221;
        if not Marker.Insert(false) then;
        Commit();
        Error('deliberate failure AFTER commit');
    end;

    local procedure WriteThenFail()
    var
        Marker: Record "Sandbox Probe Marker";
    begin
        Marker.Init();
        Marker."Entry No." := 79222;
        if not Marker.Insert(false) then;
        Error('deliberate failure with NO commit');
    end;
}
