report 51820 "QCP With Query Close"
{
    ProcessingOnly = true;

    requestpage
    {
        layout
        {
            area(Content)
            {
                field(EndingDateField; EndingDate)
                {
                    Caption = 'Ending Date';
                    trigger OnValidate()
                    begin
                        if EndingDate = 0D then
                            Error('You must specify an ending date.');
                    end;
                }
            }
        }

        // as Date Compress Insurance Ledger (report 5697): answers false on OK unless a confirm says yes
        trigger OnQueryClosePage(CloseAction: Action): Boolean
        begin
            if CloseAction = Action::Cancel then
                exit;
            exit(Answer);
        end;
    }

    var
        EndingDate: Date;
        Answer: Boolean;
}

report 51821 "QCP Without Query Close"
{
    ProcessingOnly = true;

    requestpage
    {
        layout
        {
            area(Content)
            {
                field(EndingDateField; EndingDate)
                {
                    Caption = 'Ending Date';
                    trigger OnValidate()
                    begin
                        if EndingDate = 0D then
                            Error('You must specify an ending date.');
                    end;
                }
            }
        }
    }

    var
        EndingDate: Date;
}

codeunit 51822 "QCP Tests With"
{
    Subtype = Test;

    [Test]
    [HandlerFunctions('WithHandler')]
    procedure HandlerErrorWithQueryClose() // BC: passes (the OnValidate error leaves the handler and reaches asserterror)
    begin
        asserterror Report.Run(Report::"QCP With Query Close");
        if StrPos(GetLastErrorText(), 'You must specify an ending date.') = 0 then
            Error('last error: %1', GetLastErrorText());
    end;

    [RequestPageHandler]
    procedure WithHandler(var RP: TestRequestPage "QCP With Query Close")
    begin
        RP.EndingDateField.SetValue(0D);
        RP.OK().Invoke();
    end;
}

codeunit 51823 "QCP Tests Without"
{
    Subtype = Test;

    [Test]
    [HandlerFunctions('WithoutHandler')]
    procedure HandlerErrorWithoutQueryClose() // control: no OnQueryClosePage (BC: passes)
    begin
        asserterror Report.Run(Report::"QCP Without Query Close");
        if StrPos(GetLastErrorText(), 'You must specify an ending date.') = 0 then
            Error('last error: %1', GetLastErrorText());
    end;

    [RequestPageHandler]
    procedure WithoutHandler(var RP: TestRequestPage "QCP Without Query Close")
    begin
        RP.EndingDateField.SetValue(0D);
        RP.OK().Invoke();
    end;
}
