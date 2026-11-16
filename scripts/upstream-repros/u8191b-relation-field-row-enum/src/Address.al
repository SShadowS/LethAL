// Address.al
namespace Repro.Address;

table 51800 "R4 Post Code"
{
    fields
    {
        field(1; "Code"; Code[20]) { }
        field(2; City; Text[30]) { }
        field(3; "Country"; Code[10]) { }
    }
    keys { key(PK; "Code", City) { Clustered = true; } }
}

enum 51781 "R3 IC Account Type"
{
    value(0; "G/L Account") { }
    value(1; "Bank Account") { }
}
