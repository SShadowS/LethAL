table 79300 "Data Main"
{
    DataClassification = CustomerContent;
    // The fenced RunMutant path executes under the OData runner session, which does not hold
    // the test app's write permissions on this table — a test that INSERTs fails with
    // "the current permissions prevented the action" there while passing elsewhere. LethAL's
    // own control tables carry the same declaration for exactly this reason (Lease.Table.al).
    InherentPermissions = RIMD;

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
