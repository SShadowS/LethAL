namespace NstRepro04;

// Exposed as OData V4 web service "NstRepro04":
// POST <base>/ODataV4/NstRepro04_<Procedure>?company=...&tenant=...
codeunit 91640 "NST Repro04 API"
{
    // A slow action: a CPU loop bounded by Ms. No database I/O.
    procedure Slow(Ms: Integer): Text
    var
        T0: DateTime;
        Spin: BigInteger;
    begin
        T0 := CurrentDateTime();
        while CurrentDateTime() - T0 < Ms do
            Spin += 1;
        exit(StrSubstNo('done session=%1', SessionId()));
    end;

    procedure Ping(): Text
    begin
        exit(StrSubstNo('pong session=%1', SessionId()));
    end;
}
