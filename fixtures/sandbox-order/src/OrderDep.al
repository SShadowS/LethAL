table 77000 "Order Dep Row"
{
    DataClassification = SystemMetadata;
    fields { field(1; Id; Integer) { } }
    keys { key(PK; Id) { Clustered = true; } }
}

codeunit 77001 "Order Dep State"
{
    SingleInstance = true;
    var
        Mark: Text;

    procedure SetMark(T: Text)
    begin
        Mark := T;
    end;

    procedure GetMark(): Text
    begin
        if Mark = '' then exit('DEFAULT');
        exit(Mark);
    end;
}
