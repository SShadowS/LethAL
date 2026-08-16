codeunit 90102 "Gift Card Mgt"
{
    var
        AmountMustBePositiveErr: Label 'A gift card must be issued for a positive amount.';
        CardBlockedErr: Label 'Gift card %1 is blocked.', Comment = '%1 = gift card number';
        CardExpiredErr: Label 'Gift card %1 has expired.', Comment = '%1 = gift card number';
        InsufficientBalanceErr: Label 'Gift card %1 does not have that much left on it.', Comment = '%1 = gift card number';

    procedure Issue(CardNo: Code[20]; CustomerNo: Code[20]; Amount: Decimal; ExpiryDate: Date)
    var
        GiftCard: Record "Gift Card";
    begin
        if Amount <= 0 then
            Error(AmountMustBePositiveErr);

        GiftCard.Init();
        GiftCard."No." := CardNo;
        GiftCard.Validate("Customer No.", CustomerNo);
        GiftCard."Initial Amount" := Amount;
        GiftCard."Remaining Amount" := Amount;
        GiftCard."Expiry Date" := ExpiryDate;
        GiftCard.TestField("Expiry Date");
        GiftCard.Insert(true);

        PostEntry(CardNo, CustomerNo, "Gift Card Entry Type"::Issue, Amount);
    end;

    procedure Redeem(CardNo: Code[20]; Amount: Decimal)
    var
        GiftCard: Record "Gift Card";
    begin
        GiftCard.Get(CardNo);

        if GiftCard.Blocked then
            Error(CardBlockedErr, CardNo);

        if GiftCard."Expiry Date" < WorkDate() then
            Error(CardExpiredErr, CardNo);

        if GiftCard."Remaining Amount" < Amount then
            Error(InsufficientBalanceErr, CardNo);

        GiftCard."Remaining Amount" -= Amount;
        GiftCard.Modify(true);

        PostEntry(CardNo, GiftCard."Customer No.", "Gift Card Entry Type"::Redemption, -Amount);
    end;

    procedure GetBalance(CardNo: Code[20]): Decimal
    var
        GiftCardEntry: Record "Gift Card Entry";
    begin
        GiftCardEntry.SetRange("Gift Card No.", CardNo);
        GiftCardEntry.CalcSums(Amount);
        exit(GiftCardEntry.Amount);
    end;

    procedure BlockExpiredCards()
    var
        GiftCard: Record "Gift Card";
    begin
        GiftCard.SetRange(Blocked, false);
        GiftCard.SetFilter("Expiry Date", '<%1', WorkDate());
        if GiftCard.FindSet() then
            repeat
                GiftCard.Blocked := true;
                GiftCard.Modify(true);
            until GiftCard.Next() = 0;
    end;

    local procedure PostEntry(CardNo: Code[20]; CustomerNo: Code[20]; EntryType: Enum "Gift Card Entry Type"; Amount: Decimal)
    var
        GiftCardEntry: Record "Gift Card Entry";
    begin
        GiftCardEntry.Init();
        GiftCardEntry."Gift Card No." := CardNo;
        GiftCardEntry."Customer No." := CustomerNo;
        GiftCardEntry."Entry Type" := EntryType;
        GiftCardEntry.Amount := Amount;
        GiftCardEntry."Posting Date" := WorkDate();
        GiftCardEntry.Insert(true);
    end;
}
