codeunit 79600 "R402 Shape"
{
    var
        G: Integer;
#if not LETHALX
        H: Integer;
#else
        H: BigInteger;
#endif

#if not LETHALX
    procedure Spin(): Integer
    var
        P: Integer;
        Found: Boolean;
    begin
        for P := 10 downto 1 do
            if Found then
                P := 1;
        exit(P);
    end;
#endif

    procedure SpinGlobal(): Integer
    var
        Found: Boolean;
    begin
        for H := 10 downto 1 do
            if Found then
                H := 1;
        exit(G);
    end;

    procedure SpinAmbiguous(): Integer
    var
        Found: Boolean;
#if not LETHALX
        A: Integer;
#else
        A: BigInteger;
#endif
    begin
        for A := 10 downto 1 do
            if Found then
                A := 1;
        exit(G);
    end;

    procedure SpinDirect(): Integer
    var
        P: Integer;
        Found: Boolean;
    begin
        for P := 10 downto 1 do
            if Found then
                P := 1;
        exit(P);
    end;
}
