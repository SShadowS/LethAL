#if CFACTIVE
dotnet
{
    assembly("System.Runtime")
    {
        type("System.Text.StringBuilder"; "CF StringBuilder")
        {
        }
    }
}
#endif
