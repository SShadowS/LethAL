codeunit 79690 "R534 OnRun Tests"
{
    Subtype = Test;

    trigger OnRun()
    var
        Logic: Codeunit "R534 Count Logic";
    begin
        Logic.CountTo(10);
    end;

    [Test]
    procedure CountsToThree()
    var
        Logic: Codeunit "R534 Count Logic";
    begin
        if Logic.CountTo(3) <> 3 then
            Error('CountTo(3) should be 3');
    end;
}

codeunit 79691 "R534 Scope Tests"
{
    Subtype = Test;

    [Test]
    procedure NoTaskAsked()
    var
        Logic: Codeunit "R534 Scope Logic";
    begin
        if not Logic.MaybeTask(false) then
            Error('MaybeTask(false) should be true');
    end;
}

codeunit 79692 "R534 Ask Tests"
{
    Subtype = Test;

    [Test]
    [HandlerFunctions('ConfirmYes')]
    procedure AsksOnce()
    var
        Logic: Codeunit "R534 Ask Logic";
    begin
        Logic.AskUser(true);
    end;

    [ConfirmHandler]
    procedure ConfirmYes(Question: Text[1024]; var Reply: Boolean)
    begin
        Reply := true;
    end;
}
