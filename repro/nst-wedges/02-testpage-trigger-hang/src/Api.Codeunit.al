namespace NstRepro02;

// Exposed as OData V4 web service "NstRepro02":
// POST <base>/ODataV4/NstRepro02_RunTest?company=...&tenant=...
codeunit 91617 "NST Repro02 API"
{
    // Runs ONE test method through the platform test runner inside a catchable Codeunit.Run
    // boundary and returns the runner's result JSON plus the elapsed time.
    procedure RunTest(TestMethod: Text) Answer: Text
    var
        Runner: Codeunit "NST Repro02 Runner";
        Obj: JsonObject;
        T0: DateTime;
        Ok: Boolean;
    begin
        T0 := CurrentDateTime();
        Runner.SetTestMethod(TestMethod);
        Ok := Runner.Run();
        Obj.Add('testMethod', TestMethod);
        Obj.Add('runOk', Ok);
        Obj.Add('elapsedMs', CurrentDateTime() - T0);
        Obj.Add('sessionId', SessionId());
        if Ok then
            Obj.Add('results', Runner.Results())
        else
            Obj.Add('results', GetLastErrorText());
        Obj.WriteTo(Answer);
    end;

    procedure Ping(): Text
    begin
        exit(StrSubstNo('pong session=%1', SessionId()));
    end;
}
