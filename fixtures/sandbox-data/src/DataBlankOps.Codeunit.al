// R159's assertion-screen arm for `toggle-blank-string`.
//
// The operator's spike left ONE question open and this arm exists to close it. Two of its kills on
// this fixture -- `Data Flag Ops.InsertTwiceWithKeyTrigger` and `Data Key Probe.OnInsert` -- die on a
// DUPLICATE PRIMARY KEY with no test asserting anything, which is the shape R138 tagged for
// `swap-modify-flag`'s `Insert`. The operator declares no `PlatformKillMechanism`, on the ruling that
// changing a written VALUE is ordinary changed behaviour and that R121's assertion screen is what
// tells a reader such a kill carried no assertion.
//
// The spike could not test that ruling. Every kill it produced was flagged, because this suite raises
// through bare `Error(...)` and the rule -- "the failure text does not begin with `Assert.`" -- has
// nothing to separate on. `vacuous`, exactly as R132 documents. Reading that as a pass would have
// been wrong.
//
// So this procedure is killed through Microsoft's `Library Assert`, the same device R132's twin pair
// uses. Beside the two duplicate-key kills it makes the screen SEPARATE rather than flag everything:
//
//   ClassifyCode                    killed via Assert.AreEqual  -> screen must NOT flag
//   InsertTwiceWithKeyTrigger       killed via duplicate key    -> screen MUST flag
//   Data Key Probe.OnInsert         killed via duplicate key    -> screen MUST flag
//
// That is the evidence the ruling rests on, and it is pinned BY MUTANT in `tables.itest.ts` rather
// than by a count: a flagged total reads identically whether the screen separated anything or not.
codeunit 79320 "Data Blank Ops"
{
    // The literal is non-blank, so `toggle-blank-string` blanks it. `'ALPHA'` never equals `''`, so
    // the mutant returns 0 where the test expects 1 and the assertion is what fails.
    procedure ClassifyCode(No: Code[20]): Integer
    begin
        if No = 'ALPHA' then
            exit(1);
        exit(0);
    end;
}
