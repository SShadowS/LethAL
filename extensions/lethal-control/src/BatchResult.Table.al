namespace LethAL.Control;

/// <summary>R69: per-row results of the in-session batch loop (codeunit 71013). "Result Json" is a
/// Blob because per-method JSON can exceed Text[2048]; expose it through SetResultJson/GetResultJson
/// rather than the field directly. DataPerCompany=false, matching "LC Batch Queue".</summary>
table 71012 "LC Batch Result"
{
    DataClassification = SystemMetadata;
    DataPerCompany = false;
    // Same rationale as "LC Mutation Active": the OData runner session runs under the calling user
    // (5C-A spike finding), so inherent data permissions let the control state read/write this table
    // regardless of assigned permission sets.
    InherentPermissions = RIMD;

    fields
    {
        field(1; "Line No."; Integer) { }
        field(2; "Codeunit ID"; Integer) { }
        field(3; Method; Text[128]) { }
        field(4; Ok; Boolean) { }
        field(5; Attested; Boolean) { }
        field(6; "Result Json"; Blob) { }
        field(7; "Error Text"; Text[2048]) { }
        // R69 Task 0a: the per-row coverage payload — {coverage, coverageScannedRows,
        // coverageEmittedRows}, written by "LC Batch Runner".RunBatch — mirroring "Result Json" as
        // a Blob because the serialized coverage array can exceed Text[2048], exposed only through
        // SetCoverageJson/GetCoverageJson rather than the field directly.
        field(10; "Coverage Json"; Blob) { }
    }

    keys
    {
        key(PK; "Line No.") { Clustered = true; }
    }

    procedure SetResultJson(NewJson: Text)
    var
        OStr: OutStream;
    begin
        "Result Json".CreateOutStream(OStr, TextEncoding::UTF8);
        OStr.WriteText(NewJson);
    end;

    procedure GetResultJson(): Text
    var
        IStr: InStream;
        Result: Text;
    begin
        CalcFields("Result Json");
        if not "Result Json".HasValue then
            exit('');
        "Result Json".CreateInStream(IStr, TextEncoding::UTF8);
        IStr.ReadText(Result);
        exit(Result);
    end;

    procedure SetCoverageJson(NewJson: Text)
    var
        OStr: OutStream;
    begin
        "Coverage Json".CreateOutStream(OStr, TextEncoding::UTF8);
        OStr.WriteText(NewJson);
    end;

    procedure GetCoverageJson(): Text
    var
        IStr: InStream;
        Result: Text;
    begin
        CalcFields("Coverage Json");
        if not "Coverage Json".HasValue then
            exit('');
        "Coverage Json".CreateInStream(IStr, TextEncoding::UTF8);
        IStr.ReadText(Result);
        exit(Result);
    end;
}
