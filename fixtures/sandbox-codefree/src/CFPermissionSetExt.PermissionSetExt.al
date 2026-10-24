#if CFACTIVE
permissionsetextension 79911 "CF Perms Ext" extends "CF Perms"
{
    Permissions = codeunit "CF Active" = X;
}
#else
permissionsetextension 79911 "CF Perms Ext" extends "CF Perms"
{
    Permissions = codeunit "CF Inactive" = X;
}
#endif
