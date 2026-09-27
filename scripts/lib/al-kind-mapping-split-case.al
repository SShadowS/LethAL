codeunit 50002 "Split Case Probe"
{
    procedure Route(Mode: Integer; Ready: Boolean)
    begin
        case Mode of
#if FASTPATH
            1:
                begin
                    if not Ready then
                        Prepare(Mode)
                    else
                        Launch(Mode);
                end;
            2:
#else
            1, 2:
#endif
                begin
                    Launch(Mode);
                end;
            3:
                Prepare(Mode);
        end;
    end;

    local procedure Prepare(Mode: Integer)
    begin
    end;

    local procedure Launch(Mode: Integer)
    begin
    end;
}
