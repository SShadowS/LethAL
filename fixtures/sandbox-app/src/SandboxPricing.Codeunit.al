codeunit 79001 "Sandbox Pricing"
{
    procedure DiscountedPrice(Price: Decimal; Pct: Decimal): Decimal
    begin
        if Pct >= 100 then
            exit(0);
        exit(Price - (Price * Pct / 100));
    end;
}
