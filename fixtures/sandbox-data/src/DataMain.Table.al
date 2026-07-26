table 79300 "Data Main"
{
    DataClassification = CustomerContent;
    // ROADMAP R1 REPRODUCTION (Stream A, scratch — NOT to be merged): the workaround is
    // deliberately neutralised here to reproduce the fenced-path write-permission failure that a
    // real customer table would hit, since a real customer table carries no such declaration.
    // InherentPermissions = RIMD;

    fields
    {
        field(1; "No."; Code[20])
        {
            trigger OnValidate()
            begin
                if "No." = '' then
                    Error('No. must not be blank');
                Touched := Touched + 1;
            end;
        }
        field(2; Amount; Decimal) { }
    }

    keys
    {
        key(PK; "No.") { Clustered = true; }
    }

    var
        Touched: Integer;

    trigger OnInsert()
    begin
        Amount := Amount * 2;
    end;

    procedure TouchCount(): Integer
    begin
        exit(Touched);
    end;
}
