// Invented repro for aldevtools/BusinessCentral.AL.Runner#7997, cause 2: FromBase64 with TextEncoding::UTF16 and code page 1252.
codeunit 79972 "R961 Base64 UTF16"
{
    Subtype = Test;

    [Test]
    procedure FromBase64Utf16()
    var
        Converter: Codeunit Base64Convert;
    begin
        // 'AB' in UTF-16 LE
        if Converter.FromBase64('QQBCAA==', TextEncoding::UTF16, 1252) <> 'AB' then
            Error('Wrong text');
    end;
}
