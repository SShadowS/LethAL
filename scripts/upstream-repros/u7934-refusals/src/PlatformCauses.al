table 50440 "Ref Blob Row"
{
    fields
    {
        field(1; Id; Integer) { }
        field(2; Count; Integer) { }
        field(3; Data; Blob) { }
    }
    keys { key(PK; Id) { } }
}

permissionset 50441 "Ref Exec Only"
{
    Assignable = false;
    Permissions = table "Ref Blob Row" = X;
}

codeunit 50431 "Ref Platform Tests"
{
    Subtype = Test;

    [Test]
    procedure C06_BlobIntoIntegerFieldRef()
    var
        Row: Record "Ref Blob Row";
        Ref: RecordRef;
        F: FieldRef;
        B: Record "Ref Blob Row";
    begin
        Ref.GetTable(Row);
        F := Ref.Field(2);
        asserterror F.Value := B.Data;
    end;

    [Test]
    procedure C07_MediaDeleteAll()
    var
        Media: Record Media;
    begin
        Media.DeleteAll();
    end;

    [Test]
    procedure C07b_MediaIsEmpty()
    var
        Media: Record Media;
    begin
        if not Media.IsEmpty() then
            Error('unexpected');
    end;

    [Test]
    procedure C08_CalcFieldOnBlobFieldRef()
    var
        Row: Record "Ref Blob Row";
        Ref: RecordRef;
        F: FieldRef;
    begin
        Row.Id := 1;
        Row.Insert();
        Ref.GetTable(Row);
        F := Ref.Field(3);
        F.CalcField();
    end;

    [Test]
    procedure C09_ModifyMissingRowNoPermission()
    var
        Row: Record "Ref Blob Row";
        Mock: Codeunit "Permissions Mock";
    begin
        Mock.Set('Ref Exec Only');
        Row.Id := 99;
        asserterror Row.Modify();
    end;

    [Test]
    procedure C10_WindowsSecurityIdUser()
    var
        U: Record User;
    begin
        U."User Security ID" := CreateGuid();
        U."Windows Security ID" := CreateGuid();
        U."User Name" := 'Ref Win Group 1';
        U."License Type" := U."License Type"::"Windows Group";
        U.Insert();
    end;
}
