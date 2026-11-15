// PR-32 (#7924, refusal family dotnet-exception): a .NET exception raised inside AL under asserterror alone, so the test's outcome
// does not depend on the exception's text. One test codeunit each, so a refusal's cascade cannot reach another. Invented; no corpus
// text. On BC each passes: asserterror passes on any error (inferred, not measured; the family's BC-check app measures it).
dotnet
{
    assembly(System)
    {
        type(System.Uri; U7924Uri) { }
        type(System.UriBuilder; U7924UriBuilder) { }
    }
    assembly(System.Data)
    {
        type(System.Data.DataTable; U7924DataTable) { }
        type(System.Data.DataRow; U7924DataRow) { }
    }
    assembly(mscorlib)
    {
        type(System.IO.MemoryStream; U7924MemoryStream) { }
        type(System.Text.Encoding; U7924Encoding) { }
    }
    assembly(System.Xml)
    {
        type(System.Xml.XmlTextWriter; U7924XmlTextWriter) { }
    }
}

codeunit 51591 "U7924 Data Row Index"
{
    Subtype = Test;

    [Test]
    procedure RowIndexOutOfRange()
    var
        Table: DotNet U7924DataTable;
        Row: DotNet U7924DataRow;
    begin
        Table := Table.DataTable();
        asserterror Row := Table.Rows.Item(0);
    end;
}

codeunit 51592 "U7924 Xml End Document"
{
    Subtype = Test;

    [Test]
    procedure EndDocumentWithoutRoot()
    var
        Stream: DotNet U7924MemoryStream;
        Enc: DotNet U7924Encoding;
        Writer: DotNet U7924XmlTextWriter;
    begin
        Stream := Stream.MemoryStream();
        Writer := Writer.XmlTextWriter(Stream, Enc.UTF8);
        asserterror Writer.WriteEndDocument();
    end;
}

codeunit 51593 "U7924 Uri Builder Port"
{
    Subtype = Test;

    [Test]
    procedure NegativePort()
    var
        Builder: DotNet U7924UriBuilder;
    begin
        Builder := Builder.UriBuilder('http://repro.example/');
        asserterror Builder.Port := -5;
    end;
}

codeunit 51594 "U7924 Uri Control"
{
    Subtype = Test;

    [Test]
    procedure InvalidUri()
    var
        Address: DotNet U7924Uri;
    begin
        // the control: System.Uri's exception, which al-runner pins
        asserterror Address := Address.Uri('not a uri');
    end;
}
