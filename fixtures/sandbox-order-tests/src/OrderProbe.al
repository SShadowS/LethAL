table 77050 "Order Local Row"
{
    DataClassification = SystemMetadata;
    fields { field(1; Id; Integer) { } }
    keys { key(PK; Id) { Clustered = true; } }
}

codeunit 77053 "Order Local State"
{
    SingleInstance = true;
    var
        Mark: Text;

    procedure SetMark(T: Text)
    begin
        Mark := T;
    end;

    procedure GetMark(): Text
    begin
        if Mark = '' then exit('DEFAULT');
        exit(Mark);
    end;
}

codeunit 77051 "Order Reader"
{
    Subtype = Test;

    [Test]
    procedure ReadWorkDate()
    begin
        Error('WORKDATE=%1', Format(WorkDate(), 0, 9));
    end;

    [Test]
    procedure ReadLanguage()
    begin
        Error('LANGUAGE=%1', GlobalLanguage());
    end;

    [Test]
    procedure ReadRows()
    var
        R: Record "Order Local Row";
    begin
        Error('ROWS=%1', R.Count());
    end;

    [Test]
    procedure ReadMark()
    var
        S: Codeunit "Order Local State";
    begin
        Error('MARK=%1', S.GetMark());
    end;

    [Test]
    procedure ReadDepMark()
    var
        S: Codeunit "Order Dep State";
    begin
        Error('DEPMARK=%1', S.GetMark());
    end;

    [Test]
    procedure ReadDepRows()
    var
        R: Record "Order Dep Row";
    begin
        Error('DEPROWS=%1', R.Count());
    end;

    [Test]
    procedure ReadNumSeq()
    begin
        if not NumberSequence.Exists('ORDERSEQ') then
            Error('NUMSEQ=ABSENT');
        Error('NUMSEQ=PRESENT current=%1', NumberSequence.Current('ORDERSEQ'));
    end;

    [Test]
    procedure ReadIso()
    var
        V: Text;
    begin
        if not IsolatedStorage.Get('ORDERKEY', DataScope::Module, V) then
            Error('ISO=ABSENT');
        Error('ISO=%1', V);
    end;
}

codeunit 77052 "Order Writer"
{
    Subtype = Test;

    [Test]
    procedure SetWorkDate()
    begin
        WorkDate(DMY2Date(1, 1, 2001));
        if WorkDate() <> DMY2Date(1, 1, 2001) then Error('WORKDATE not set: %1', WorkDate());
    end;

    [Test]
    procedure SetLanguage()
    begin
        GlobalLanguage(1030);
        if GlobalLanguage() <> 1030 then Error('LANGUAGE not set: %1', GlobalLanguage());
    end;

    [Test]
    procedure InsertRow()
    var
        R: Record "Order Local Row";
    begin
        R.Id := 1;
        R.Insert();
        if R.Count() <> 1 then Error('ROWS not 1: %1', R.Count());
    end;

    [Test]
    procedure SetMark()
    var
        S: Codeunit "Order Local State";
    begin
        S.SetMark('WRITER');
        if S.GetMark() <> 'WRITER' then Error('MARK not set');
    end;

    [Test]
    procedure SetDepMark()
    var
        S: Codeunit "Order Dep State";
    begin
        S.SetMark('DEPWRITER');
        if S.GetMark() <> 'DEPWRITER' then Error('DEPMARK not set');
    end;

    [Test]
    procedure InsertDepRow()
    var
        R: Record "Order Dep Row";
    begin
        R.Id := 7;
        R.Insert();
        if R.Count() <> 1 then Error('DEPROWS not 1: %1', R.Count());
    end;

    [Test]
    procedure AdvanceNumSeq()
    var
        N: BigInteger;
    begin
        if not NumberSequence.Exists('ORDERSEQ') then
            NumberSequence.Insert('ORDERSEQ', 1000, 1);
        N := NumberSequence.Next('ORDERSEQ');
        N := NumberSequence.Next('ORDERSEQ');
        if NumberSequence.Current('ORDERSEQ') < 1001 then Error('NUMSEQ not advanced: %1', NumberSequence.Current('ORDERSEQ'));
    end;

    [Test]
    procedure SetIso()
    var
        V: Text;
    begin
        IsolatedStorage.Set('ORDERKEY', 'WRITERISO', DataScope::Module);
        if not IsolatedStorage.Get('ORDERKEY', DataScope::Module, V) then Error('ISO not set');
        if V <> 'WRITERISO' then Error('ISO wrong: %1', V);
    end;
}
