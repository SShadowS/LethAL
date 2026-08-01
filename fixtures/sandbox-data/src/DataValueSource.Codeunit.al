// R78 fixture, half 1 of 2. The MUTATION TARGET, and the whole point of the pair.
//
// `exit(42)` is chosen precisely: `lethal.return-value` targets an `exit_statement` whose return
// type is numeric and whose argument is NOT already `0`/`0.0` (see
// `packages/builtin-tier1/src/return-value.ts`), and rewrites it to `exit(0)`. So this procedure
// carries exactly one Tier-1 mutant with a known, deterministic mutation.
//
// WHY IT MATTERS: nothing else in this fixture calls `GetValue`. Its ONLY caller is the action on
// `page 79323 "Data Value Card"`, and the only test that invokes that action is a `TestPage` test.
// So the mutant here is reachable exclusively through a TestPage — a purpose-built instance of the
// case R69/R78 argue about, with a known-correct answer, so a wrong verdict is unmistakable rather
// than arguable.
//
// Deliberately trivial: no triggers, no FlowFields, no writes. R76 measured that a page whose
// source table carries real triggers and a pageextension writing from `OnOpenPage` HANGS the fenced
// session and quarantines the whole run, while a simple page is REFUSED fast (87 ms). Fast refusal
// is the signal the router's gate 1 was built to detect, so this pair is deliberately on that side
// of the split — it exercises the pipeline in the configuration that can work, and does not
// re-litigate the hang.
codeunit 79308 "Data Value Source"
{
    procedure GetValue(): Integer
    begin
        exit(42);
    end;
}
