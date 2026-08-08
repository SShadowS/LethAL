// R101(c): the question is not whether `#if` exists in AL — it is what happens to LethAL when a
// symbol the customer's real build defines is NOT passed to the `alc` step LethAL runs itself.
//
// Two outcomes are possible and they are very different:
//   (a) the compile FAILS, which is loud and harmless — someone fixes the config;
//   (b) the compile SUCCEEDS on the other branch, which is silent: LethAL then instruments,
//       mutates and SCORES code the customer does not ship, and nothing anywhere says so.
//
// This probe answers which one happens, by compiling the same source twice and comparing the
// emitted artifacts. Both procedures below are complete on both branches, which is exactly the
// shape real code has — an `#if` normally selects between two working implementations.
codeunit 71560 "R101c Define Probe"
{
    procedure WhichBranch(): Text
    begin
#if LETHAL_PROBE_SYMBOL
        exit('DEFINED-BRANCH');
#else
        exit('UNDEFINED-BRANCH');
#endif
    end;

    // A second site, so the difference is not a single literal that a byte comparison might miss
    // inside compression. Deliberately different SHAPES per branch (a loop versus a constant), so
    // the two artifacts differ structurally and not only in a string.
    procedure Second(): Text
    begin
#if LETHAL_PROBE_SECOND
        exit('SECOND-DEFINED');
#else
        exit('SECOND-UNDEFINED');
#endif
    end;

    procedure Cost(): Integer
    var
        Total: Integer;
        I: Integer;
    begin
#if LETHAL_PROBE_SYMBOL
        for I := 1 to 10 do
            Total += I;
        exit(Total);
#else
        exit(0);
#endif
    end;
}
