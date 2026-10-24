#if CFACTIVE
controladdin "CF Addin"
{
    RequestedHeight = 100;

    procedure Refresh();
    procedure SetValue(Value: Text);
    event Ready();
    event Changed(Value: Text);
}
#endif
