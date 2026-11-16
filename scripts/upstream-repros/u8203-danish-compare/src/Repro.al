// Invented repro: comparing Text and Code holding æ, ø, Æ; measured on BC 28.4 W1, en-US (PR-87).
codeunit 58380 "Danish Compare Test"
{
    Subtype = Test;

    [Test]
    procedure LowerAeBeforeCapital()
    var
        X: Text;
        Y: Text;
    begin
        X := 'æ';
        Y := 'Æ';
        if not (X < Y) then
            Error('BC: æ < Æ is true');
    end;

    [Test]
    procedure AeBeforeZ()
    var
        X: Text;
        Y: Text;
    begin
        X := 'z';
        Y := 'æ';
        if X < Y then
            Error('BC: z < æ is false');
    end;

    [Test]
    procedure OSlashAfterARing()
    var
        X: Text;
        Y: Text;
    begin
        X := 'ø';
        Y := 'å';
        if X < Y then
            Error('BC: ø < å is false');
    end;

    [Test]
    procedure CodeAeBeforeTextZ()
    var
        Cd: Code[10];
        Tx: Text;
    begin
        Cd := 'æ';
        Tx := 'z';
        if not (Cd < Tx) then
            Error('BC: Code Æ < Text z is true');
    end;
}
