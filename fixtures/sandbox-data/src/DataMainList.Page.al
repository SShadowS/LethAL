// Host for the `pageextension` beside it, and nothing else.
//
// Deliberately code-free: it declares no procedure and no trigger, so it carries ZERO mutation
// sites and needs no injected selector var. The point of the pair is the EXTENSION (see
// `DataMainListExt.PageExt.al`); a page with logic of its own would add mutants that say nothing
// about R30 and would move the frozen baseline for an unrelated reason.
//
// It extends nothing and depends on nothing outside this app — `fixtures/sandbox-data` declares no
// dependencies, so a `pageextension` here has to extend a page this app owns.
page 79320 "Data Main List"
{
    PageType = List;
    ApplicationArea = All;
    UsageCategory = Lists;
    SourceTable = "Data Main";

    layout
    {
        area(Content)
        {
            repeater(Rows)
            {
                field("No."; Rec."No.")
                {
                    ApplicationArea = All;
                }
                field(Category; Rec.Category)
                {
                    ApplicationArea = All;
                }
                field("Modify Count"; Rec."Modify Count")
                {
                    ApplicationArea = All;
                    // R144's fixture site, and the ONLY reason this property exists. `Enabled`
                    // takes a boolean EXPRESSION, which tree-sitter yields as the same comparison
                    // shape a statement would, so `lethal.conditional-boundary` claims it — and
                    // `isMutableSite` then drops it, because a page property is declarative and
                    // has no statement to wrap. That drop is R135's ruling; this site is what
                    // makes the gate able to assert the report SAYS so, instead of asserting a
                    // zero that would read the same on a fixture with no declarative surface.
                    //
                    // It must add exactly ZERO mutants. If the fixture's mutant totals ever move
                    // because of this line, the drop itself regressed.
                    Enabled = Rec."Modify Count" > 0;
                }
            }
        }
    }
}
