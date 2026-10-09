// twin of WrappedView: the wrapper's #if line, as a comment
namespace LethAL.SandboxWrapped;

// R536: a one-arm wrapped PAGE alone in its file. `Label` is reached by calling it on a page
// variable (no TestPage, which the fenced session refuses); `OnOpenPage` is never run. Its
// unwrapped twin (WrappedViewTwin) has the same text on the same lines. Do not move a line
// without a new pre-commitment.
page 78910 "Wrapped View Twin"
{
    PageType = Card;
    SourceTable = "Wrapped Trigger Twin";

    layout
    {
        area(Content)
        {
            field(Qty; Rec.Qty)
            {
            }
        }
    }

    var
        Opened: Boolean;

    trigger OnOpenPage()
    begin
        Opened := true;
    end;

    procedure Label(X: Integer): Text
    begin
        if X > 5 then
            exit('big');
        exit('small');
    end;
}
// twin of WrappedView: the wrapper's #endif line, as a comment
