codeunit 90204 "Credit Limit Mgt"
{
    var
        OverLimitErr: Label 'An order of %1 would take customer %2 over their credit limit.', Comment = '%1 = order amount, %2 = customer number';

    procedure RegisterOrder(OrderNo: Code[20]; CustomerNo: Code[20]; Amount: Decimal)
    var
        CreditOrder: Record "Credit Order";
    begin
        CheckCreditLimit(CustomerNo, Amount);

        CreditOrder.Init();
        CreditOrder."No." := OrderNo;
        CreditOrder."Customer No." := CustomerNo;
        CreditOrder.Amount := Amount;
        CreditOrder.Status := CreditOrder.Status::Open;
        CreditOrder.Insert(true);
    end;

    procedure CheckCreditLimit(CustomerNo: Code[20]; NewOrderAmount: Decimal)
    begin
        if WouldExceedLimit(CustomerNo, NewOrderAmount) then
            Error(OverLimitErr, NewOrderAmount, CustomerNo);
    end;

    procedure WouldExceedLimit(CustomerNo: Code[20]; NewOrderAmount: Decimal): Boolean
    var
        CreditCustomer: Record "Credit Customer";
        Exposure: Decimal;
    begin
        CreditCustomer.Get(CustomerNo);

        if CreditCustomer."Credit Limit" = 0 then
            exit(false);

        CreditCustomer.CalcFields(Balance);
        Exposure := CreditCustomer.Balance + OutstandingOrderAmount(CustomerNo) + NewOrderAmount;

        exit(Exposure > CreditCustomer."Credit Limit");
    end;

    procedure PostInvoice(CustomerNo: Code[20]; Amount: Decimal)
    begin
        PostEntry(CustomerNo, Amount);
    end;

    procedure PostPayment(CustomerNo: Code[20]; Amount: Decimal)
    begin
        PostEntry(CustomerNo, -Amount);
    end;

    local procedure OutstandingOrderAmount(CustomerNo: Code[20]): Decimal
    var
        CreditOrder: Record "Credit Order";
    begin
        CreditOrder.SetRange("Customer No.", CustomerNo);
        CreditOrder.SetRange(Status, CreditOrder.Status::Open);
        CreditOrder.CalcSums(Amount);
        exit(CreditOrder.Amount);
    end;

    local procedure PostEntry(CustomerNo: Code[20]; Amount: Decimal)
    var
        CreditLedgerEntry: Record "Credit Ledger Entry";
    begin
        CreditLedgerEntry.Init();
        CreditLedgerEntry."Customer No." := CustomerNo;
        CreditLedgerEntry.Amount := Amount;
        CreditLedgerEntry."Posting Date" := WorkDate();
        CreditLedgerEntry.Insert(true);
    end;
}
