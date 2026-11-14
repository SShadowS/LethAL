dotnet
{
    assembly(System.IO.Compression)
    {
        type(System.IO.Compression.ZipArchive; ReproZipArchive) { }
        type(System.IO.Compression.ZipArchiveMode; ReproZipArchiveMode) { }
    }
    assembly(System.Data)
    {
        type(System.Data.DataTable; ReproDataTable) { }
        type(System.Data.DataRow; ReproDataRow) { }
    }
    assembly(Newtonsoft.Json)
    {
        type(Newtonsoft.Json.Linq.JArray; ReproJArray) { }
    }
}

codeunit 50530 "DotNet Refusal Repros 2"
{
    Subtype = Test;

    [Test]
    procedure UriAbsoluteUriConstructed()
    var
        U: DotNet ReproUri;
    begin
        U := U.Uri('https://example.com/a?b=1');
        if U.AbsoluteUri <> 'https://example.com/a?b=1' then
            Error('AbsoluteUri is %1', U.AbsoluteUri);
    end;

    [Test]
    procedure CultureInfoUnknownName()
    var
        C: DotNet ReproCultureInfo;
    begin
        asserterror C := C.CultureInfo('xx-NOTACULTURE-zz');
    end;
}

codeunit 50531 "DotNet Refusal Repros 3"
{
    Subtype = Test;

    [Test]
    procedure ZipArchiveEntriesNoObject()
    var
        Z: DotNet ReproZipArchive;
    begin
        asserterror if Z.Entries.Count() = 0 then;
    end;

    [Test]
    procedure ZipArchiveOnTextStream()
    var
        Row: Record "Repro Blob" temporary;
        OutS: OutStream;
        InS: InStream;
        Z: DotNet ReproZipArchive;
        Mode: DotNet ReproZipArchiveMode;
    begin
        Row.Data.CreateOutStream(OutS);
        OutS.WriteText('this is not a zip file');
        Row.Insert();
        Row.Data.CreateInStream(InS);
        asserterror Z := Z.ZipArchive(InS, Mode.Read);
    end;

    [Test]
    procedure DataTableMissingRow()
    var
        T: DotNet ReproDataTable;
        R: DotNet ReproDataRow;
    begin
        T := T.DataTable();
        asserterror R := T.Rows.Item(1);
    end;

    [Test]
    procedure JArrayToStringNoObject()
    var
        A: DotNet ReproJArray;
        S: Text;
    begin
        asserterror S := A.ToString();
    end;
}
