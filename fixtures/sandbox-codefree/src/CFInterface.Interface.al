#if CFACTIVE
interface "CF Iface"
{
    procedure Compute(X: Integer): Integer;
    procedure Check(X: Integer): Boolean;
}
#endif
