namespace R472.Probe;

// Inserts the record it is handed. The caller sets "No." and SystemId; Tag picks the call form.
codeunit 91721 "R472 Probe Insert B"
{
    TableNo = "R472 Probe Row";

    trigger OnRun()
    begin
        case Rec.Tag of
            'with-systemid':
                Rec.Insert(false, true);
            'without-systemid':
                Rec.Insert(false, false);
            else
                Error('unknown tag %1', Rec.Tag);
        end;
    end;
}
