namespace LethAL.R389Probe;

/// <summary>The external app's OWN interface. The test app's mock implements it.</summary>
interface "R389 Probe Iface"
{
    procedure Ping(Route: Text): Text;
}
