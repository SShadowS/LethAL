// R58 unknown #2: is BC's `Code Coverage."Line No."` FILE-relative or OBJECT-relative?
//
// Unknown #1 measured the numbers against a single-object file, where the two are
// indistinguishable — so it answered less than it appeared to. This file holds TWO objects, and the
// second one's procedure sits far down the file. If the reported lines for object 79322 are large
// (matching this file's own line numbering) the answer is file-relative; if they are small, each
// object is numbered from its own declaration.
//
// It matters because `line-map.ts` builds ranges by parsing emitted source. Multi-object files are
// legal AL (R6), and a map keyed on the wrong frame produces plausible-but-wrong procedure names —
// the R29 shape, at member level.

codeunit 79321 "Probe Obj One"
{
    procedure Widen(N: Integer) Sum: Integer
    var
        I: Integer;
    begin
        for I := 1 to N do
            Sum += I;
    end;

    procedure Narrow(N: Integer) Sum: Integer
    begin
        Sum := N - 1;
    end;
}

codeunit 79322 "Probe Obj Two"
{
    // If numbering is FILE-relative this procedure reports lines in the low 30s. If it is
    // OBJECT-relative it reports single digits.
    procedure Second(N: Integer) Sum: Integer
    var
        I: Integer;
    begin
        for I := 1 to N do
            if I mod 3 = 0 then
                Sum += I;
    end;
}


codeunit 79324 "Probe Obj Three"
{
    procedure Third(N: Integer) Sum: Integer
    begin
        Sum := N * 3;
    end;
}
