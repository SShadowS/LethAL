namespace Contoso.Utilities;

using Contoso.Foundation.Enums;

codeunit 58101 "Probe User"
{
    procedure Pick(Kind: Integer): Integer
    begin
        case Contoso.Foundation.Enums."Probe Kind".FromInteger(Kind) of
            "Probe Kind"::B:
                exit(2);
        end;
        exit(1);
    end;
}
