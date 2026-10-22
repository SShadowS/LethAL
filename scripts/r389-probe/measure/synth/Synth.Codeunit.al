codeunit 50200 "Synth Tests"
{
    Subtype = Test;

    var
        GlobalV: Variant;

    [Test]
    procedure FromMock()
    var
        V: Variant;
        Mock: Codeunit "Synth Mock";
        Ext: Codeunit "Ext Runner";
    begin
        V := Mock;
        Ext.Go(V);
    end;

    [Test]
    procedure FromRecord()
    var
        V: Variant;
        Cust: Record Customer;
        Ext: Codeunit "Ext Runner";
    begin
        V := Cust;
        Ext.Go(V);
    end;

    [Test]
    procedure ViaHelperParam()
    var
        Mock: Codeunit "Synth Mock";
    begin
        PassOn(Mock);
    end;

    [Test]
    procedure FromGlobal()
    var
        Ext: Codeunit "Ext Runner";
    begin
        Ext.Go(GlobalV);
    end;

    [Test]
    procedure FromInterface()
    var
        V: Variant;
        I: Interface "Synth Iface";
        Mock: Codeunit "Synth Mock";
        Ext: Codeunit "Ext Runner";
    begin
        I := Mock;
        V := I;
        Ext.Go(V);
    end;

    [Test]
    procedure ViaVarArg()
    var
        V: Variant;
        Ext: Codeunit "Ext Runner";
    begin
        Fill(V);
        Ext.Go(V);
    end;

    [Test]
    procedure ChainOfVariants()
    var
        V: Variant;
        W: Variant;
        Mock: Codeunit "Synth Mock";
        Ext: Codeunit "Ext Runner";
    begin
        W := Mock;
        V := W;
        Ext.Go(V);
    end;

    [Test]
    procedure ReturnedVariant()
    var
        V: Variant;
        Ext: Codeunit "Ext Runner";
    begin
        V := MakeVariant();
        Ext.Go(V);
    end;

    [Test]
    procedure ElementOfList()
    var
        L: List of [Variant];
        Ext: Codeunit "Ext Runner";
    begin
        Ext.Go(L.Get(1));
    end;

    local procedure PassOn(P: Variant)
    var
        Ext: Codeunit "Ext Runner";
    begin
        Ext.Go(P);
    end;

    local procedure Fill(var X: Variant)
    var
        Mock: Codeunit "Synth Mock";
    begin
        X := Mock;
    end;

    local procedure MakeVariant(): Variant
    var
        Mock: Codeunit "Synth Mock";
    begin
        exit(Mock);
    end;
}

codeunit 50201 "Synth Mock" implements "Synth Iface"
{
    var
        GlobalMockV: Variant;

    procedure Go()
    begin
    end;

    // r2: an Interface return value in a codeunit a test hands out (class bi).
    procedure GetInner(): Interface "Synth Iface"
    var
        Inner: Codeunit "Synth Mock";
    begin
        exit(Inner);
    end;

    // r2: a Variant return value, set by exit (class b: "Synth Inner").
    procedure GetAny(): Variant
    var
        Inner: Codeunit "Synth Inner";
    begin
        exit(Inner);
    end;

    // r2: a Variant var parameter set from a global (class c).
    procedure GetBad(var X: Variant)
    begin
        X := GlobalMockV;
    end;
}

codeunit 50203 "Synth Inner"
{
    procedure Go()
    begin
    end;
}

codeunit 50204 "Synth Subscriber"
{
    // r2: a Variant var parameter set to a test-app codeunit, in a subscriber (class b, closure).
    [EventSubscriber(ObjectType::Codeunit, Codeunit::"Ext Runner", 'OnGetHandler', '', false, false)]
    local procedure OnGetHandler(var Handler: Variant)
    var
        HandlerMock: Codeunit "Synth Handler Mock";
    begin
        Handler := HandlerMock;
    end;

    // r2: an Interface var parameter, in a subscriber (class bi, closure).
    [EventSubscriber(ObjectType::Codeunit, Codeunit::"Ext Runner", 'OnGetImpl', '', false, false)]
    local procedure OnGetImpl(var Impl: Interface "Synth Sub Iface")
    var
        SubImpl: Codeunit "Synth Sub Impl";
    begin
        Impl := SubImpl;
    end;
}

codeunit 50205 "Synth Handler Mock"
{
    procedure Go()
    begin
    end;
}

codeunit 50206 "Synth Sub Impl" implements "Synth Sub Iface"
{
    procedure Run()
    begin
    end;
}

interface "Synth Sub Iface"
{
    procedure Run();
}

enum 50207 "Synth Kind" implements "Synth Sub Iface"
{
    value(0; Default)
    {
        Implementation = "Synth Sub Iface" = "Synth Enum Impl";
    }
}

codeunit 50208 "Synth Enum Impl" implements "Synth Sub Iface"
{
    procedure Run()
    begin
    end;

    // r2: a NAMED Variant return value, in an enum's implementation codeunit (class b, closure).
    procedure GetNamed() R: Variant
    var
        EnumInner: Codeunit "Synth Inner";
    begin
        R := EnumInner;
    end;
}

interface "Synth Iface"
{
    procedure Go();
}
