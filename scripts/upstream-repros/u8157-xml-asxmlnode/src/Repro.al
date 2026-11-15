// Upstream #8157 (PR-31). Invented repro, no corpus source text. XmlElement.AsXmlNode() on an XmlElement nothing created. Measured on BC 28.4
// W1 (the dev endpoint's test runner, 2026-11-15): the call returns without an error, so the test passes. The sibling calls on
// the same untouched element (InnerXml, GetChildElements, SetAttribute) fail on BC with "Nav<X> variable not initialized."
codeunit 51621 "AsXmlNode Untouched"
{
    Subtype = Test;

    [Test]
    procedure Cell()
    var
        E: XmlElement;
        N: XmlNode;
    begin
        N := E.AsXmlNode();
    end;
}
