// `toggle-blank-temporal`'s arm (R159, admitted under R013's amended bar).
//
// This arm exists because the operator claims ZERO sites on every fixture and example this repo
// owns -- measured: sandbox-data 0, sandbox-app 0, sandbox-hang 0, gift-card 0, credit-limit 0. That
// is R171's situation, and a change no live gate exercises is R56's shape: a docs-only commit once
// deleted a procedure body and `itest:tables` stayed green for days.
//
// The five procedures are a CONTROL SET, not five sites of the same thing:
//
//   IsDueDateSet     `= 0D`  in a comparison -- the MAJORITY shape. 77 of the 81 claimable literals
//                            on do-rel2/Cloud are already blank, so blank-to-non-blank is what this
//                            operator mostly does. `0D` is AL's blank date and this is the idiomatic
//                            BC "is it set" check.
//   StampFixedDate   `:= 20240402D` -- the MINORITY direction, non-blank to blank, 4 of 81. Without
//                            it the arm would only prove one half of a toggle.
//   IsTimestampSet   `= 0DT` -- the DateTime arm, whose replacement is a CALL
//                            (`CREATEDATETIME(...)`) and not a literal, because AL has no non-blank
//                            DateTime literal. It is the only arm whose mutant text is longer than
//                            its original, so it is the one that proves the instrumented artifact
//                            still compiles. The offline `alc` probe proved the expression legal;
//                            this proves it legal after the schemata compiler has wrapped it.
//   IsCutoffSet      `= 0T`  -- the Time arm, so all three temporal types are exercised rather than
//                            two plus an assumption.
//   PassThrough      `Consume(0D)` -- the REFUSAL CONTROL. A temporal literal in an argument list,
//                            which the operator must NOT claim, because a literal's meaning there
//                            depends on a callee this layer cannot resolve. Without it, "the
//                            operator claims temporal literals" would be satisfied by an over-broad
//                            operator claiming every temporal literal anywhere, which is the version
//                            of this operator that would quietly mutate `Consume`'s argument and
//                            report it as a date-is-set finding.
codeunit 79333 "Data Temporal Ops"
{
    // MAJORITY shape: blank date in a comparison operand.
    procedure IsDueDateSet(DueDate: Date): Integer
    begin
        if DueDate = 0D then
            exit(0);
        exit(1);
    end;

    // MINORITY direction: a non-blank date assigned, which the toggle blanks.
    procedure StampFixedDate(): Date
    var
        Stamped: Date;
    begin
        Stamped := 20240402D;
        exit(Stamped);
    end;

    // The DateTime arm. Its mutant replaces `0DT` with a CALL.
    procedure IsTimestampSet(Stamp: DateTime): Integer
    begin
        if Stamp = 0DT then
            exit(0);
        exit(1);
    end;

    // The Time arm.
    procedure IsCutoffSet(Cutoff: Time): Integer
    begin
        if Cutoff = 0T then
            exit(0);
        exit(1);
    end;

    // REFUSAL CONTROL: the literal sits in an argument list and must not be claimed.
    procedure PassThrough(): Integer
    begin
        exit(Consume(0D));
    end;

    procedure Consume(Ignored: Date): Integer
    begin
        exit(7);
    end;
}
