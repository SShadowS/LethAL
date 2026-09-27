codeunit 50001 "Indexed Receiver Probe"
{
    procedure Run()
    var
        Buckets: array[3] of Record "Integer";
    begin
        asserterror Buckets[1].Delete(true);
        asserterror Buckets[2].Validate(Number, Buckets[1].Number);
        Buckets[3].Delete(true);
    end;
}
