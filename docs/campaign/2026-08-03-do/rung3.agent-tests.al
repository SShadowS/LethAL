codeunit 68964 "CDO Aut Statement Feat. Tests"
{
    Subtype = Test;
    TestPermissions = Disabled;

    // Covers "CDO Send Cust. Statement Mgt." on the AUTSTATEMENT feature path
    // (CreateOrSendAutStatements and everything it calls), which the rest of the
    // suite never reaches, plus the behaviour of the record filters on the
    // directly callable procedures of the same codeunit.
    //
    // CreateOrSendAutStatements and SendPeriodStatements commit inside their loop,
    // so most tests here cannot use AutoRollback. Setup data therefore uses a fixed
    // code per test and is deleted before it is recreated, so a test never inherits
    // committed data from an earlier run of itself.

    var
        Assert: Codeunit Assert;
        LibrarySales: Codeunit "Library - Sales";
        LibrarySetup: Codeunit "CDO Library - Setup";
        LibraryStatement: Codeunit "CDO Library - Statement";

    #region CreateOrSendAutStatements - period statement

    [Test]
    procedure PeriodStatement_WhenSendingDateHasPassed_ShouldCreateJournalLineForCalculatedPeriod()
    var
        AutomaticPeriodStatement: Record "CDO Automatic Period Statement";
        Customer: Record Customer;
        EmailTemplateHeader: Record "CDO E-Mail Template Header";
        StatementJournalLine: Record "CDO Statement Journal Line";
        SendCustStatementMgt: Codeunit "CDO Send Cust. Statement Mgt.";
        ExpectedEndDate: Date;
        ExpectedSendingDate: Date;
        ExpectedStartDate: Date;
        LastSendingDate: Date;
    begin
        // [SCENARIO] A customer whose next sending date has passed gets a period statement
        // for the period derived from that sending date.

        // [GIVEN] A customer with an automatic period statement and a statement logged 3 months ago
        LastSendingDate := CalcDate('<-3M>', WorkDate());
        ExpectedSendingDate := CalcDate('<1M>', LastSendingDate);
        ExpectedStartDate := CalcDate('<-1M>', ExpectedSendingDate);
        ExpectedEndDate := ExpectedSendingDate - 1;

        PrepareAutomaticStatementRun();
        LibraryStatement.MockStatementForCustomerWithAmountAndPostingDate(Customer, 1000, ExpectedStartDate);
        SetupPeriodStatementCustomer(Customer, AutomaticPeriodStatement, EmailTemplateHeader, AutomaticPeriodStatement."Send statement if"::Balance, 'P01');

        // [GIVEN] An older log entry as well, so the latest sending date has to be picked
        MockPeriodStatementLog(EmailTemplateHeader.Code, Customer."No.", CalcDate('<-4M>', WorkDate()), CalcDate('<-7M>', WorkDate()));
        MockPeriodStatementLog(EmailTemplateHeader.Code, Customer."No.", LastSendingDate, CalcDate('<-6M>', WorkDate()));

        // [WHEN] The automatic statements are created
        SendCustStatementMgt.CreateOrSendAutStatements();

        // [THEN] Exactly one period statement is journalized for the calculated period
        Assert.AreEqual(1, LibraryStatement.GetStatementJournalLineCount(Customer."No."), 'One statement journal line should be created');
        FindStatementJournalLine(StatementJournalLine, Customer."No.");
        Assert.AreEqual(StatementJournalLine.Type::Period, StatementJournalLine.Type, 'Line should be a period statement');
        Assert.AreEqual(ExpectedSendingDate, StatementJournalLine."Planned Sending Date", 'Planned sending date should be the next sending date after the last logged one');
        Assert.AreEqual(ExpectedStartDate, StatementJournalLine."Start Date", 'Start date should be one period before the sending date');
        Assert.AreEqual(ExpectedEndDate, StatementJournalLine."End Date", 'End date should be the day before the sending date');
        Assert.IsTrue(StatementJournalLine.HasPDF(), 'Line should have a statement PDF');
    end;

    [Test]
    procedure PeriodStatement_WhenUnrelatedLogEntriesExist_ShouldStillUseOwnLastSendingDate()
    var
        AutomaticPeriodStatement: Record "CDO Automatic Period Statement";
        Customer: Record Customer;
        EMailLog: Record "CDO E-Mail Log";
        EmailTemplateHeader: Record "CDO E-Mail Template Header";
        OtherEmailTemplateHeader: Record "CDO E-Mail Template Header";
        StatementJournalLine: Record "CDO Statement Journal Line";
        SendCustStatementMgt: Codeunit "CDO Send Cust. Statement Mgt.";
        ExpectedSendingDate: Date;
        ExpectedStartDate: Date;
        LastSendingDate: Date;
    begin
        // [SCENARIO] The last sending date only considers period statement log entries for this
        // customer and this template, and only entries with a planned sending date.

        // [GIVEN] A customer with an automatic period statement and a statement logged 3 months ago
        LastSendingDate := CalcDate('<-3M>', WorkDate());
        ExpectedSendingDate := CalcDate('<1M>', LastSendingDate);
        ExpectedStartDate := CalcDate('<-1M>', ExpectedSendingDate);

        PrepareAutomaticStatementRun();
        LibraryStatement.MockStatementForCustomerWithAmountAndPostingDate(Customer, 1000, ExpectedStartDate);
        SetupPeriodStatementCustomer(Customer, AutomaticPeriodStatement, EmailTemplateHeader, AutomaticPeriodStatement."Send statement if"::Balance, 'P02');
        MockPeriodStatementLog(EmailTemplateHeader.Code, Customer."No.", LastSendingDate, CalcDate('<-6M>', WorkDate()));

        // [GIVEN] Recent log entries that each differ from the wanted one in exactly one respect
        CreateStatementEmailTemplate(OtherEmailTemplateHeader, 'LTO-P02');
        MockEMailLog(OtherEmailTemplateHeader.Code, Database::Customer, Customer."No.", EMailLog."Document Type"::"Period Statement", WorkDate(), WorkDate());
        MockEMailLog(EmailTemplateHeader.Code, Database::Vendor, Customer."No.", EMailLog."Document Type"::"Period Statement", WorkDate(), WorkDate());
        MockEMailLog(EmailTemplateHeader.Code, Database::Customer, 'X' + Customer."No.", EMailLog."Document Type"::"Period Statement", WorkDate(), WorkDate());
        MockEMailLog(EmailTemplateHeader.Code, Database::Customer, Customer."No.", EMailLog."Document Type"::Statement, WorkDate(), WorkDate());
        MockEMailLog(EmailTemplateHeader.Code, Database::Customer, Customer."No.", EMailLog."Document Type"::"Period Statement", 0D, WorkDate());

        // [WHEN] The automatic statements are created
        SendCustStatementMgt.CreateOrSendAutStatements();

        // [THEN] The period is still the one following the customer's own last period statement
        Assert.AreEqual(1, LibraryStatement.GetStatementJournalLineCount(Customer."No."), 'One statement journal line should be created');
        FindStatementJournalLine(StatementJournalLine, Customer."No.");
        Assert.AreEqual(ExpectedSendingDate, StatementJournalLine."Planned Sending Date", 'Unrelated log entries should not move the planned sending date');
        Assert.AreEqual(ExpectedStartDate, StatementJournalLine."Start Date", 'Unrelated log entries should not move the period start date');
    end;

    [Test]
    procedure PeriodStatement_WhenNextSendingDateIsToday_ShouldCreateJournalLine()
    var
        AutomaticPeriodStatement: Record "CDO Automatic Period Statement";
        Customer: Record Customer;
        EmailTemplateHeader: Record "CDO E-Mail Template Header";
        StatementJournalLine: Record "CDO Statement Journal Line";
        SendCustStatementMgt: Codeunit "CDO Send Cust. Statement Mgt.";
        LastSendingDate: Date;
    begin
        // [SCENARIO] A statement that falls due exactly on the work date is sent, not postponed.

        // [GIVEN] A customer whose next sending date lands on the work date
        LastSendingDate := CalcDate('<-1M>', WorkDate());

        PrepareAutomaticStatementRun();
        LibraryStatement.MockStatementForCustomerWithAmountAndPostingDate(Customer, 1000, LastSendingDate);
        SetupPeriodStatementCustomer(Customer, AutomaticPeriodStatement, EmailTemplateHeader, AutomaticPeriodStatement."Send statement if"::Balance, 'P03');
        MockPeriodStatementLog(EmailTemplateHeader.Code, Customer."No.", LastSendingDate, CalcDate('<-6M>', WorkDate()));

        // [WHEN] The automatic statements are created
        SendCustStatementMgt.CreateOrSendAutStatements();

        // [THEN] The statement is created with the work date as planned sending date
        Assert.AreEqual(1, LibraryStatement.GetStatementJournalLineCount(Customer."No."), 'A statement due today should be created');
        FindStatementJournalLine(StatementJournalLine, Customer."No.");
        Assert.AreEqual(CalcDate('<1M>', LastSendingDate), StatementJournalLine."Planned Sending Date", 'Planned sending date should be today');
    end;

    [Test]
    procedure PeriodStatement_WhenNextSendingDateIsInTheFuture_ShouldNotCreateJournalLine()
    var
        AutomaticPeriodStatement: Record "CDO Automatic Period Statement";
        Customer: Record Customer;
        EmailTemplateHeader: Record "CDO E-Mail Template Header";
        SendCustStatementMgt: Codeunit "CDO Send Cust. Statement Mgt.";
    begin
        // [SCENARIO] A statement that is not due yet is not created.

        // [GIVEN] A customer that received a statement today, with a monthly interval
        PrepareAutomaticStatementRun();
        LibraryStatement.MockStatementForCustomerWithAmountAndPostingDate(Customer, 1000, CalcDate('<-1M>', WorkDate()));
        SetupPeriodStatementCustomer(Customer, AutomaticPeriodStatement, EmailTemplateHeader, AutomaticPeriodStatement."Send statement if"::Balance, 'P04');
        MockPeriodStatementLog(EmailTemplateHeader.Code, Customer."No.", WorkDate(), CalcDate('<-6M>', WorkDate()));

        // [WHEN] The automatic statements are created
        SendCustStatementMgt.CreateOrSendAutStatements();

        // [THEN] Nothing is journalized
        Assert.AreEqual(0, LibraryStatement.GetStatementJournalLineCount(Customer."No."), 'No statement should be created before the next sending date');
    end;

    [Test]
    procedure PeriodStatement_WhenReminderPostedAfterLastSending_ShouldSetCustomerToManual()
    var
        AutomaticPeriodStatement: Record "CDO Automatic Period Statement";
        CustLedgerEntry: Record "Cust. Ledger Entry";
        Customer: Record Customer;
        EmailTemplateHeader: Record "CDO E-Mail Template Header";
        SendCustStatementMgt: Codeunit "CDO Send Cust. Statement Mgt.";
        LastSendingDate: Date;
    begin
        // [SCENARIO] When a reminder was posted after the last statement and the period statement
        // is configured to react on reminders, the customer is switched to manual handling.

        // [GIVEN] A customer with a reminder posted after the last statement
        LastSendingDate := CalcDate('<-3M>', WorkDate());

        PrepareAutomaticStatementRun();
        LibraryStatement.MockStatementForCustomerWithAmountAndPostingDate(Customer, 1000, LastSendingDate);
        SetupPeriodStatementCustomer(Customer, AutomaticPeriodStatement, EmailTemplateHeader, AutomaticPeriodStatement."Send statement if"::Balance, 'P05');
        AutomaticPeriodStatement."Change to manual on Reminder" := true;
        AutomaticPeriodStatement.Modify();
        MockPeriodStatementLog(EmailTemplateHeader.Code, Customer."No.", LastSendingDate, CalcDate('<-6M>', WorkDate()));

        LibrarySales.MockCustLedgerEntry(CustLedgerEntry, Customer."No.");
        CustLedgerEntry."Document Type" := CustLedgerEntry."Document Type"::Reminder;
        CustLedgerEntry."Posting Date" := CalcDate('<-2M>', WorkDate());
        CustLedgerEntry.Modify();

        // [WHEN] The automatic statements are created
        SendCustStatementMgt.CreateOrSendAutStatements();

        // [THEN] The customer is stored as manual and no statement is created
        Customer.Find();
        Assert.AreEqual(Customer."CDO Automatic statement"::Manual, Customer."CDO Automatic statement", 'Customer should be switched to manual statement handling');
        Assert.AreEqual(0, LibraryStatement.GetStatementJournalLineCount(Customer."No."), 'No statement should be created when the customer is switched to manual');
    end;

    [Test]
    procedure PeriodStatement_EntriesInPeriod_WhenEntryInsidePeriod_ShouldCreateJournalLine()
    var
        AutomaticPeriodStatement: Record "CDO Automatic Period Statement";
        Customer: Record Customer;
        EmailTemplateHeader: Record "CDO E-Mail Template Header";
        SendCustStatementMgt: Codeunit "CDO Send Cust. Statement Mgt.";
        ExpectedStartDate: Date;
        LastSendingDate: Date;
    begin
        // [SCENARIO] "Entries in period" creates a statement when the customer has an entry
        // inside the calculated period.

        // [GIVEN] A customer with an entry inside the period that is about to be statemented
        LastSendingDate := CalcDate('<-3M>', WorkDate());
        ExpectedStartDate := CalcDate('<-1M>', CalcDate('<1M>', LastSendingDate));

        PrepareAutomaticStatementRun();
        LibraryStatement.MockStatementForCustomerWithAmountAndPostingDate(Customer, 1000, ExpectedStartDate);
        SetupPeriodStatementCustomer(Customer, AutomaticPeriodStatement, EmailTemplateHeader, AutomaticPeriodStatement."Send statement if"::"Entries in period", 'P06');
        MockPeriodStatementLog(EmailTemplateHeader.Code, Customer."No.", LastSendingDate, CalcDate('<-6M>', WorkDate()));

        // [WHEN] The automatic statements are created
        SendCustStatementMgt.CreateOrSendAutStatements();

        // [THEN] A statement is journalized
        Assert.AreEqual(1, LibraryStatement.GetStatementJournalLineCount(Customer."No."), 'A statement should be created when entries exist in the period');
    end;

    [Test]
    procedure PeriodStatement_EntriesInPeriod_WhenOnlyOtherCustomerHasEntries_ShouldNotCreateJournalLine()
    var
        AutomaticPeriodStatement: Record "CDO Automatic Period Statement";
        Customer: Record Customer;
        EmailTemplateHeader: Record "CDO E-Mail Template Header";
        OtherCustomer: Record Customer;
        SendCustStatementMgt: Codeunit "CDO Send Cust. Statement Mgt.";
        ExpectedStartDate: Date;
        LastSendingDate: Date;
    begin
        // [SCENARIO] "Entries in period" looks at this customer's entries inside the period only:
        // entries outside the period, or belonging to another customer, do not trigger a statement.

        // [GIVEN] A customer whose only entry is posted after the period that is due
        LastSendingDate := CalcDate('<-3M>', WorkDate());
        ExpectedStartDate := CalcDate('<-1M>', CalcDate('<1M>', LastSendingDate));

        PrepareAutomaticStatementRun();
        LibraryStatement.MockStatementForCustomerWithAmountAndPostingDate(Customer, 1000, WorkDate());
        SetupPeriodStatementCustomer(Customer, AutomaticPeriodStatement, EmailTemplateHeader, AutomaticPeriodStatement."Send statement if"::"Entries in period", 'P07');
        MockPeriodStatementLog(EmailTemplateHeader.Code, Customer."No.", LastSendingDate, CalcDate('<-6M>', WorkDate()));

        // [GIVEN] Another customer that does have an entry inside that period
        LibraryStatement.MockStatementForCustomerWithAmountAndPostingDate(OtherCustomer, 1000, ExpectedStartDate);

        // [WHEN] The automatic statements are created
        SendCustStatementMgt.CreateOrSendAutStatements();

        // [THEN] Nothing is journalized for the customer
        Assert.AreEqual(0, LibraryStatement.GetStatementJournalLineCount(Customer."No."), 'No statement should be created when the customer has no entries inside the period');
    end;

    [Test]
    procedure PeriodStatement_Balance_WhenBalanceIsPostedAfterPeriod_ShouldNotCreateJournalLine()
    var
        AutomaticPeriodStatement: Record "CDO Automatic Period Statement";
        Customer: Record Customer;
        EmailTemplateHeader: Record "CDO E-Mail Template Header";
        SendCustStatementMgt: Codeunit "CDO Send Cust. Statement Mgt.";
        LastSendingDate: Date;
    begin
        // [SCENARIO] The "Balance" condition is evaluated up to the end of the period,
        // so a balance that only arises after the period does not trigger a statement.

        // [GIVEN] A customer whose only entry is posted after the period that is due
        LastSendingDate := CalcDate('<-3M>', WorkDate());

        PrepareAutomaticStatementRun();
        LibraryStatement.MockStatementForCustomerWithAmountAndPostingDate(Customer, 1000, WorkDate());
        SetupPeriodStatementCustomer(Customer, AutomaticPeriodStatement, EmailTemplateHeader, AutomaticPeriodStatement."Send statement if"::Balance, 'P08');
        MockPeriodStatementLog(EmailTemplateHeader.Code, Customer."No.", LastSendingDate, CalcDate('<-6M>', WorkDate()));

        // [WHEN] The automatic statements are created
        SendCustStatementMgt.CreateOrSendAutStatements();

        // [THEN] Nothing is journalized
        Assert.AreEqual(0, LibraryStatement.GetStatementJournalLineCount(Customer."No."), 'No statement should be created when the balance falls outside the period');
    end;

    [Test]
    procedure PeriodStatement_NegativeBalanceBlock_WhenNegativeInPeriod_ShouldNotCreateJournalLine()
    var
        AutomaticPeriodStatement: Record "CDO Automatic Period Statement";
        Customer: Record Customer;
        EmailTemplateHeader: Record "CDO E-Mail Template Header";
        SendCustStatementMgt: Codeunit "CDO Send Cust. Statement Mgt.";
        ExpectedStartDate: Date;
        LastSendingDate: Date;
    begin
        // [SCENARIO] "Do not send if neg. balance" blocks the statement based on the balance
        // at the end of the period, even though the send condition itself is met.

        // [GIVEN] A customer that is negative within the period but positive afterwards
        LastSendingDate := CalcDate('<-3M>', WorkDate());
        ExpectedStartDate := CalcDate('<-1M>', CalcDate('<1M>', LastSendingDate));

        PrepareAutomaticStatementRun();
        LibraryStatement.MockStatementForCustomerWithAmountAndPostingDate(Customer, -500, ExpectedStartDate);
        MockExtraDetailedEntry(Customer, 2000, WorkDate());
        SetupPeriodStatementCustomer(Customer, AutomaticPeriodStatement, EmailTemplateHeader, AutomaticPeriodStatement."Send statement if"::"Entries in period", 'P09');
        AutomaticPeriodStatement."Do not send if neg. balance" := true;
        AutomaticPeriodStatement.Modify();
        MockPeriodStatementLog(EmailTemplateHeader.Code, Customer."No.", LastSendingDate, CalcDate('<-6M>', WorkDate()));

        // [WHEN] The automatic statements are created
        SendCustStatementMgt.CreateOrSendAutStatements();

        // [THEN] Nothing is journalized
        Assert.AreEqual(0, LibraryStatement.GetStatementJournalLineCount(Customer."No."), 'No statement should be created for a negative balance in the period');
    end;

    [Test]
    procedure PeriodStatement_BalanceDue_WhenEntryFallsDueInPeriod_ShouldCreateJournalLine()
    begin
        // [SCENARIO] The "Balance due" send condition creates a statement when the customer
        // has an amount falling due by the end of the period.
        RunSendConditionScenario('P11', SendConditionBalanceDue());
    end;

    [Test]
    procedure PeriodStatement_EntriesInPeriodOrBalance_WhenBothHold_ShouldCreateJournalLine()
    begin
        // [SCENARIO] The "Entries in period or balance" send condition creates a statement.
        RunSendConditionScenario('P12', SendConditionEntriesOrBalance());
    end;

    [Test]
    procedure PeriodStatement_EntriesInPeriodOrBalanceDue_WhenBothHold_ShouldCreateJournalLine()
    begin
        // [SCENARIO] The "Entries in period or balance due" send condition creates a statement.
        RunSendConditionScenario('P13', SendConditionEntriesOrBalanceDue());
    end;

    // NOT TESTED: the "Do not send if neg. balance" boundary itself (Net Change exactly 0).
    // A customer whose net change at the end of the period is exactly zero produces an empty
    // statement report, so CreateStatement never gets a PDF and never journalizes a line -
    // with or without the guard. Verified against a customer with two entries in the period
    // netting to zero: the setup assertion on Net Change (LCY) = 0 held and no line was
    // created even though CheckForStatement returned true. The boundary is therefore not
    // observable through the journal.

    #endregion

    #region CreateOrSendAutStatements - due date statement

    [Test]
    procedure DueDateStatement_WhenOpenEntryFallsDueInPeriod_ShouldCreateBalanceDueJournalLine()
    var
        AutDueDateStatement: Record "CDO Aut. Due Date Statement";
        Customer: Record Customer;
        EmailTemplateHeader: Record "CDO E-Mail Template Header";
        StatementJournalLine: Record "CDO Statement Journal Line";
        SendCustStatementMgt: Codeunit "CDO Send Cust. Statement Mgt.";
        ExpectedEndDate: Date;
        ExpectedStartDate: Date;
    begin
        // [SCENARIO] A customer with an open entry falling due inside the balance due horizon
        // gets a balance due statement for that horizon.

        // [GIVEN] A customer with an open, positive entry falling due within the next month
        ExpectedEndDate := CalcDate('<1M>', WorkDate());
        ExpectedStartDate := CalcDate('<-1M>', ExpectedEndDate);

        PrepareAutomaticStatementRun();
        LibraryStatement.MockStatementForCustomerWithAmountAndPostingDate(Customer, 1000, CalcDate('<1W>', WorkDate()));
        SetCustomerEntryDueDate(Customer, true, true, CalcDate('<2W>', WorkDate()));
        SetupDueDateStatementCustomer(Customer, AutDueDateStatement, EmailTemplateHeader, 'D01');

        // [WHEN] The automatic statements are created
        SendCustStatementMgt.CreateOrSendAutStatements();

        // [THEN] A balance due statement is journalized for the balance due horizon
        Assert.AreEqual(1, LibraryStatement.GetStatementJournalLineCount(Customer."No."), 'One balance due statement should be created');
        FindStatementJournalLine(StatementJournalLine, Customer."No.");
        Assert.AreEqual(StatementJournalLine.Type::"Balance Due", StatementJournalLine.Type, 'Line should be a balance due statement');
        Assert.AreEqual(WorkDate(), StatementJournalLine."Planned Sending Date", 'Balance due statements are planned for the work date');
        Assert.AreEqual(ExpectedStartDate, StatementJournalLine."Start Date", 'Start date should be one month before the horizon');
        Assert.AreEqual(ExpectedEndDate, StatementJournalLine."End Date", 'End date should be the balance due horizon');
    end;

    [Test]
    procedure DueDateStatement_WhenPreviousStatementExists_ShouldStartAfterThatStatement()
    var
        AutDueDateStatement: Record "CDO Aut. Due Date Statement";
        Customer: Record Customer;
        EMailLog: Record "CDO E-Mail Log";
        EmailTemplateHeader: Record "CDO E-Mail Template Header";
        OtherEmailTemplateHeader: Record "CDO E-Mail Template Header";
        StatementJournalLine: Record "CDO Statement Journal Line";
        SendCustStatementMgt: Codeunit "CDO Send Cust. Statement Mgt.";
        ExpectedEndDate: Date;
        LaterDate: Date;
    begin
        // [SCENARIO] The balance due period starts the day after the customer's own last
        // statement; log entries for other templates, tables, customers or document types
        // outside the statement range are ignored.

        // [GIVEN] A customer with an open entry falling due within the next month
        ExpectedEndDate := CalcDate('<1M>', WorkDate());
        LaterDate := CalcDate('<2M>', WorkDate());

        PrepareAutomaticStatementRun();
        LibraryStatement.MockStatementForCustomerWithAmountAndPostingDate(Customer, 1000, CalcDate('<1W>', WorkDate()));
        SetCustomerEntryDueDate(Customer, true, true, CalcDate('<2W>', WorkDate()));
        SetupDueDateStatementCustomer(Customer, AutDueDateStatement, EmailTemplateHeader, 'D02');

        // [GIVEN] An earlier and a latest statement logged for this customer and template
        MockEMailLog(EmailTemplateHeader.Code, Database::Customer, Customer."No.", EMailLog."Document Type"::Statement, CalcDate('<-1M>', WorkDate()), CalcDate('<-6M>', WorkDate()));
        MockEMailLog(EmailTemplateHeader.Code, Database::Customer, Customer."No.", EMailLog."Document Type"::Statement, WorkDate(), CalcDate('<3M>', WorkDate()));

        // [GIVEN] Later log entries that each differ from those in exactly one respect
        CreateStatementEmailTemplate(OtherEmailTemplateHeader, 'LTO-D02');
        MockEMailLog(OtherEmailTemplateHeader.Code, Database::Customer, Customer."No.", EMailLog."Document Type"::Statement, LaterDate, WorkDate());
        MockEMailLog(EmailTemplateHeader.Code, Database::Vendor, Customer."No.", EMailLog."Document Type"::Statement, LaterDate, WorkDate());
        MockEMailLog(EmailTemplateHeader.Code, Database::Customer, 'X' + Customer."No.", EMailLog."Document Type"::Statement, LaterDate, WorkDate());
        MockEMailLog(EmailTemplateHeader.Code, Database::Customer, Customer."No.", EMailLog."Document Type"::" ", LaterDate, WorkDate());
        MockEMailLog(EmailTemplateHeader.Code, Database::Customer, Customer."No.", EMailLog."Document Type"::Statement, 0D, CalcDate('<3M>', WorkDate()));

        // [WHEN] The automatic statements are created
        SendCustStatementMgt.CreateOrSendAutStatements();

        // [THEN] The period starts the day after the customer's own last statement
        Assert.AreEqual(1, LibraryStatement.GetStatementJournalLineCount(Customer."No."), 'One balance due statement should be created');
        FindStatementJournalLine(StatementJournalLine, Customer."No.");
        Assert.AreEqual(WorkDate() + 1, StatementJournalLine."Start Date", 'Start date should be the day after the last statement');
        Assert.AreEqual(ExpectedEndDate, StatementJournalLine."End Date", 'End date should be the balance due horizon');
    end;

    [Test]
    procedure DueDateStatement_WhenLastStatementReachesHorizon_ShouldNotCreateJournalLine()
    var
        AutDueDateStatement: Record "CDO Aut. Due Date Statement";
        Customer: Record Customer;
        EMailLog: Record "CDO E-Mail Log";
        EmailTemplateHeader: Record "CDO E-Mail Template Header";
        SendCustStatementMgt: Codeunit "CDO Send Cust. Statement Mgt.";
    begin
        // [SCENARIO] When the last statement already reaches the balance due horizon,
        // no new statement is created.

        // [GIVEN] A customer whose last statement was planned exactly on the horizon
        PrepareAutomaticStatementRun();
        LibraryStatement.MockStatementForCustomerWithAmountAndPostingDate(Customer, 1000, CalcDate('<1W>', WorkDate()));
        SetCustomerEntryDueDate(Customer, true, true, CalcDate('<2W>', WorkDate()));
        SetupDueDateStatementCustomer(Customer, AutDueDateStatement, EmailTemplateHeader, 'D03');
        MockEMailLog(EmailTemplateHeader.Code, Database::Customer, Customer."No.", EMailLog."Document Type"::Statement, CalcDate('<1M>', WorkDate()), CalcDate('<-6M>', WorkDate()));

        // [WHEN] The automatic statements are created
        SendCustStatementMgt.CreateOrSendAutStatements();

        // [THEN] Nothing is journalized
        Assert.AreEqual(0, LibraryStatement.GetStatementJournalLineCount(Customer."No."), 'No statement should be created when the horizon is already covered');
    end;

    [Test]
    procedure DueDateStatement_WhenNoMatchingOpenEntry_ShouldNotCreateJournalLine()
    var
        AutDueDateStatement: Record "CDO Aut. Due Date Statement";
        CustLedgerEntry: Record "Cust. Ledger Entry";
        Customer: Record Customer;
        EmailTemplateHeader: Record "CDO E-Mail Template Header";
        OtherCustomer: Record Customer;
        SendCustStatementMgt: Codeunit "CDO Send Cust. Statement Mgt.";
    begin
        // [SCENARIO] Only the customer's own open, positive entries falling due inside the
        // horizon trigger a balance due statement.

        // [GIVEN] A customer whose entry is closed
        PrepareAutomaticStatementRun();
        LibraryStatement.MockStatementForCustomerWithAmountAndPostingDate(Customer, 1000, CalcDate('<1W>', WorkDate()));
        SetCustomerEntryDueDate(Customer, false, true, CalcDate('<2W>', WorkDate()));
        SetupDueDateStatementCustomer(Customer, AutDueDateStatement, EmailTemplateHeader, 'D04');

        // [GIVEN] An open but negative entry, and an open positive entry falling due long ago
        LibrarySales.MockCustLedgerEntry(CustLedgerEntry, Customer."No.");
        CustLedgerEntry.Open := true;
        CustLedgerEntry.Positive := false;
        CustLedgerEntry."Due Date" := CalcDate('<2W>', WorkDate());
        CustLedgerEntry.Modify();

        LibrarySales.MockCustLedgerEntry(CustLedgerEntry, Customer."No.");
        CustLedgerEntry.Open := true;
        CustLedgerEntry.Positive := true;
        CustLedgerEntry."Due Date" := CalcDate('<-6M>', WorkDate());
        CustLedgerEntry.Modify();

        // [GIVEN] Another customer that does have a matching open entry
        LibraryStatement.MockStatementForCustomerWithAmountAndPostingDate(OtherCustomer, 1000, CalcDate('<1W>', WorkDate()));
        SetCustomerEntryDueDate(OtherCustomer, true, true, CalcDate('<2W>', WorkDate()));

        // [WHEN] The automatic statements are created
        SendCustStatementMgt.CreateOrSendAutStatements();

        // [THEN] Nothing is journalized for the customer
        Assert.AreEqual(0, LibraryStatement.GetStatementJournalLineCount(Customer."No."), 'No statement should be created without a matching open entry');
    end;

    #endregion

    #region SendPeriodStatements

    [Test]
    procedure SendPeriodStatements_WhenCustomerIsManual_ShouldNotCreateJournalLine()
    var
        Customer: Record Customer;
        EmailTemplateHeader: Record "CDO E-Mail Template Header";
        SendCustStatement: Record "CDO Send Customer Statement";
        SendCustStatementMgt: Codeunit "CDO Send Cust. Statement Mgt.";
    begin
        // [SCENARIO] Customers that are not set to automatic statements are skipped,
        // even when they have a send statement code.

        // [GIVEN] A customer with a send statement code but manual statement handling
        PrepareLegacyStatementRun();
        LibraryStatement.MockStatementForCustomerWithAmountAndPostingDate(Customer, 1000, CalcDate('<-2M>', WorkDate()));
        CreateSendCustomerStatement(SendCustStatement, EmailTemplateHeader, SendCustStatement."Send statement if"::Balance, 'S01');
        SetupLegacyCustomer(Customer, SendCustStatement.Code);
        Customer."CDO Automatic statement" := Customer."CDO Automatic statement"::Manual;
        Customer.Modify();

        // [WHEN] Period statements are sent
        SendCustStatementMgt.SendPeriodStatements();

        // [THEN] Nothing is journalized for the customer
        Assert.AreEqual(0, LibraryStatement.GetStatementJournalLineCount(Customer."No."), 'A manual customer should not be processed');
    end;

    [Test]
    procedure SendPeriodStatements_WhenReminderRequiresManual_ShouldStoreManualOnCustomer()
    var
        CustLedgerEntry: Record "Cust. Ledger Entry";
        Customer: Record Customer;
        EmailTemplateHeader: Record "CDO E-Mail Template Header";
        SendCustStatement: Record "CDO Send Customer Statement";
        SendCustStatementMgt: Codeunit "CDO Send Cust. Statement Mgt.";
    begin
        // [SCENARIO] The switch to manual handling is persisted on the customer.

        // [GIVEN] An automatic customer with a reminder posted after the last automatic date
        PrepareLegacyStatementRun();
        LibraryStatement.MockStatementForCustomerWithAmountAndPostingDate(Customer, 1000, CalcDate('<-2M>', WorkDate()));
        CreateSendCustomerStatement(SendCustStatement, EmailTemplateHeader, SendCustStatement."Send statement if"::Balance, 'S02');
        SendCustStatement."Change to manual on Reminder" := true;
        SendCustStatement.Modify();
        SetupLegacyCustomer(Customer, SendCustStatement.Code);

        LibrarySales.MockCustLedgerEntry(CustLedgerEntry, Customer."No.");
        CustLedgerEntry."Document Type" := CustLedgerEntry."Document Type"::Reminder;
        CustLedgerEntry."Posting Date" := CalcDate('<-1M>', WorkDate());
        CustLedgerEntry.Modify();

        // [WHEN] Period statements are sent
        SendCustStatementMgt.SendPeriodStatements();

        // [THEN] The customer is stored as manual and no statement is created
        Customer.Find();
        Assert.AreEqual(Customer."CDO Automatic statement"::Manual, Customer."CDO Automatic statement", 'Customer should be stored as manual');
        Assert.AreEqual(0, LibraryStatement.GetStatementJournalLineCount(Customer."No."), 'No statement should be created for a customer switched to manual');
    end;

    #endregion

    #region ChangeAuatomaticToManual

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure ChangeAutomaticToManual_WhenReminderBelongsToAnotherCustomer_ShouldReturnFalse()
    var
        CustLedgerEntry: Record "Cust. Ledger Entry";
        Customer: Record Customer;
        EmailTemplateHeader: Record "CDO E-Mail Template Header";
        OtherCustomer: Record Customer;
        SendCustStatement: Record "CDO Send Customer Statement";
        SendCustStatementMgt: Codeunit "CDO Send Cust. Statement Mgt.";
        LastDate: Date;
        Result: Boolean;
    begin
        // [SCENARIO] Only the evaluated customer's own entries switch it to manual.

        // [GIVEN] A customer without entries and another customer with a reminder
        LibrarySetup.InitializeCDOSetup();
        LibrarySales.CreateCustomer(Customer);
        LibrarySales.CreateCustomer(OtherCustomer);
        LastDate := CalcDate('<-1M>', WorkDate());

        LibrarySales.MockCustLedgerEntry(CustLedgerEntry, OtherCustomer."No.");
        CustLedgerEntry."Document Type" := CustLedgerEntry."Document Type"::Reminder;
        CustLedgerEntry."Posting Date" := CalcDate('<-1W>', WorkDate());
        CustLedgerEntry.Modify();

        CreateSendCustomerStatement(SendCustStatement, EmailTemplateHeader, SendCustStatement."Send statement if"::Balance, 'C01');
        SendCustStatement."Change to manual on Reminder" := true;
        SendCustStatement."Change to manual on Fin.Chr.M." := true;
        SendCustStatement.Modify();

        // [WHEN] ChangeAuatomaticToManual is called for the customer without entries
        Result := SendCustStatementMgt.ChangeAuatomaticToManual(Customer."No.", LastDate, SendCustStatement);

        // [THEN] The result is false
        Assert.IsFalse(Result, 'Another customer''s reminder should not switch this customer to manual');
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure ChangeAutomaticToManual_WhenReminderPostedOnLastDate_ShouldReturnFalse()
    var
        CustLedgerEntry: Record "Cust. Ledger Entry";
        Customer: Record Customer;
        EmailTemplateHeader: Record "CDO E-Mail Template Header";
        SendCustStatement: Record "CDO Send Customer Statement";
        SendCustStatementMgt: Codeunit "CDO Send Cust. Statement Mgt.";
        LastDate: Date;
        Result: Boolean;
    begin
        // [SCENARIO] Only entries posted strictly after the last statement date count.

        // [GIVEN] A customer with a reminder posted exactly on the last statement date
        LibrarySetup.InitializeCDOSetup();
        LibrarySales.CreateCustomer(Customer);
        LastDate := CalcDate('<-1M>', WorkDate());

        LibrarySales.MockCustLedgerEntry(CustLedgerEntry, Customer."No.");
        CustLedgerEntry."Document Type" := CustLedgerEntry."Document Type"::Reminder;
        CustLedgerEntry."Posting Date" := LastDate;
        CustLedgerEntry.Modify();

        CreateSendCustomerStatement(SendCustStatement, EmailTemplateHeader, SendCustStatement."Send statement if"::Balance, 'C02');
        SendCustStatement."Change to manual on Reminder" := true;
        SendCustStatement."Change to manual on Fin.Chr.M." := true;
        SendCustStatement.Modify();

        // [WHEN] ChangeAuatomaticToManual is called
        Result := SendCustStatementMgt.ChangeAuatomaticToManual(Customer."No.", LastDate, SendCustStatement);

        // [THEN] The result is false
        Assert.IsFalse(Result, 'A reminder posted on the last statement date should not switch to manual');
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure ChangeAutomaticToManual_WhenOnlyFinChargeFlagSetAndReminderExists_ShouldReturnFalse()
    var
        CustLedgerEntry: Record "Cust. Ledger Entry";
        Customer: Record Customer;
        EmailTemplateHeader: Record "CDO E-Mail Template Header";
        SendCustStatement: Record "CDO Send Customer Statement";
        SendCustStatementMgt: Codeunit "CDO Send Cust. Statement Mgt.";
        LastDate: Date;
        Result: Boolean;
    begin
        // [SCENARIO] With only the finance charge flag set, a reminder is not a reason
        // to switch the customer to manual.

        // [GIVEN] A customer with a reminder and only the finance charge flag set
        LibrarySetup.InitializeCDOSetup();
        LibrarySales.CreateCustomer(Customer);
        LastDate := CalcDate('<-1M>', WorkDate());

        LibrarySales.MockCustLedgerEntry(CustLedgerEntry, Customer."No.");
        CustLedgerEntry."Document Type" := CustLedgerEntry."Document Type"::Reminder;
        CustLedgerEntry."Posting Date" := CalcDate('<-1W>', WorkDate());
        CustLedgerEntry.Modify();

        CreateSendCustomerStatement(SendCustStatement, EmailTemplateHeader, SendCustStatement."Send statement if"::Balance, 'C03');
        SendCustStatement."Change to manual on Reminder" := false;
        SendCustStatement."Change to manual on Fin.Chr.M." := true;
        SendCustStatement.Modify();

        // [WHEN] ChangeAuatomaticToManual is called
        Result := SendCustStatementMgt.ChangeAuatomaticToManual(Customer."No.", LastDate, SendCustStatement);

        // [THEN] The result is false
        Assert.IsFalse(Result, 'A reminder should not switch to manual when only the finance charge flag is set');
    end;

    #endregion

    #region IsCustomerStatementReport

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure IsCustomerStatementReport_WhenTemplateHasOtherUsage_ShouldReturnFalse()
    var
        Customer: Record Customer;
        EMailTemplateHeader: Record "CDO E-Mail Template Header";
        SendCustStatementMgt: Codeunit "CDO Send Cust. Statement Mgt.";
        CustomerRef: RecordRef;
        CustomReportID: Integer;
        Result: Boolean;
    begin
        // [SCENARIO] A template for a report that is not used for customer statements
        // does not make that report a customer statement report.

        // [GIVEN] An email template for a custom report with a non-statement usage
        CustomReportID := 60011;
        CustomerRef.GetTable(Customer);

        if EMailTemplateHeader.Get('LTS-I01') then
            EMailTemplateHeader.Delete(true);
        EMailTemplateHeader.Init();
        EMailTemplateHeader.Code := 'LTS-I01';
        EMailTemplateHeader."Report-ID" := CustomReportID;
        EMailTemplateHeader."Report Selection Usage" := EMailTemplateHeader."Report Selection Usage"::"S.Invoice";
        EMailTemplateHeader.Insert();

        // [WHEN] IsCustomerStatementReport is called with that report
        Result := SendCustStatementMgt.IsCustomerStatementReport(CustomReportID, CustomerRef);

        // [THEN] The result is false
        Assert.IsFalse(Result, 'A template with a non-statement usage should not qualify the report');
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure IsCustomerStatementReport_WhenStatementTemplateUsesOtherReport_ShouldReturnFalse()
    var
        Customer: Record Customer;
        EMailTemplateHeader: Record "CDO E-Mail Template Header";
        SendCustStatementMgt: Codeunit "CDO Send Cust. Statement Mgt.";
        CustomerRef: RecordRef;
        Result: Boolean;
    begin
        // [SCENARIO] A customer statement template for another report does not qualify
        // an unrelated report.

        // [GIVEN] A C.Statement email template for report 60012
        CustomerRef.GetTable(Customer);

        if EMailTemplateHeader.Get('LTS-I02') then
            EMailTemplateHeader.Delete(true);
        EMailTemplateHeader.Init();
        EMailTemplateHeader.Code := 'LTS-I02';
        EMailTemplateHeader."Report-ID" := 60012;
        EMailTemplateHeader."Report Selection Usage" := EMailTemplateHeader."Report Selection Usage"::"C.Statement";
        EMailTemplateHeader.Insert();

        // [WHEN] IsCustomerStatementReport is called with a different report
        Result := SendCustStatementMgt.IsCustomerStatementReport(60013, CustomerRef);

        // [THEN] The result is false
        Assert.IsFalse(Result, 'A statement template for another report should not qualify this report');
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure IsCustomerStatementReport_WhenReportIsConfiguredInReportSelections_ShouldReturnTrue()
    var
        Customer: Record Customer;
        ReportSelections: Record "Report Selections";
        SendCustStatementMgt: Codeunit "CDO Send Cust. Statement Mgt.";
        CustomerRef: RecordRef;
        CustomReportID: Integer;
        Result: Boolean;
    begin
        // [SCENARIO] The report configured as the customer statement report in the
        // report selections is recognised as a customer statement report.

        // [GIVEN] The customer statement report selection points at a custom report
        CustomReportID := 60014;
        CustomerRef.GetTable(Customer);
        LibrarySetup.InitializeCDOSetup();

        ReportSelections.SetRange(Usage, ReportSelections.Usage::"C.Statement");
        ReportSelections.SetRange("Use for Email Attachment", true);
        Assert.IsTrue(ReportSelections.FindFirst(), 'A customer statement report selection is expected in this company');
        ReportSelections."Report ID" := CustomReportID;
        ReportSelections.Modify();

        // [WHEN] IsCustomerStatementReport is called with that report
        Result := SendCustStatementMgt.IsCustomerStatementReport(CustomReportID, CustomerRef);

        // [THEN] The result is true
        Assert.IsTrue(Result, 'The configured customer statement report should be recognised');
    end;

    #endregion

    #region Helpers

    local procedure RunSendConditionScenario(TestId: Code[4]; SendStatementIf: Option)
    var
        AutomaticPeriodStatement: Record "CDO Automatic Period Statement";
        Customer: Record Customer;
        EmailTemplateHeader: Record "CDO E-Mail Template Header";
        SendCustStatementMgt: Codeunit "CDO Send Cust. Statement Mgt.";
        ExpectedStartDate: Date;
        LastSendingDate: Date;
    begin
        // [GIVEN] A customer with an open amount inside the period that is due
        LastSendingDate := CalcDate('<-3M>', WorkDate());
        ExpectedStartDate := CalcDate('<-1M>', CalcDate('<1M>', LastSendingDate));

        PrepareAutomaticStatementRun();
        LibraryStatement.MockStatementForCustomerWithAmountAndPostingDate(Customer, 1000, ExpectedStartDate);
        SetCustomerEntryDueDate(Customer, true, true, ExpectedStartDate);
        SetupPeriodStatementCustomer(Customer, AutomaticPeriodStatement, EmailTemplateHeader, SendStatementIf, TestId);
        MockPeriodStatementLog(EmailTemplateHeader.Code, Customer."No.", LastSendingDate, CalcDate('<-6M>', WorkDate()));

        // [WHEN] The automatic statements are created
        SendCustStatementMgt.CreateOrSendAutStatements();

        // [THEN] A statement is journalized
        Assert.AreEqual(1, LibraryStatement.GetStatementJournalLineCount(Customer."No."), 'A statement should be created when the send condition is met');
    end;

    local procedure SendConditionBalanceDue(): Integer
    var
        AutomaticPeriodStatement: Record "CDO Automatic Period Statement";
    begin
        exit(AutomaticPeriodStatement."Send statement if"::"Balance due");
    end;

    local procedure SendConditionEntriesOrBalance(): Integer
    var
        AutomaticPeriodStatement: Record "CDO Automatic Period Statement";
    begin
        exit(AutomaticPeriodStatement."Send statement if"::"Entries in period or balance");
    end;

    local procedure SendConditionEntriesOrBalanceDue(): Integer
    var
        AutomaticPeriodStatement: Record "CDO Automatic Period Statement";
    begin
        exit(AutomaticPeriodStatement."Send statement if"::"Entries in period or balance due");
    end;

    local procedure PrepareAutomaticStatementRun()
    var
        Customer: Record Customer;
    begin
        // CreateOrSendAutStatements loops over every customer that has an automatic document.
        // Detach the ones left behind by earlier runs so each test only sees its own customer.
        LibrarySetup.InitializeCDOSetup();
        LibraryStatement.ClearStatementJournalLines();
        Customer.SetFilter("CDO Automatic Documents", '<>%1', '');
        if not Customer.IsEmpty() then
            Customer.ModifyAll("CDO Automatic Documents", '');
    end;

    local procedure PrepareLegacyStatementRun()
    var
        Customer: Record Customer;
    begin
        LibrarySetup.InitializeCDOSetup();
        LibraryStatement.ClearStatementJournalLines();
        Customer.SetFilter("CDO Send Statement Code", '<>%1', '');
        if not Customer.IsEmpty() then
            Customer.ModifyAll("CDO Send Statement Code", '');
    end;

    local procedure SetupPeriodStatementCustomer(var Customer: Record Customer; var AutomaticPeriodStatement: Record "CDO Automatic Period Statement"; var EmailTemplateHeader: Record "CDO E-Mail Template Header"; SendStatementIf: Option; TestId: Code[4])
    var
        AutomaticDocument: Record "CDO Automatic Document";
    begin
        CreateStatementEmailTemplate(EmailTemplateHeader, 'LTS-' + TestId);

        if AutomaticPeriodStatement.Get('LTP-' + TestId) then
            AutomaticPeriodStatement.Delete();
        AutomaticPeriodStatement.Init();
        AutomaticPeriodStatement.Code := 'LTP-' + TestId;
        AutomaticPeriodStatement."Send statement if" := SendStatementIf;
        AutomaticPeriodStatement."E-Mail Template Code" := EmailTemplateHeader.Code;
        AutomaticPeriodStatement.Output := AutomaticPeriodStatement.Output::Journal;
        AutomaticPeriodStatement."Period Start Date Type" := AutomaticPeriodStatement."Period Start Date Type"::"Date formula";
        AutomaticPeriodStatement."Period End Date Type" := AutomaticPeriodStatement."Period End Date Type"::"Date formula";
        Evaluate(AutomaticPeriodStatement."Period Date Formula", '1M');
        Evaluate(AutomaticPeriodStatement."Sending interval", '1M');
        AutomaticPeriodStatement.Insert();

        if AutomaticDocument.Get('LTD-' + TestId) then
            AutomaticDocument.Delete();
        AutomaticDocument.Init();
        AutomaticDocument.Code := 'LTD-' + TestId;
        AutomaticDocument."Automatic Period Statement" := AutomaticPeriodStatement.Code;
        AutomaticDocument.Insert();

        AttachAutomaticDocument(Customer, AutomaticDocument.Code);
    end;

    local procedure SetupDueDateStatementCustomer(var Customer: Record Customer; var AutDueDateStatement: Record "CDO Aut. Due Date Statement"; var EmailTemplateHeader: Record "CDO E-Mail Template Header"; TestId: Code[4])
    var
        AutomaticDocument: Record "CDO Automatic Document";
    begin
        CreateStatementEmailTemplate(EmailTemplateHeader, 'LTS-' + TestId);

        if AutDueDateStatement.Get('LTB-' + TestId) then
            AutDueDateStatement.Delete();
        AutDueDateStatement.Init();
        AutDueDateStatement.Code := 'LTB-' + TestId;
        AutDueDateStatement."E-Mail Template Code" := EmailTemplateHeader.Code;
        AutDueDateStatement.Output := AutDueDateStatement.Output::Journal;
        Evaluate(AutDueDateStatement."Send statement if Bal.Due D.F.", '1M');
        AutDueDateStatement.Insert();

        if AutomaticDocument.Get('LTD-' + TestId) then
            AutomaticDocument.Delete();
        AutomaticDocument.Init();
        AutomaticDocument.Code := 'LTD-' + TestId;
        AutomaticDocument."Automatic Due Date Statement" := AutDueDateStatement.Code;
        AutomaticDocument.Insert();

        AttachAutomaticDocument(Customer, AutomaticDocument.Code);
    end;

    local procedure CreateSendCustomerStatement(var SendCustomerStatement: Record "CDO Send Customer Statement"; var EmailTemplateHeader: Record "CDO E-Mail Template Header"; SendStatementIf: Option; TestId: Code[4])
    begin
        CreateStatementEmailTemplate(EmailTemplateHeader, 'LTS-' + TestId);

        if SendCustomerStatement.Get('LTC-' + TestId) then
            SendCustomerStatement.Delete();
        SendCustomerStatement.Init();
        SendCustomerStatement.Code := 'LTC-' + TestId;
        SendCustomerStatement."Send statement if" := SendStatementIf;
        SendCustomerStatement."E-Mail Template Code" := EmailTemplateHeader.Code;
        SendCustomerStatement.Output := SendCustomerStatement.Output::Journal;
        Evaluate(SendCustomerStatement."Period Date Formula", '1M');
        SendCustomerStatement.Insert();
    end;

    local procedure CreateStatementEmailTemplate(var EmailTemplateHeader: Record "CDO E-Mail Template Header"; TemplateCode: Code[20])
    var
        EMailLog: Record "CDO E-Mail Log";
        EmailTemplateLine: Record "CDO E-Mail Template Line";
    begin
        // Reuse a fixed code per test, but drop everything the previous committed run of this
        // same test left behind, so the log entries a test asserts on are only its own.
        EMailLog.SetRange("E-Mail Template Code", TemplateCode);
        EMailLog.DeleteAll();
        if EmailTemplateHeader.Get(TemplateCode) then
            EmailTemplateHeader.Delete(true);

        EmailTemplateHeader.Init();
        EmailTemplateHeader.Code := TemplateCode;
        EmailTemplateHeader."Report-ID" := Report::"Standard Statement";
        EmailTemplateHeader."Linked To" := CDOLinkedToTable::Customer;
        EmailTemplateHeader."Linked To Field No." := 1;
        EmailTemplateHeader."Use reports for email attachm." := true;
        EmailTemplateHeader.Insert();

        EmailTemplateLine.Init();
        EmailTemplateLine."E-Mail Template Code" := EmailTemplateHeader.Code;
        EmailTemplateLine."Language Code" := '';
        EmailTemplateLine.Enabled := true;
        EmailTemplateLine."File Name" := 'Statement_%1';
        EmailTemplateLine.Insert();
    end;

    local procedure AttachAutomaticDocument(var Customer: Record Customer; AutomaticDocumentCode: Code[10])
    begin
        Customer."CDO Automatic statement" := Customer."CDO Automatic statement"::Automatic;
        Customer."CDO Automatic Documents" := AutomaticDocumentCode;
        Customer.Modify();
    end;

    local procedure SetupLegacyCustomer(var Customer: Record Customer; SendStatementCode: Code[10])
    begin
        Customer."CDO Automatic statement" := Customer."CDO Automatic statement"::Automatic;
        Customer."CDO Send Statement Code" := SendStatementCode;
        Customer."CDO Last Automatic Date" := CalcDate('<-2M>', WorkDate());
        Customer.Modify();
    end;

    local procedure SetCustomerEntryDueDate(var Customer: Record Customer; IsOpen: Boolean; IsPositive: Boolean; DueDate: Date)
    var
        CustLedgerEntry: Record "Cust. Ledger Entry";
    begin
        CustLedgerEntry.SetRange("Customer No.", Customer."No.");
        CustLedgerEntry.FindSet();
        repeat
            CustLedgerEntry.Open := IsOpen;
            CustLedgerEntry.Positive := IsPositive;
            CustLedgerEntry."Due Date" := DueDate;
            CustLedgerEntry.Modify();
        until CustLedgerEntry.Next() = 0;
    end;

    local procedure MockExtraDetailedEntry(var Customer: Record Customer; Amount: Decimal; PostingDate: Date)
    var
        CustLedgerEntry: Record "Cust. Ledger Entry";
        DetailedCustLedgEntry: Record "Detailed Cust. Ledg. Entry";
    begin
        LibrarySales.MockCustLedgerEntry(CustLedgerEntry, Customer."No.");
        CustLedgerEntry."Posting Date" := PostingDate;
        CustLedgerEntry.Modify();

        LibrarySales.MockDetailedCustLedgEntry(CustLedgerEntry);
        DetailedCustLedgEntry.SetRange("Cust. Ledger Entry No.", CustLedgerEntry."Entry No.");
        if DetailedCustLedgEntry.FindFirst() then begin
            DetailedCustLedgEntry.Amount := Amount;
            DetailedCustLedgEntry."Amount (LCY)" := Amount;
            DetailedCustLedgEntry."Posting Date" := PostingDate;
            DetailedCustLedgEntry."Initial Entry Due Date" := CalcDate('<+CM>', PostingDate);
            DetailedCustLedgEntry.Modify();
        end;
    end;

    local procedure MockPeriodStatementLog(EmailTemplateCode: Code[20]; CustomerNo: Code[20]; PlannedSendingDate: Date; LogDate: Date)
    var
        EMailLog: Record "CDO E-Mail Log";
    begin
        MockEMailLog(EmailTemplateCode, Database::Customer, CustomerNo, EMailLog."Document Type"::"Period Statement", PlannedSendingDate, LogDate);
    end;

    local procedure MockEMailLog(EmailTemplateCode: Code[20]; TableNo: Integer; PrimaryKeyFieldValue: Text; DocumentType: Option; PlannedSendingDate: Date; LogDate: Date)
    var
        EMailLog: Record "CDO E-Mail Log";
        LastEMailLog: Record "CDO E-Mail Log";
    begin
        LastEMailLog.Reset();
        if LastEMailLog.FindLast() then;

        EMailLog.Init();
        EMailLog."Entry No." := LastEMailLog."Entry No." + 1;
        EMailLog."E-Mail Template Code" := EmailTemplateCode;
        EMailLog."Table No." := TableNo;
        EMailLog."Primary Key Field 1 Value" := CopyStr(PrimaryKeyFieldValue, 1, MaxStrLen(EMailLog."Primary Key Field 1 Value"));
        EMailLog."Document Type" := DocumentType;
        EMailLog."Planned Sending Date" := PlannedSendingDate;
        EMailLog."Date Time" := CreateDateTime(LogDate, 0T);
        EMailLog.Insert();
    end;

    local procedure FindStatementJournalLine(var StatementJournalLine: Record "CDO Statement Journal Line"; CustomerNo: Code[20])
    begin
        StatementJournalLine.Reset();
        StatementJournalLine.SetRange("Customer No.", CustomerNo);
        Assert.IsTrue(StatementJournalLine.FindLast(), 'A statement journal line should exist');
    end;

    #endregion
}
