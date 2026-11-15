// Invented repro for aldevtools/BusinessCentral.AL.Runner#8036 item 1 (a member of a DotNet variable that holds no object),
// over .NET types the issue does not name, found by PR-02's generator (scripts/refusal-family.ts, family dotnet-no-object).
// One test per codeunit, so a refusal cannot cascade. Each access is under asserterror: on BC it raises an error.
dotnet
{
    assembly(mscorlib)
    {
        type(System.Text.StringBuilder; ReproStringBuilder) { }
        type(System.IO.MemoryStream; ReproMemoryStream) { }
        type(System.Text.Encoding; ReproEncoding) { }
    }
    assembly(System)
    {
        type(System.Text.RegularExpressions.Regex; ReproRegex) { }
    }
    assembly(System.Xml)
    {
        type(System.Xml.XmlDocument; ReproXmlDocument) { }
    }
}

codeunit 51201 "No Object StringBuilder Append"
{
    Subtype = Test;
    [Test]
    procedure Cell()
    var
        SB: DotNet ReproStringBuilder;
    begin
        asserterror SB.Append('x');
    end;
}

codeunit 51202 "No Object MemoryStream Length"
{
    Subtype = Test;
    [Test]
    procedure Cell()
    var
        MS: DotNet ReproMemoryStream;
        L: BigInteger;
    begin
        asserterror L := MS.Length;
    end;
}

codeunit 51203 "No Object Encoding WebName"
{
    Subtype = Test;
    [Test]
    procedure Cell()
    var
        EN: DotNet ReproEncoding;
        T: Text;
    begin
        asserterror T := EN.WebName;
    end;
}

codeunit 51204 "No Object XmlDocument OuterXml"
{
    Subtype = Test;
    [Test]
    procedure Cell()
    var
        XD: DotNet ReproXmlDocument;
        T: Text;
    begin
        asserterror T := XD.OuterXml;
    end;
}

// al-runner gives this one a wrong text ("no overload taking 1 argument(s)"); on a constructed Regex the call passes.
codeunit 51205 "No Object Regex IsMatch"
{
    Subtype = Test;
    [Test]
    procedure Cell()
    var
        RX: DotNet ReproRegex;
        B: Boolean;
    begin
        asserterror B := RX.IsMatch('a');
    end;
}
