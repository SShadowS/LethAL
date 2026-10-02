codeunit 79800 "Multi A"
{
        var
        MutationSelector: Codeunit "Mutation Selector";

procedure Never(X: Integer): Integer
    var LethALReachLatch: Boolean; begin
if MutationSelector.Active('M0003') then begin
  if not LethALReachLatch then begin MutationSelector.Reached('M0003'); LethALReachLatch := true; end; begin end
end else if MutationSelector.Active('M0004') then begin
  begin
        if not LethALReachLatch then begin MutationSelector.Reached('M0004'); LethALReachLatch := true; end; exit(0);
    end
end else if MutationSelector.Active('M0005') then begin
  begin
        if not LethALReachLatch then begin MutationSelector.Reached('M0005'); LethALReachLatch := true; end; exit(X - 7);
    end
end else begin
  begin
        exit(X + 7);
    end
end
end;
}

codeunit 79801 "Multi B"
{
        var
        MutationSelector: Codeunit "Mutation Selector";

procedure Reached(X: Integer): Integer
    var LethALReachLatch: Boolean; begin
if MutationSelector.Active('M0006') then begin
  if not LethALReachLatch then begin MutationSelector.Reached('M0006'); LethALReachLatch := true; end; begin end
end else if MutationSelector.Active('M0008') then begin
  begin
        if X > 10 then
            begin if not LethALReachLatch then begin MutationSelector.Reached('M0008'); LethALReachLatch := true; end; exit(0) end;
        exit(X); end
end else if MutationSelector.Active('M0010') then begin
  begin
        if X > 10 then
            exit(X + 1);
        if not LethALReachLatch then begin MutationSelector.Reached('M0010'); LethALReachLatch := true; end; exit(0); end
end else if MutationSelector.Active('M0007') then begin
  begin
        if not LethALReachLatch then begin MutationSelector.Reached('M0007'); LethALReachLatch := true; end; if X >= 10 then
            exit(X + 1);
        exit(X); end
end else if MutationSelector.Active('M0009') then begin
  begin
        if X > 10 then
            begin if not LethALReachLatch then begin MutationSelector.Reached('M0009'); LethALReachLatch := true; end; exit(X - 1) end;
        exit(X); end
end else begin
  begin
        if X > 10 then
            exit(X + 1);
        exit(X); end
end
end;
    procedure Unreached(X: Integer): Integer
    var LethALReachLatch: Boolean; begin
if MutationSelector.Active('M0011') then begin
  if not LethALReachLatch then begin MutationSelector.Reached('M0011'); LethALReachLatch := true; end; begin end
end else if MutationSelector.Active('M0012') then begin
  begin
        if not LethALReachLatch then begin MutationSelector.Reached('M0012'); LethALReachLatch := true; end; exit(0);
    end
end else begin
  begin
        exit(X * 3);
    end
end
end;
}
