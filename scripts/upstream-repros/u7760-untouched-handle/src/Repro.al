// Invented repro for aldevtools/BusinessCentral.AL.Runner#7760's "untouched handle" family: the classes PR-01's generator
// (scripts/refusal-family.ts) found refused and not yet named in the issue. One test per codeunit, so a refusal cannot cascade.
codeunit 51101 "Untouched Xml InnerXml"
{
    Subtype = Test;
    [Test]
    procedure Cell()
    var
        E: XmlElement;
        T: Text;
    begin
        T := E.InnerXml();
    end;
}

codeunit 51102 "Untouched Xml SetAttribute"
{
    Subtype = Test;
    [Test]
    procedure Cell()
    var
        E: XmlElement;
    begin
        E.SetAttribute('a', 'b');
    end;
}

codeunit 51103 "Untouched Xml GetChildElements"
{
    Subtype = Test;
    [Test]
    procedure Cell()
    var
        E: XmlElement;
        L: XmlNodeList;
    begin
        L := E.GetChildElements();
    end;
}

codeunit 51104 "Untouched CopyStream"
{
    Subtype = Test;
    [Test]
    procedure Cell()
    var
        InS: InStream;
        OutS: OutStream;
    begin
        CopyStream(OutS, InS);
    end;
}
