namespace LethAL.R389Probe.Tests;

using LethAL.R389Probe;

/// <summary>R3's control: the external app hands the Variant BACK to test-app code by an event.
/// Test-app code can name the mock's type, so it can run it. Only R3 raises this event.</summary>
codeunit 91531 "R389 Probe Subscriber"
{
    [EventSubscriber(ObjectType::Codeunit, Codeunit::"R389 Probe Routes", OnR389HandBack, '', false, false)]
    local procedure HandBack(V: Variant)
    var
        Mock: Codeunit "R389 Probe Mock";
    begin
        if not V.IsCodeunit() then
            Error('MEASURED R3 subscriber got a Variant with IsCodeunit = false');
        Mock := V;
        Mock.Ping('R3 (test-app subscriber)');
    end;
}
