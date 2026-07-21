codeunit 79210 "Order Matters Probe"
{
    // Witnesses RunMutant's exactly-one-method selection (spec §11, §C1). Two methods share the
    // "Sandbox Probe Marker" table. If RunMutant ran the WHOLE codeunit, AaInsertsMarker (declared
    // first, so run first) would leave a marker that makes ZzFailsIfMarkerPresent fail. Requesting
    // ONLY ZzFailsIfMarkerPresent and observing it PASS is the proof that AaInsertsMarker did not
    // also run server-side. Method names are ordered Aa*/Zz* so declaration order and any
    // alphabetical ordering both run the marker-inserter first.
    Subtype = Test;

    [Test]
    procedure AaInsertsMarker()
    var
        Marker: Record "Sandbox Probe Marker";
    begin
        Marker."Entry No." := 1;
        Marker.Insert();
    end;

    [Test]
    procedure ZzFailsIfMarkerPresent()
    var
        Marker: Record "Sandbox Probe Marker";
    begin
        if not Marker.IsEmpty() then
            Error('order-matters violated: another method inserted a marker (count=%1) — RunMutant did not select exactly one method', Marker.Count());
    end;
}
