namespace Repro.Tests;

using Repro.Setup;
using Repro.Assets;

codeunit 51692 "Repro Relation Tests"
{
    Subtype = Test;

    [Test]
    procedure ValidateUsingName() // BC: passes (the group exists; the name resolves through `using`)
    var
        G: Record "Repro Posting Group";
        H: Record "Repro Holder";
    begin
        G.Code := 'A';
        G.Insert();
        H."No." := 1;
        H.Validate("Group", 'A');
    end;

    [Test]
    procedure ValidateFullName() // BC: passes (namespace-qualified target)
    var
        G: Record "Repro Posting Group";
        H: Record "Repro Holder";
    begin
        G.Code := 'B';
        G.Insert();
        H."No." := 2;
        H.Validate("Group Full", 'B');
    end;

    [Test]
    procedure ValidateSameNamespace() // control: target in the holder's own namespace (BC: passes)
    var
        G: Record "Repro Local Group";
        H: Record "Repro Local Holder";
    begin
        G.Code := 'C';
        G.Insert();
        H."No." := 3;
        H.Validate("Group", 'C');
    end;
}
