// People.al
namespace Repro.People;

using Repro.Address;

enum 51780 "R3 Account Type"
{
    value(0; "G/L Account") { }
    value(1; Customer) { }
}

table 51801 "R4 Person"
{
    fields
    {
        field(1; "No."; Integer) { }
        field(2; "Country"; Code[10]) { }
        field(3; City; Text[30])
        {
            TableRelation = if ("Country" = const('')) "R4 Post Code".City
            else
            if ("Country" = filter(<> '')) "R4 Post Code".City where("Country" = field("Country"));
        }
        field(4; CityQualified; Text[30])
        {
            TableRelation = if ("Country" = const('')) Repro.Address."R4 Post Code".City
            else
            if ("Country" = filter(<> '')) Repro.Address."R4 Post Code".City where("Country" = field("Country"));
        }
        field(5; "IC Account Type"; Enum "R3 IC Account Type") { }
        field(6; "Account Type"; Enum "R3 Account Type") { }
        field(7; "One Arm"; Code[20])
        {
            TableRelation = if ("IC Account Type" = const("G/L Account")) "R4 Post Code"."Code";
        }
        field(8; "One Arm Local Enum"; Code[20])
        {
            TableRelation = if ("Account Type" = const(Customer)) "R4 Post Code"."Code";
        }
    }
    keys { key(PK; "No.") { Clustered = true; } }
}
