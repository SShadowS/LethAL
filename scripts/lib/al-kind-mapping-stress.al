namespace Probe.Grammar.Stress;

using System.Utilities;

codeunit 50001 "Tricky Fixture" implements "Tricky Interface"
{
    Access = Internal;

    var
        Lbl: Label 'Total %1', Comment = '%1 = amount', Locked = false;

    [Test]
    [HandlerFunctions('NoHandler')]
    procedure AttributedProcedure(A: Integer; B: Integer)
    begin
        if A > B then
            Message(Lbl, A + B);
    end;

#if CLEAN25
    procedure BehindDirective(A: Integer; B: Integer): Integer
    begin
        exit(A * B);
    end;
#else
    procedure BehindDirective(A: Integer; B: Integer): Integer
    begin
        exit(A - B);
    end;
#endif

    procedure EnumAndCase(V: Enum "Tricky Kind"; A: Integer): Integer
    begin
        case V of
            V::First:
                exit(A + 1);
            V::Second, V::Third:
                exit(A - 1);
            else
                exit(A DIV 2);
        end;
    end;

    procedure ListAndForeach(Nums: List of [Integer]) Total: Integer
    var
        N: Integer;
    begin
        foreach N in Nums do
            if N > 0 then
                Total += N * 2;
    end;

    local procedure Guarded(A: Integer): Boolean
    begin
        exit((A > 0) and (A < 100) or not (A = 50));
    end;

    procedure NoHandler()
    begin
    end;
}
