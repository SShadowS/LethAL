codeunit 79000 "Sandbox Logic"
{
    procedure IsOverBudget(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount > Budget);                          // ConditionalBoundary + ReturnValue
    end;

    procedure ClampPercent(Value: Integer): Integer
    begin
        if (Value < 0) or (Value > 100) then            // NegateConditional + boundary
            exit(0);
        exit(Value);
    end;

    procedure ApplyAudit(Amount: Decimal)
    begin
        LogAudit(Amount);                               // VoidMethodCall
    end;

    local procedure LogAudit(Amount: Decimal)
    begin
        if Amount <> 0 then begin                       // EmptyBlock target
            Amount := Amount;
        end;
    end;
}
