// Copied into a SCRATCH copy of probe-app by companyopen-probe.sh (not part of probe-app itself).
// An OnCompanyOpenCompleted subscriber that writes a row: alpha.3 refuses every test because of it.
codeunit 50620 "Probe Open Writer"
{
    [EventSubscriber(ObjectType::Codeunit, Codeunit::"Company Triggers", 'OnCompanyOpenCompleted', '', false, false)]
    local procedure WriteOnOpen()
    var
        Row: Record "Probe Row";
    begin
        Row."Key" := 'OPENED';
        if Row.Insert() then;
    end;
}
