codeunit 91800 "R623 Probe Target Logic"
{
    // drive.ts builds variant X from this file as it is (returns 1) and variant Y by changing
    // the exit line below to 2. Keep the line exactly as written.
    procedure Answer(): Integer
    begin
        exit(1);
    end;
}
