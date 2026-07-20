namespace LethAL.Control;

/// <summary>The OData-exposed control surface. Registered as a web service by the install codeunit,
/// so its procedures are reachable as OData V4 unbound actions (/ODataV4/LethALControl_&lt;Proc&gt;).
/// HarnessInfo here; RunMutant is added in Layer 5C-A Task 3.</summary>
codeunit 71003 "LC Control API"
{
    /// <summary>Identity + capabilities the client verifies before any execution. Version and
    /// protocol live here (not the web-service registration row).</summary>
    procedure HarnessInfo() InfoJson: Text
    var
        Obj: JsonObject;
        Isolation: JsonArray;
        TestTypes: JsonArray;
    begin
        Isolation.Add('Codeunit');
        TestTypes.Add('codeunit');
        Obj.Add('appId', '5e7a1c00-1111-4c00-8c00-1e7a1c000701');
        Obj.Add('semver', '1.0.0.0');
        Obj.Add('protocolVersion', 1);
        Obj.Add('isolationModes', Isolation);
        Obj.Add('testTypes', TestTypes);
        Obj.WriteTo(InfoJson);
    end;
}
