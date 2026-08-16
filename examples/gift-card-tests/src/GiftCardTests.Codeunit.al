codeunit 90150 "Gift Card Tests"
{
    Subtype = Test;

    var
        GiftCardMgt: Codeunit "Gift Card Mgt";

    [Test]
    procedure IssueCreatesCard()
    var
        GiftCard: Record "Gift Card";
    begin
        GiftCardMgt.Issue('GC-CREATE', 'C10000', 100, CalcDate('<+1Y>', WorkDate()));

        if not GiftCard.Get('GC-CREATE') then
            Error('Issue did not create the gift card.');
        if GiftCard."Remaining Amount" <> 100 then
            Error('Expected 100 remaining, got %1.', GiftCard."Remaining Amount");
        if GiftCard."Issued Date" <> WorkDate() then
            Error('Expected the issued date to be stamped, got %1.', GiftCard."Issued Date");
    end;

    [Test]
    procedure IssueRequiresCustomer()
    begin
        asserterror GiftCardMgt.Issue('GC-NOCUST', '', 100, CalcDate('<+1Y>', WorkDate()));
    end;

    [Test]
    procedure IssueRequiresExpiryDate()
    begin
        asserterror GiftCardMgt.Issue('GC-NOEXP', 'C10000', 100, 0D);
    end;

    [Test]
    procedure IssueRejectsNegativeAmount()
    begin
        asserterror GiftCardMgt.Issue('GC-NEG', 'C10000', -50, CalcDate('<+1Y>', WorkDate()));
    end;

    [Test]
    procedure RedeemReducesBalance()
    var
        GiftCard: Record "Gift Card";
    begin
        GiftCardMgt.Issue('GC-REDEEM', 'C10000', 100, CalcDate('<+1Y>', WorkDate()));

        GiftCardMgt.Redeem('GC-REDEEM', 40);

        GiftCard.Get('GC-REDEEM');
        if GiftCard."Remaining Amount" <> 60 then
            Error('Expected 60 remaining on the card, got %1.', GiftCard."Remaining Amount");
        if GiftCardMgt.GetBalance('GC-REDEEM') <> 60 then
            Error('Expected a balance of 60, got %1.', GiftCardMgt.GetBalance('GC-REDEEM'));
    end;

    [Test]
    procedure RedeemMoreThanBalanceFails()
    begin
        GiftCardMgt.Issue('GC-SHORT', 'C10000', 50, CalcDate('<+1Y>', WorkDate()));

        asserterror GiftCardMgt.Redeem('GC-SHORT', 80);
    end;

    [Test]
    procedure RedeemBlockedCardFails()
    var
        GiftCard: Record "Gift Card";
    begin
        GiftCardMgt.Issue('GC-BLOCK', 'C10000', 100, CalcDate('<+1Y>', WorkDate()));
        GiftCard.Get('GC-BLOCK');
        GiftCard.Blocked := true;
        GiftCard.Modify(true);

        asserterror GiftCardMgt.Redeem('GC-BLOCK', 10);
    end;

    [Test]
    procedure RedeemExpiredCardFails()
    var
        GiftCard: Record "Gift Card";
    begin
        GiftCardMgt.Issue('GC-EXPIRED', 'C10000', 100, CalcDate('<+1Y>', WorkDate()));
        GiftCard.Get('GC-EXPIRED');
        GiftCard."Expiry Date" := CalcDate('<-1D>', WorkDate());
        GiftCard.Modify(true);

        asserterror GiftCardMgt.Redeem('GC-EXPIRED', 10);
    end;
}
