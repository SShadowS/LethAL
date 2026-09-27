namespace NstRepro01;

// Exposed as OData V4 web service "NstRepro01", so each procedure is an unbound action:
// POST <base>/ODataV4/NstRepro01_<Procedure>?company=...&tenant=...
codeunit 91600 "NST Repro01 API"
{
    // Runs ONE test method of codeunit "NST Repro01 Tests" through the platform test runner, inside
    // a catchable Codeunit.Run boundary, and returns the runner's result JSON wrapped in a small
    // envelope. PadTo > 0 pads the answer with a 'pad' field up to about PadTo characters, so a
    // passing test can return an answer the same size as the failing TestPage one.
    procedure RunTest(TestMethod: Text; PadTo: Integer) Answer: Text
    var
        Runner: Codeunit "NST Repro01 Runner";
        Obj: JsonObject;
        Results: Text;
        Ok: Boolean;
    begin
        Runner.SetTestMethod(TestMethod);
        Ok := Runner.Run();
        if Ok then
            Results := Runner.Results()
        else
            Results := GetLastErrorText();
        Obj.Add('testMethod', TestMethod);
        Obj.Add('runOk', Ok);
        Obj.Add('sessionId', SessionId());
        Obj.Add('results', Results);
        Obj.WriteTo(Answer);
        // ,"pad":"" adds 9 characters before any padding.
        if StrLen(Answer) + 9 < PadTo then begin
            Obj.Add('pad', PadStr('', PadTo - StrLen(Answer) - 9, 'x'));
            Obj.WriteTo(Answer);
        end;
    end;

    // Trivial action for the health check after each call.
    procedure Ping(): Text
    begin
        exit(StrSubstNo('pong session=%1', SessionId()));
    end;
}
