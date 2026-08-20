// R171's cession-seam arm.
//
// `remove-not` refuses a parenthesized operand and cedes it to `negate-conditional`. That cession is
// correct for `not (A = B)` and `not (A and B)`, which that operator does claim. It is wrong for
// everything else, because `negate-conditional` targets `comparison_expression` and
// `logical_expression` and NOTHING more -- so `not (X in [...])` was ceded to an operator that does
// not want it, and reached by neither. Measured on do-rel2/Cloud: 15 `if` guards, 13 marginal.
//
// This arm exists because the fix adds ZERO sites on every other fixture. A change no live gate
// exercises is R56's shape: a docs-only commit once deleted a procedure body and `itest:tables`
// stayed green for days. So the seam gets a site that a gate actually runs.
//
// The three procedures are a CONTROL SET, not three tests of the same thing:
//
//   RegionRank        `not (Code in [set])`  -- the reclaimed shape. `remove-not` must claim it.
//   BothOutsideRange  `not (A = B)`          -- still ceded. `negate-conditional` claims the inner
//                                               comparison; `remove-not` must NOT claim the `not`.
//   PlainMembership   `Code in [set]`        -- no `not` at all, so it is `negate-guard`'s, not
//                                               `remove-not`'s. Pins the split between the two
//                                               operators R171 introduced and changed.
//
// Without the second and third, "remove-not claims the in-expression" would be satisfied by an
// operator that had simply started claiming every parenthesized operand, which is the over-broad
// version of this fix.
codeunit 79319 "Data Set Ops"
{
    // `not (<expr> in [<set>])` -- reclaimed by remove-not (R171).
    procedure RegionRank(CountryCode: Code[10]): Integer
    begin
        if not (CountryCode in ['DK', 'SE', 'NO']) then
            exit(0);
        exit(1);
    end;

    // `not (A = B)` -- still ceded to negate-conditional. remove-not must refuse.
    procedure BothOutsideRange(First: Integer; Second: Integer): Integer
    begin
        if not (First = Second) then
            exit(0);
        exit(1);
    end;

    // A bare `in` guard with no `not`: negate-guard's site, not remove-not's.
    procedure PlainMembership(CountryCode: Code[10]): Integer
    begin
        if CountryCode in ['DK', 'SE', 'NO'] then
            exit(1);
        exit(0);
    end;
}
