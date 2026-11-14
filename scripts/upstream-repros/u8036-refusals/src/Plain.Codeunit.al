// R-983: one test per refusal cause met under mutation; each test does what BC does without error, or expects BC's error
// with asserterror (only that an error is raised, never its text).
codeunit 50510 "Plain Refusal Repros"
{
    Subtype = Test;

    [Test]
    procedure OutStreamNeverCreated()
    var
        OutS: OutStream;
    begin
        asserterror OutS.WriteText('a');
    end;

    [Test]
    procedure XmlElementEmptyName()
    var
        E: XmlElement;
    begin
        asserterror E := XmlElement.Create('');
    end;

    [Test]
    procedure UnassignedXmlElement()
    var
        E: XmlElement;
        Child: XmlElement;
    begin
        Child := XmlElement.Create('c');
        asserterror E.Add(Child);
    end;

    [Test]
    procedure EvaluateDateRangeText()
    var
        D: Date;
    begin
        if Evaluate(D, '11..NOW') then;
    end;

    [Test]
    procedure EvaluateTimeRangeText()
    var
        T: Time;
    begin
        if Evaluate(T, '11:11:11..NOW') then;
    end;

    [Test]
    procedure IsolatedStorageGetMissingGuidKeyStatement()
    var
        V: Text;
    begin
        asserterror IsolatedStorage.Get(Format(CreateGuid()), DataScope::Module, V);
    end;

    [Test]
    procedure RecordRefReadPermissionNotOpen()
    var
        R: RecordRef;
    begin
        asserterror if R.ReadPermission() then;
    end;

    [Test]
    procedure SetFilterEmptyTerm()
    var
        Row: Record "Repro Row";
    begin
        Row.SetFilter("Code", 'A|');
        if Row.IsEmpty() then;
    end;

    [Test]
    procedure DateTimeBefore1753InTable()
    var
        Row: Record "Repro Row";
    begin
        Row."Code" := 'D';
        Row.Stamp := CreateDateTime(17530101D, 120000T);
        Row.Insert();
    end;

    [Test]
    procedure NormalDateOfUndefinedDate()
    var
        D: Date;
    begin
        // BC: NormalDate(0D) is 0D
        if NormalDate(D) <> 0D then
            Error('NormalDate(0D) is not 0D');
    end;

    [Test]
    procedure InStreamUntouchedHandle()
    var
        InS: InStream;
        T: Text;
    begin
        asserterror InS.ReadText(T);
    end;
}
