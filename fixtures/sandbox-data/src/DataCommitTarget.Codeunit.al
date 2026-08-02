// R72's callee. Trivial on purpose: the site under test is the `Commit()` that PRECEDES the
// `Codeunit.Run`, so this codeunit must do nothing that could fail on its own and be mistaken for
// the platform's write-transaction refusal.
//
// It keys on a fixture constant rather than taking state from the caller, because `Codeunit.Run`
// constructs a FRESH instance — anything set on a caller-side variable would not arrive, and a
// target that silently did nothing would make "the call succeeded" and "the call never happened"
// indistinguishable.
codeunit 79313 "Data Commit Target"
{
    trigger OnRun()
    var
        DataMain: Record "Data Main";
    begin
        if not DataMain.Get(CommitRunNoLbl) then
            exit;
        DataMain.Flagged := true;
        DataMain.Modify(false);
    end;

    procedure CommitRunNo(): Code[20]
    begin
        exit(CommitRunNoLbl);
    end;

    var
        CommitRunNoLbl: Label 'T-CMTRUN', Locked = true;
}
