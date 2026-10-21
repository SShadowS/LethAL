namespace LethAL.R389Probe;

/// <summary>An external codeunit UNRELATED to the test app's mock. Route R4a/R4b assign the
/// Variant (holding the test-app mock) to a variable of THIS type. If BC lets that through, a call
/// on the variable shows which code actually ran: this codeunit's text, or the mock's MARK.</summary>
codeunit 91501 "R389 Probe Helper"
{
    trigger OnRun()
    begin
        Error('MEASURED ran the EXTERNAL helper OnRun, not the mock');
    end;

    procedure Echo(Route: Text): Text
    begin
        exit(StrSubstNo('MEASURED %1 ran the EXTERNAL helper Echo, not the mock', Route));
    end;
}
