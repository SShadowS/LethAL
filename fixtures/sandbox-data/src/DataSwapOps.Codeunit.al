// R82's `SwapCallArguments` fixture — six arms, each one a claim the live gate can falsify.
//
// Spec: docs/superpowers/specs/2026-08-03-r82-swap-call-arguments-design.md §4.
// Footprint that justified the operator: docs/measurements/README.md §R82.
//
// Read this file as six labelled arms. Each names what it measures, which verdict is PREDICTED
// (the prediction is pre-committed in the spec before the live run — a run that cannot contradict
// its author is a demo, R73), and which test produces it. The fixture is NOT here to show that a
// swap can be killed: that much is tautological. It is here to prove the PIPELINE — that the
// operator claims the right sites, emits AL that compiles, coexists with `void-method-call` under
// dedup, is attributed, and produces BOTH verdicts for the right reasons.
//
// Every procedure here also carries collateral Tier-1 mutants (`empty-block` on each body,
// `void-method-call` on each statement-position call, `return-value` on each Boolean/numeric
// `exit`). Those are named per arm rather than left to arrive at the gate as unexplained keys.
codeunit 79311 "Data Swap Ops"
{
    var
        LastPrimary: Code[20];
        LastSecondary: Code[20];
        AnyFlag: Boolean;

    // ---------------------------------------------------------------------------------------
    // ARM A — the KILL, and the live proof of the operator's type-safety argument.
    //
    // `Accumulate(Total, Delta)`: two bare Decimal locals, statement position. The swap redirects
    // the `var` WRITEBACK into `Delta`, so `Total` never grows.
    //
    // Two things this arm proves that no unit test can. (1) The swapped call COMPILES with a `var`
    // parameter in the first position — the operator never resolves the callee, and its whole
    // safety argument is that two bare variables are lvalues of one exact type (spec §2.2). If
    // that argument is wrong, `alc` rejects the artifact and the gate fails loudly. (2) The site
    // carries TWO mutants — this swap AND `lethal.void-method-call`'s deletion — because dedup
    // keys on replacement TEXT, not on the span. That is R82's "marginal == gross" as a fact
    // rather than an argument.
    //
    // PREDICTED: swap killed, void-method-call killed, empty-block killed (both bodies),
    // return-value killed — all by `SwapRedirectsTheAccumulatorWriteback`.
    procedure RunningTotal(Start: Decimal; Step: Decimal): Decimal
    var
        Total: Decimal;
        Delta: Decimal;
    begin
        Total := Start;
        Delta := Step;
        Accumulate(Total, Delta);
        exit(Total);
    end;

    procedure Accumulate(var Total: Decimal; Delta: Decimal)
    begin
        Total := Total + Delta;
    end;

    // ---------------------------------------------------------------------------------------
    // ARM B — EXPRESSION position, which is where the MAJORITY of real sites are.
    //
    // 452 of the 893 sites measured on Continia Document Output are not in statement position, so
    // a fixture that only exercised statement position would gate the minority shape. `InRange`'s
    // comparison is deliberately asymmetric: swapped, `InRange(Cap, Amount)` answers differently
    // for every pair except the equal one.
    //
    // PREDICTED: swap killed by `SwapReversesTheRangeComparison`, which asserts BOTH directions.
    // Collateral: both `return-value` mutants killed by the same test (it asserts a true case and
    // a false case), `conditional-boundary` on `<=` killed by its equal-values assertion,
    // `empty-block` killed on both bodies.
    procedure AmountWithinCap(Amount: Integer; Cap: Integer): Boolean
    begin
        exit(InRange(Amount, Cap));
    end;

    procedure InRange(Value: Integer; Limit: Integer): Boolean
    begin
        exit(Value <= Limit);
    end;

    // ---------------------------------------------------------------------------------------
    // ARM C — the EQUIVALENT survivor. `or` is commutative, so `RecordFlags(B, A)` computes what
    // `RecordFlags(A, B)` computes, for every input. This is `swap-modify-flag`'s equivalence
    // problem at the site count R82 measured (Boolean/Boolean is 11.76% of the provable sites),
    // and the fixture states it as a measurement rather than a fear.
    //
    // The covering test asserts the RESULT, which is what keeps this honest: the site is genuinely
    // covered (`void-method-call`'s deletion here is KILLED by that same assertion), so the
    // survivor is equivalence, not absence of coverage. A positive with no covering test would
    // land `no-coverage` and measure nothing.
    //
    // PREDICTED: swap SURVIVED. void-method-call killed, empty-block killed (RecordFlags body),
    // both by `CommutativeCalleeMakesTheSwapEquivalent`.
    procedure NoteFlags(First: Boolean; Second: Boolean)
    begin
        RecordFlags(First, Second);
    end;

    procedure RecordFlags(FlagA: Boolean; FlagB: Boolean)
    begin
        AnyFlag := FlagA or FlagB;
    end;

    // ---------------------------------------------------------------------------------------
    // ARM D — the UNDERTESTED survivor, and it must be readable APART from arm C.
    //
    // `StampCodes` writes its two arguments to two DIFFERENT places, so the swap is observable —
    // the suite simply does not look. That is a test-quality finding; arm C's survivor is a
    // property of the callee and no test can ever kill it. A real-project report is full of both,
    // and reading them apart is the difference between "your tests are weak here" and "this mutant
    // is unkillable".
    //
    // The covering test asserts only that a stamp HAPPENED (non-blank), which is true under the
    // swap too — but false when the call is DELETED. So the same weak assertion kills
    // `void-method-call` and spares the swap, which is exactly the discrimination being measured.
    //
    // PREDICTED: swap SURVIVED, void-method-call KILLED, both by `WeakStampAssertionMissesTheSwap`.
    procedure StampFromPair(A: Code[20]; B: Code[20])
    begin
        StampCodes(A, B);
    end;

    procedure StampCodes(Primary: Code[20]; Secondary: Code[20])
    begin
        LastPrimary := Primary;
        LastSecondary := Secondary;
    end;

    // ---------------------------------------------------------------------------------------
    // ARM E — the FALSE KILL, and the sharpest definition this repo has of one: a kill a WEAK test
    // still produces.
    //
    // Both arguments are `Code[20]`, so the operator claims the site and the swapped call
    // COMPILES. The callee's second parameter is `Code[10]`: the original passes a short value
    // there, the swap passes an 18-character one, and BC raises at runtime. The covering test
    // asserts NOTHING, so a kill here cannot be credited to any assertion.
    //
    // The operator cannot refuse this site — it never resolves the callee, by design (spec §2.2) —
    // so sites of this shape exist on any real project and a report must split kills by cause.
    // Per R72's discipline the verdict STAYS `killed`: a diagnosis must not move a verdict. No
    // detector is built here; this arm exists to produce the artifact TEXT a future detector would
    // have to match, which is the order R72 mandates.
    //
    // PREDICTED: swap KILLED, by a platform length-overflow error rather than by an assertion.
    // Collateral: void-method-call SURVIVED and empty-block SURVIVED — the test asserts nothing,
    // so deleting the call is genuinely unobservable. Those two survivors are the control that
    // proves the kill came from the swap's runtime effect and not from the test.
    procedure StampWithNarrow(LongCode: Code[20]; ShortCode: Code[20])
    begin
        NarrowStamp(LongCode, ShortCode);
    end;

    procedure NarrowStamp(Wide: Code[20]; Narrow: Code[10])
    begin
        LastPrimary := Wide;
        LastSecondary := Narrow;
    end;

    // ---------------------------------------------------------------------------------------
    // ARM F — the R84 REFUSAL negative, and the one arm whose PASS condition is an absence.
    //
    // `Link(MainRow, RelatedRow)`: two bare identifiers whose truncated type heads both read
    // `Record`, and whose full declared types are different tables. Before R84 the type table
    // answered `Record` for both — measured on Document Output as 135 of 893 sites (15.1%) — so
    // this is the shape that would have shipped an artifact that does not compile.
    //
    // An absence is a weak assertion on its own, so this site is load-bearing in TWO ways. If the
    // operator wrongly claims it, `alc` rejects the artifact (a `Record "Data Main"` argument in a
    // `Record "Data Related"` parameter) and the run fails at compile, before any verdict — loud,
    // not silent. And the site's `void-method-call` mutant has a PINNED verdict, so a wrong claim
    // that somehow did compile would surface as an operatorName change on a killed mutant, the
    // detector shape R70 established.
    //
    // PREDICTED: NO swap mutant at this site. void-method-call KILLED by `LinkedPairIsStamped`.
    procedure LinkPair(MainNo: Code[20]; RelatedEntryNo: Integer)
    var
        MainRow: Record "Data Main";
        RelatedRow: Record "Data Related";
    begin
        MainRow."No." := MainNo;
        RelatedRow."Entry No." := RelatedEntryNo;
        Link(MainRow, RelatedRow);
    end;

    procedure Link(Main: Record "Data Main"; Related: Record "Data Related")
    begin
        LastPrimary := Main."No.";
        LastSecondary := Format(Related."Entry No.");
    end;

    // ---------------------------------------------------------------------------------------
    // Read-only accessors, and there are exactly two because a THIRD would have been dead weight:
    // an accessor no test calls contributes a `no-coverage` mutant that teaches nothing, so
    // `LastSecondary` is written by arms D and E and deliberately never read. `exit` of a
    // `Code[20]` is claimed by no Tier-1 operator (`return-value` takes Boolean and numeric returns
    // only), so `PrimaryStamp` adds an `empty-block` mutant and nothing else; `AnyFlagSeen`'s
    // Boolean return DOES carry a `return-value` mutant.
    procedure PrimaryStamp(): Code[20]
    begin
        exit(LastPrimary);
    end;

    procedure AnyFlagSeen(): Boolean
    begin
        exit(AnyFlag);
    end;
}
