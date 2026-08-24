codeunit 90250 "Credit Limit Tests"
{
    Subtype = Test;
    // Without this, AL's Restrictive default strips a test body of write permission on its own
    // app's tables, and every test that inserts a customer fails at the platform before it can
    // assert anything. See examples/gift-card-tests for the measurement.
    TestPermissions = Disabled;

    var
        CreditLimitMgt: Codeunit "Credit Limit Mgt";

    [Test]
    procedure OrderUnderLimitIsAllowed()
    var
        CreditOrder: Record "Credit Order";
    begin
        CreateCustomer('C-10000', 1000);

        CreditLimitMgt.RegisterOrder('SO-1001', 'C-10000', 400);

        if not CreditOrder.Get('SO-1001') then
            Error('The order was not registered.');
        if CreditOrder.Amount <> 400 then
            Error('Expected an order of 400, got %1.', CreditOrder.Amount);
    end;

    [Test]
    procedure OrderOverLimitIsBlocked()
    begin
        CreateCustomer('C-10000', 1000);

        asserterror CreditLimitMgt.RegisterOrder('SO-1002', 'C-10000', 1200);
    end;

    [Test]
    procedure NoCreditLimitMeansNoBlock()
    begin
        CreateCustomer('C-10000', 0);

        CreditLimitMgt.RegisterOrder('SO-1003', 'C-10000', 999999);
    end;

    [Test]
    procedure OpenOrdersCountTowardTheLimit()
    begin
        CreateCustomer('C-10000', 1000);

        CreditLimitMgt.RegisterOrder('SO-1004', 'C-10000', 600);

        asserterror CreditLimitMgt.RegisterOrder('SO-1005', 'C-10000', 600);
    end;

    [Test]
    procedure InvoicedOrdersStopCounting()
    var
        CreditOrder: Record "Credit Order";
    begin
        CreateCustomer('C-10000', 1000);

        CreditLimitMgt.RegisterOrder('SO-1006', 'C-10000', 600);
        CreditOrder.Get('SO-1006');
        CreditOrder.Status := CreditOrder.Status::Invoiced;
        CreditOrder.Modify(true);

        CreditLimitMgt.RegisterOrder('SO-1007', 'C-10000', 600);
    end;

    local procedure CreateCustomer(CustomerNo: Code[20]; CreditLimit: Decimal)
    var
        CreditCustomer: Record "Credit Customer";
    begin
        CreditCustomer.Init();
        CreditCustomer."No." := CustomerNo;
        CreditCustomer."Credit Limit" := CreditLimit;
        CreditCustomer.Insert(true);
    end;
}
