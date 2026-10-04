namespace LethAL.R389Probe.Tests;

using LethAL.R389Probe;

/// <summary>The test-app codeunit handed out in a Variant. Whatever runs it leaves an unmistakable
/// mark: an error whose text starts 'MARK R389 ran'. No other object in either app says MARK.</summary>
codeunit 91530 "R389 Probe Mock" implements "R389 Probe Iface"
{
    trigger OnRun()
    begin
        Error('MARK R389 ran the TEST-APP mock OnRun');
    end;

    procedure Ping(Route: Text): Text
    begin
        Error('MARK R389 ran the TEST-APP mock Ping via %1', Route);
    end;
}
