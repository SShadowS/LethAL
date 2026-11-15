// PR-28 (#8013, "a file name, got Guid"): File.Create with a Guid as the name (AL converts it to text), then a write. Invented; no
// corpus text. OnPrem. On BC the server creates a file of that name in its working folder and the test passes (inferred, not
// measured).
codeunit 51511 "U8013 File Guid Tests"
{
    Subtype = Test;

    [Test]
    procedure FileCreateWithGuidName()
    var
        F: File;
        O: OutStream;
    begin
        F.Create(CreateGuid());
        F.CreateOutStream(O);
        O.WriteText('x');
        F.Close();
    end;
}
