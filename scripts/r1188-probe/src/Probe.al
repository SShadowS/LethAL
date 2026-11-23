// R1188 probe (PR-366). Invented names only. Each shape mirrors one BaseApp field al-runner refuses on DO, by the condition
// upstream 1bea5bc7a's gate (no_field_measured) fails for it; the control is a shape that gate measured (al-runner answers 0).
// Every test ends in Error('MEASURED ...') so the value travels out on both runtimes (a red test here is the data, not a fault).

table 91500 "R1188 Target Code"
{
    fields
    {
        field(1; "Code"; Code[20]) { }
        field(2; Description; Text[50]) { }
    }
    keys { key(PK; "Code") { Clustered = true; } }
}

// Like Post Code: a two-field key of Code and Text.
table 91501 "R1188 Target Code Text"
{
    fields
    {
        field(1; "Code"; Code[20]) { }
        field(2; City; Text[30]) { }
    }
    keys { key(PK; "Code", City) { Clustered = true; } }
}

// Like Dimension Set Entry: a two-field key of Integer and Code.
table 91502 "R1188 Target Int Code"
{
    fields
    {
        field(1; "Set No."; Integer) { }
        field(2; "Item Code"; Code[20]) { }
    }
    keys { key(PK; "Set No.", "Item Code") { Clustered = true; } }
}

// Shape A, like Dimension Code of Dimension Set Entry: the related field is INSIDE its own table's primary key.
table 91503 "R1188 Keyed Source"
{
    fields
    {
        field(1; "Set No."; Integer) { }
        field(2; "Item Code"; Code[20]) { TableRelation = "R1188 Target Code"; }
    }
    keys { key(PK; "Set No.", "Item Code") { Clustered = true; } }
}

table 91504 "R1188 Source"
{
    fields
    {
        field(1; Id; Integer) { }
        // Control: a measured shape (Code[20] to a one-field Code[20] key, outside the key): al-runner answers 0.
        field(2; "Plain Code"; Code[20]) { TableRelation = "R1188 Target Code"; }
        // Shape B, like Ship-to Post Code: Code[20] to a (Code, Text) key.
        field(3; "Post Code Like"; Code[20]) { TableRelation = "R1188 Target Code Text"; ValidateTableRelation = false; }
        // Shape C, like Dimension Set ID: Integer to an (Integer, Code) key.
        field(4; "Set ID Like"; Integer) { TableRelation = "R1188 Target Int Code"; }
        // For the Integer-to-Date conversion routes.
        field(5; "On Date"; Date) { }
    }
    keys { key(PK; Id) { Clustered = true; } }
}

codeunit 91510 "R1188 Shapes Tests"
{
    Subtype = Test;

    local procedure Report(TableNo: Integer; FieldNo: Integer)
    var
        F: Record Field;
    begin
        F.Get(TableNo, FieldNo);
        Error('MEASURED table=%1 field=%2 RelationTableNo=%3 RelationFieldNo=%4', TableNo, FieldNo, F.RelationTableNo, F.RelationFieldNo);
    end;

    [Test]
    procedure ControlMeasuredShape()
    begin
        Report(Database::"R1188 Source", 2);
    end;

    [Test]
    procedure ShapeA_FieldInsideItsOwnKey()
    begin
        Report(Database::"R1188 Keyed Source", 2);
    end;

    [Test]
    procedure ShapeB_CodeToCodeTextKey()
    begin
        Report(Database::"R1188 Source", 3);
    end;

    [Test]
    procedure ShapeC_IntegerToIntegerCodeKey()
    begin
        Report(Database::"R1188 Source", 4);
    end;

    [Test]
    procedure IntegerToDateThroughVariant()
    var
        V: Variant;
        D: Date;
    begin
        V := 20240101;
        D := V;
        Error('MEASURED converted=%1', D);
    end;

    [Test]
    procedure IntegerToDateThroughFieldRefValue()
    var
        RR: RecordRef;
        FR: FieldRef;
    begin
        RR.Open(Database::"R1188 Source");
        FR := RR.Field(5);
        FR.Value := 20240101;
        Error('MEASURED value=%1', FR.Value);
    end;

    [Test]
    procedure IntegerToDateThroughSetRange()
    var
        R: Record "R1188 Source";
        FR: FieldRef;
        RR: RecordRef;
    begin
        RR.Open(Database::"R1188 Source");
        FR := RR.Field(5);
        FR.SetRange(20240101);
        Error('MEASURED filter=%1', FR.GetFilter());
    end;

    [Test]
    procedure IntegerToDateThroughValidateVariant()
    var
        R: Record "R1188 Source";
        V: Variant;
    begin
        V := 20240101;
        R.Validate("On Date", V);
        Error('MEASURED value=%1', R."On Date");
    end;
}
