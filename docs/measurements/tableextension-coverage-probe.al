table 79480 "LX Base"
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; "Total"; Integer) { }
    }
    keys { key(PK; "No.") { Clustered = true; } }

    procedure BaseBump()
    begin
        "Total" += 1;
    end;
}

tableextension 79481 "LX Base Ext" extends "LX Base"
{
    fields
    {
        field(50; "ExtValue"; Integer) { }
    }

    // The code whose coverage attribution we are measuring.
    procedure ExtBump()
    begin
        "ExtValue" += 7;
    end;
}

codeunit 79482 "LX Driver"
{
    procedure Drive(var Rec: Record "LX Base")
    begin
        Rec.BaseBump();
        Rec.ExtBump();
    end;
}

codeunit 79483 "LX Tests"
{
    Subtype = Test;
    TestPermissions = Disabled;

    [Test]
    procedure ExercisesBaseAndExtension()
    var
        Rec: Record "LX Base";
        Driver: Codeunit "LX Driver";
    begin
        Rec.Init();
        Rec."No." := 'A';
        Driver.Drive(Rec);
    end;
}
