codeunit 51700 "Empty Block Target"
{
    procedure Work(A: Integer): Integer
    begin
        if A > 0 then begin
            Log('positive');
            exit(A);
        end;
        exit(0);
    end;

    procedure AlreadyEmpty()
    begin
    end;
}
