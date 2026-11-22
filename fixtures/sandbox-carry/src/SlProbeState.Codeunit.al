codeunit 71760 "SL Probe State"
{
    // PR-327 (GitHub #53, invented shape): a SingleInstance flag. A mutant that empties EndIt leaves the flag set for
    // the rest of the session.
    SingleInstance = true;

    var
        InMode: Boolean;

    procedure BeginIt()
    begin
        InMode := true;
    end;

    procedure EndIt()
    begin
        InMode := false;
    end;

    procedure IsSet(): Boolean
    begin
        exit(InMode);
    end;
}
