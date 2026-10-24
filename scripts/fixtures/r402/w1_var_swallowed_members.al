codeunit 79600 "R402 Shape"
{
    var
        Total: Integer;
        Name: Text;

#if not LETHALX
    procedure Add(Amount: Integer): Integer
    var
        Tmp: Integer;
    begin
        Tmp := Amount;
        Total := Total + Tmp;
        Touch();
        exit(Total);
    end;

    procedure Tag(Value: Text): Text
    begin
        Name := Value;
        Touch();
        exit(Name + '!');
    end;
#endif

    procedure Add2(Amount: Integer): Integer
    begin
        Total := Total + Amount;
        exit(Total);
    end;

    local procedure Touch()
    begin
        Total := Total + 1;
    end;
}
