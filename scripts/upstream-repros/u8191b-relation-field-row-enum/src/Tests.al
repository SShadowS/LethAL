// Tests.al
namespace Repro.Tests;

using Repro.People;
using System.Reflection;

codeunit 51804 "R4 Field Row Tests"
{
    Subtype = Test;

    [Test]
    procedure FieldRowConditionalUsing() // BC: passes
    var
        F: Record Field;
    begin
        F.Get(Database::"R4 Person", 3);
    end;

    [Test]
    procedure FieldRowConditionalQualified() // control
    var
        F: Record Field;
    begin
        F.Get(Database::"R4 Person", 4);
    end;
}

codeunit 51805 "R4 Imported Enum Tests"
{
    Subtype = Test;

    [Test]
    procedure OneArmImportedEnumBlank() // BC: passes (a blank value)
    var
        P: Record "R4 Person";
    begin
        P."No." := 1;
        P.Validate("One Arm", '');
    end;

    [Test]
    procedure OneArmLocalEnumBlank() // control
    var
        P: Record "R4 Person";
    begin
        P."No." := 2;
        P.Validate("One Arm Local Enum", '');
    end;
}
