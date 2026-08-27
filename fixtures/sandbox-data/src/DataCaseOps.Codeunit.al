// R180's arm. `empty-block` decided what to claim from the PARENT node kind and its list named
// `case_statement`, which matches NOTHING: a case arm's body is a block whose parent is
// `case_branch`, or `case_else_branch` for the else. So every `begin ... end` case arm in every AL
// project was unmutated by it, and the entry that looked like it covered them was dead.
//
// MEASURED on `do-rel2/Cloud`: 233 blocks under `case_branch`, 58 under `case_else_branch`, and 0
// under `case_statement`. 291 claimable sites, 22x R13's bar, all of them silently missing.
//
// No fixture contained a `case` statement at all before this one, so the fix would otherwise have
// added 291 mutants to a real corpus and ZERO to every gate. That is exactly the situation R171
// refused to land, and it was answered the same way: an arm, so a gate exercises the change.
//
// The three arms are a control set, not three tests of one thing:
//
//   BlockArm       a `begin ... end` arm      -> the fix MUST add an `empty-block` mutant
//   SingleArm      a one-statement arm        -> the fix MUST add NOTHING (only blocks are claimed)
//   else           a `begin ... end` else arm -> the fix MUST add one, via `case_else_branch`
//
// The middle one is the load-bearing half. A fix that claimed arms rather than arm BLOCKS would add
// a mutant there too, and the per-mutant baseline catches that as an extra row where a total would
// simply look bigger.
codeunit 79326 "Data Case Ops"
{
    procedure ClassifyLevel(Level: Integer): Integer
    var
        Score: Integer;
    begin
        case Level of
            1:
                begin
                    Score := 10;
                    Score += 5;
                end;
            2:
                Score := 20;
            else
                begin
                    Score := 90;
                    Score += 9;
                end;
        end;
        exit(Score);
    end;
}
