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
        ClearAll();
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
        ClearAll();
        asserterror GiftCardMgt.Issue('GC-NOCUST', '', 100, CalcDate('<+1Y>', WorkDate()));
    end;

    [Test]
    procedure IssueRequiresExpiryDate()
    begin
        ClearAll();
        asserterror GiftCardMgt.Issue('GC-NOEXP', 'C10000', 100, 0D);
    end;

    [Test]
    procedure IssueRejectsNegativeAmount()
    begin
        ClearAll();
        asserterror GiftCardMgt.Issue('GC-NEG', 'C10000', -50, CalcDate('<+1Y>', WorkDate()));
    end;

    [Test]
    procedure RedeemReducesBalance()
    var
        GiftCard: Record "Gift Card";
    begin
        ClearAll();
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
        ClearAll();
        GiftCardMgt.Issue('GC-SHORT', 'C10000', 50, CalcDate('<+1Y>', WorkDate()));

        asserterror GiftCardMgt.Redeem('GC-SHORT', 80);
    end;

    [Test]
    procedure RedeemBlockedCardFails()
    var
        GiftCard: Record "Gift Card";
    begin
        ClearAll();
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
        ClearAll();
        GiftCardMgt.Issue('GC-EXPIRED', 'C10000', 100, CalcDate('<+1Y>', WorkDate()));
        GiftCard.Get('GC-EXPIRED');
        GiftCard."Expiry Date" := CalcDate('<-1D>', WorkDate());
        GiftCard.Modify(true);

        asserterror GiftCardMgt.Redeem('GC-EXPIRED', 10);
    end;

    /// <summary>
    /// A clean start for every test, so that what a test measures depends on what that test did and
    /// on nothing else.
    ///
    /// Not decoration. Every balance assertion in this suite reads one card, and one that could see
    /// an earlier test's entries would pass or fail for a reason the test never states. BC test
    /// isolation is MEASURED to roll test writes back under LethAL's fenced runs
    /// (fixtures/sandbox-data-tests, R32 verification, 2026-07-27: four tables held 0 rows after 432
    /// runs), but nothing in this repository measures whether that rollback happens per TEST or per
    /// RUN. A suite that is correct either way costs two lines, and this one is a demo that has to
    /// behave identically in a rehearsal and on a stage.
    /// </summary>
    local procedure ClearAll()
    var
        GiftCard: Record "Gift Card";
        GiftCardEntry: Record "Gift Card Entry";
    begin
        GiftCardEntry.DeleteAll(false);
        GiftCard.DeleteAll(false);
    end;
}
