codeunit 77200 "Optin Logic"
{
    // R868: the sites of the opt-in operators lethal.condition-true (#36) and lethal.blank-argument
    // (#34). Run with `--operator condition-true,blank-argument`. No gate uses this fixture.
    //
    // CLAIMED (four sites, and only these):
    //   KilledGuard     `Amount > 0` -> true     killed: a test drives Amount below zero.
    //   SurvivingGuard  `Amount > 0` -> true     survives: the tests only ever pass a positive Amount.
    //   Welcome         `User` -> ''             killed: a test asserts the greeting names the user.
    //   Remember        `Note` -> ''             survives: the tests count notes, never read one back.
    //
    // REFUSED, every other `if` and every other call argument below. A refused site produces no
    // mutant, so it can sit here without a hang-capable mutant reaching a server (R164). The
    // refusals are unit-tested in packages/builtin-tier1/tests/r868-optin-hang.test.ts. None of
    // the refused procedures is called by a test: some of them would not end if their guard were
    // forced.
    //   condition-true: a then-arm that holds a loop, writes a name the loop's exit reads, calls a
    //     helper that resets it, restarts or steps back the exit's cursor, or calls back into its
    //     own procedure; a `continue`; a cursor step in the condition.
    //   blank-argument: a parameter (or a copy, or a global it is stored in, or a procedure it is
    //     handed to) that a loop reads; caller progress; the depth argument of a recursion.

    var
        Held: Integer;
        Counter: Integer;
        LastNote: Text;
        NoteCount: Integer;

    // ---- claimed: condition-true ----

    procedure KilledGuard(Amount: Integer): Integer
    var
        Result: Integer;
    begin
        if Amount > 0 then
            Result := Amount * 2;
        exit(Result);
    end;

    procedure SurvivingGuard(Amount: Integer): Integer
    var
        Result: Integer;
    begin
        if Amount > 0 then
            Result := Amount * 2;
        exit(Result);
    end;

    // ---- claimed: blank-argument ----

    procedure Welcome(User: Text): Text
    begin
        exit(Greet(User));
    end;

    local procedure Greet(Name: Text): Text
    begin
        exit('Hello ' + Name);
    end;

    procedure Remember(Note: Text)
    begin
        Store(Note);
    end;

    local procedure Store(Value: Text)
    begin
        LastNote := Value;
        NoteCount += 1;
    end;

    procedure Remembered(): Integer
    begin
        exit(NoteCount);
    end;

    // ---- refused: condition-true ----

    procedure RefusedArmLoop(Step: Integer; N: Integer): Integer
    var
        I: Integer;
    begin
        if Step > 0 then
            while I < N do
                I += Step;
        exit(I);
    end;

    procedure RefusedLocalWrite(N: Integer): Integer
    var
        I: Integer;
    begin
        while I < N do begin
            if I > 5 then
                I -= 1;
            I += 2;
        end;
        exit(I);
    end;

    procedure RefusedFlag(N: Integer): Integer
    var
        I: Integer;
        Go: Boolean;
    begin
        Go := true;
        while Go do begin
            I += 1;
            if I >= N then
                Go := false;
        end;
        exit(I);
    end;

    procedure RefusedHelperReset(N: Integer): Integer
    var
        I: Integer;
    begin
        Counter := 0;
        while Counter < N do begin
            if I > 100 then
                ResetCounter();
            I += 1;
            Counter += 1;
        end;
        exit(Counter);
    end;

    local procedure ResetCounter()
    begin
        Counter := 0;
    end;

    procedure RefusedRestart(var Row: Record "Optin Row" temporary; Restart: Boolean)
    begin
        Row.FindSet();
        repeat
            if Restart then
                Row.FindFirst();
        until Row.Next() = 0;
    end;

    procedure RefusedBack(var Row: Record "Optin Row" temporary; Back: Boolean)
    begin
        Row.FindSet();
        repeat
            if Back then
                Row.Next(-1);
        until Row.Next() = 0;
    end;

    procedure RefusedStepInCondition(var Row: Record "Optin Row" temporary; N: Integer): Integer
    begin
        while Counter < N do begin
            if Row.Next() = 0 then
                Counter += 1;
            Counter += 1;
        end;
        exit(Counter);
    end;

    procedure RefusedContinue(N: Integer): Integer
    var
        I: Integer;
        Total: Integer;
    begin
        while I < N do begin
            I += 1;
            if I = 2 then
                continue;
            Total += I;
        end;
        exit(Total);
    end;

    procedure RefusedSelfCall(Level: Integer)
    begin
        if Level > 0 then
            RefusedSelfCall(Level - 1);
    end;

    procedure RefusedPing(Level: Integer)
    begin
        if Level > 0 then
            RefusedPong(Level - 1);
    end;

    procedure RefusedPong(Level: Integer)
    begin
        RefusedPing(Level);
    end;

    // ---- refused: blank-argument ----

    procedure CallSpin(Step: Integer)
    begin
        SpinCopy(Step);
    end;

    local procedure SpinCopy(Step: Integer)
    var
        I: Integer;
        Len: Integer;
    begin
        Len := Step;
        while I < 10 do
            I += Len;
    end;

    procedure ConfigureHeld(Step: Integer)
    begin
        SetHeld(Step);
    end;

    local procedure SetHeld(Step: Integer)
    begin
        Held := Step;
    end;

    procedure SpinHeld()
    var
        I: Integer;
    begin
        while I < 10 do
            I += Held;
    end;

    procedure UseDelta(Delta: Integer)
    begin
        OuterDelta(Delta);
    end;

    local procedure OuterDelta(Gap: Integer)
    begin
        InnerSpin(Gap);
    end;

    local procedure InnerSpin(Jump: Integer)
    var
        I: Integer;
    begin
        while I < 10 do
            I += Jump;
    end;

    procedure DrainAll(): Integer
    var
        Remaining: Integer;
    begin
        Remaining := 5;
        while Remaining > 0 do
            Remaining := Consume(Remaining);
        exit(Remaining);
    end;

    local procedure Consume(Left: Integer): Integer
    begin
        exit(Left - 1);
    end;

    procedure Depth(Level: Integer)
    var
        Next: Integer;
    begin
        Next := Level + 1;
        if Level < 3 then
            Depth(Next);
    end;

    procedure PingB(Level: Integer)
    var
        Next: Integer;
    begin
        Next := Level + 1;
        if Level < 3 then
            PongB(Next);
    end;

    procedure PongB(Level: Integer)
    var
        Same: Integer;
    begin
        Same := Level;
        PingB(Same);
    end;
}
