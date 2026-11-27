namespace LethAL.Control;

/// <summary>1.0.0.31 (PR-478, B3): the page a CLIENT session opens to bind itself to its `client-run` op. The
/// client sets Attempt Id and Op Seq and runs Bind; the session id recorded is this session's own SessionId(),
/// never one the client supplied. The rules live in "LC Control State".BindClientSession.</summary>
page 91015 "LC Client Bind"
{
    PageType = Card;
    ApplicationArea = All;
    UsageCategory = None;
    Caption = 'LethAL Client Bind';

    layout
    {
        area(Content)
        {
            group(General)
            {
                field(AttemptIdField; AttemptId)
                {
                    Caption = 'Attempt Id';
                    ToolTip = 'The attempt id of the client-run op.';
                }
                field(OpSeqField; OpSeq)
                {
                    Caption = 'Op Seq';
                    ToolTip = 'The op sequence number of the client-run op.';
                }
                field(BoundField; Bound)
                {
                    Caption = 'Bound';
                    Editable = false;
                    ToolTip = 'True when this session is now the bound session of the op.';
                }
                field(EndedField; Ended)
                {
                    Caption = 'Ended';
                    Editable = false;
                    ToolTip = 'True when this session has marked its end.';
                }
            }
        }
    }

    actions
    {
        area(Processing)
        {
            action(Bind)
            {
                Caption = 'Bind';
                ToolTip = 'Bind this session to the client-run op.';

                trigger OnAction()
                var
                    State: Codeunit "LC Control State";
                    Reason: Text;
                begin
                    Bound := State.BindClientSession(AttemptId, OpSeq, Reason);
                end;
            }
            action("End")
            {
                Caption = 'End';
                ToolTip = 'Mark this bound session as ended. The last step, after the test run returns.';

                trigger OnAction()
                var
                    State: Codeunit "LC Control State";
                    Reason: Text;
                begin
                    Ended := State.EndClientSession(AttemptId, OpSeq, Reason);
                end;
            }
        }
    }

    var
        AttemptId: Text[64];
        OpSeq: BigInteger;
        Bound: Boolean;
        Ended: Boolean;
}
