dotnet
{
    assembly("mscorlib")
    {
        type("System.Collections.Generic.List`1"; RefList)
        {
        }
    }

    assembly("Microsoft.Dynamics.Nav.AzureADGraphClient")
    {
        Culture = 'neutral';
        PublicKeyToken = '31bf3856ad364e35';

        type("Microsoft.Dynamics.Nav.AzureADGraphClient.MockGraphQuery"; RefMockGraph)
        {
        }
    }

    assembly("Microsoft.Dynamics.Nav.Ncl")
    {
        Culture = 'neutral';

        type("Microsoft.Dynamics.Nav.Runtime.PageSummary.NavPageSummaryALFunctions"; RefPageSummary)
        {
        }
    }

    assembly("Microsoft.Dynamics.Nav.Service.CopilotApi")
    {
        Culture = 'neutral';

        type("Microsoft.Dynamics.Nav.Service.CopilotApi.AL.ALMicrosoftLearnFunctions"; RefLearn)
        {
        }
        type("Microsoft.Dynamics.Nav.Service.CopilotApi.AL.ALCopilotFunctions"; RefCopilot)
        {
        }
    }
}

codeunit 50430 "Ref DotNet Tests"
{
    Subtype = Test;

    [Test]
    procedure C01_NewMockGraphQuery()
    var
        Q: DotNet RefMockGraph;
    begin
        Q := Q.MockGraphQuery();
    end;

    [Test]
    procedure C02_GetSummaryFields()
    var
        Fns: DotNet RefPageSummary;
        Fields: DotNet RefList;
    begin
        Fields := Fns.GetSummaryFields(21);
    end;

    [Test]
    procedure C02b_GetAvailableTableFields()
    var
        Fns: DotNet RefPageSummary;
        Fields: DotNet RefList;
    begin
        Fields := Fns.GetAvailableTableFields(21);
    end;

    [Test]
    procedure C03_HasInGeoSupport()
    var
        Learn: DotNet RefLearn;
        Ok: Boolean;
    begin
        Ok := Learn.HasInGeoSupport();
    end;

    [Test]
    procedure C04_GptTokenCount()
    var
        Copilot: DotNet RefCopilot;
        Text: SecretText;
        Count: Integer;
    begin
        Text := 'hello world';
        Count := Copilot.GptTokenCount(Text, 'cl100k_base');
    end;

    [Test]
    procedure C05_IsPlatformAuthorizationConfigured()
    var
        Copilot: DotNet RefCopilot;
        Ok: Boolean;
    begin
        Ok := Copilot.IsPlatformAuthorizationConfigured('Microsoft', 'Microsoft');
    end;
}
