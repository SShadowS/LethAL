namespace NstRepro02;

// Writes from OnOpenPage: inserts a row in another table and modifies a source-table row, as the
// incident's page extension did.
pageextension 91613 "NST Repro02 Main List Ext" extends "NST Repro02 Main List"
{
    var
        Related: Record "NST Repro02 Related";
        Main: Record "NST Repro02 Main";

    trigger OnOpenPage()
    begin
        Related.Init();
        Related."Main No." := 'P-EXT';
        Related.Amount := 1;
        Related.Insert(true);
        Related.SetRange("Main No.", 'P-EXT');
        if Main.Get('P-EXT') then begin
            Main."Modify Count" := Related.Count();
            Main.Modify();
        end;
    end;
}
