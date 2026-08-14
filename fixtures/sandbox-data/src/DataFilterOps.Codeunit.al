// R134's `lethal.flip-filter-literal` fixture -- eight arms (seven procedures; arm F is a
// documented equivalence class, not a ninth near-duplicate procedure), each one a claim the live
// gate can falsify.
//
// Spec: docs/superpowers/specs/2026-08-12-r134-filter-literal-design.md section 3 (the arm
// table), section 3.2 (rules the arms obey), section 3.3 (collateral to expect).
//
// Reuses table 79302 "Data Related" (no new table, no new schema) and the existing
// AddRelated/ClearRelated seeding helpers in fixtures/sandbox-data-tests/src/DataTests.Codeunit.al.
// Each procedure declares its OWN local `Related` var (no codeunit-level state to bleed between
// arms). No arm scopes on "Main No." when the operator's own target field IS "Main No." (arms A,
// B, G) -- there is nothing to scope that field against without overwriting the very filter the
// arm exists to mutate. This is safe because BC rolls back each [Test]'s own writes between
// tests (R32), so "Data Related" holds exactly the covering test's own rows when each arm's count
// runs, not residue from any other arm or any other test.
//
// Every procedure here also carries collateral Tier-1 mutants (empty-block on the body,
// void-method-call on each statement-position call, return-value on each Boolean/numeric exit),
// plus Tier-2 remove-setrange on arms C, D, E and H's new SetRange call (which DISPLACES
// void-method-call at that one span -- same empty after.text, Tier 2 wins), so those sites carry
// one collateral mutant at the SetRange span, not two. Named per arm below, not left to arrive at
// the gate as unexplained keys.
codeunit 79317 "Data Filter Ops"
{
    // ---------------------------------------------------------------------------------------
    // ARM A -- rule 1 (negation flip), the KILL, and the hash-decoy pair with arm B.
    //
    // `<>%1` -> `=%1` inverts which group the count sees. One row tagged FILT-A1, two tagged
    // FILT-A2, called with MainNo = 'FILT-A1': the baseline counts the OTHER group (2); the flip
    // would count FILT-A1's own group instead (1).
    //
    // PREDICTED: flip-filter-literal KILLED (2 vs 1). void-method-call KILLED too (deleting the
    // filter counts the WHOLE table, unscoped -- 3, not 2). Both by
    // `NegationFlipChangesTheCount`.
    procedure CountExcluding(MainNo: Code[20]): Integer
    var
        Related: Record "Data Related";
    begin
        Related.SetFilter("Main No.", '<>%1', MainNo);
        exit(Related.Count());
    end;

    // ---------------------------------------------------------------------------------------
    // ARM B -- rule 1, the weak-assertion SURVIVOR, and the arm A/B discrimination pair.
    //
    // `'<>%1|FLT-NONE'` carries a HASH DECOY (spec section 2.7): 'FLT-NONE' is inert (no seeded
    // row anywhere in this fixture carries it) and exists only so this call's ORIGINAL text
    // differs from arm A's -- without it, astSubtreeHash on the two calls collides (measured:
    // both '86cb5be337f68b07'), because a text_literal node hashes its content verbatim and every
    // identifier around it canonicalises to the same pattern in both arms. The ladder still fires
    // rule 1 at the SAME leading alternative ('<>%1'), before it ever reaches 'FLT-NONE', which
    // cannot classify as anything rule 4 would want to drop instead (rule 1 already claimed the
    // site by the time rule 4 would run).
    //
    // The covering test seeds at least one row in EACH of two Main No. groups and asserts only
    // EXISTENCE (Count() > 0), true under both the original ('<>MainNo', matching the other
    // group) and the flip ('=MainNo', matching MainNo's own group) -- existence cannot tell which
    // group was counted.
    //
    // PREDICTED: flip-filter-literal SURVIVED. void-method-call SURVIVED too (deleting the filter
    // still counts >0 rows, unscoped, since both groups exist). Both by
    // `ExistenceOnlyAssertionMissesTheNegationFlip`.
    procedure AnyExcluding(MainNo: Code[20]): Boolean
    var
        Related: Record "Data Related";
    begin
        Related.SetFilter("Main No.", '<>%1|FLT-NONE', MainNo);
        exit(Related.Count() > 0);
    end;

    // ---------------------------------------------------------------------------------------
    // ARM C -- rule 2 (boundary shift), the KILL, and the arm C/D discrimination pair.
    //
    // Scoped with SetRange("Main No.", 'FLT-C') before the SetFilter (finding 6): without it, the
    // count would depend on every row in the table, not just this arm's own, and residue from an
    // aborted run would make the verdict depend on what else happens to be seeded. The added
    // SetRange gains its own remove-setrange mutant, which DISPLACES void-method-call at that one
    // span (same empty after.text, Tier 2 wins).
    //
    // Three consecutive Entry No. values, ONE of them at the threshold (N=79160, N+1=79161,
    // N+2=79162 as Threshold), plus a residue decoy row in a DIFFERENT Main No. group with an
    // Entry No. below the threshold: proof the scope is doing real work, since an unscoped filter
    // would also have counted that decoy.
    //
    // PREDICTED: flip-filter-literal KILLED (baseline 2, matching N and N+1; '<=' also admits
    // N+2, 3). void-method-call (deleting the SetFilter, leaving the SetRange) KILLED too (counts
    // all 3 of the arm's own FLT-C rows, not 2). remove-setrange (deleting the SetRange, leaving
    // the SetFilter unscoped) KILLED (counts the decoy too -- 3, not 2). All three by
    // `BoundaryShiftAdmitsTheThresholdRow`.
    procedure CountBelowThreshold(Threshold: Integer): Integer
    var
        Related: Record "Data Related";
    begin
        Related.SetRange("Main No.", 'FLT-C');
        Related.SetFilter("Entry No.", '<%1', Threshold);
        exit(Related.Count());
    end;

    // ---------------------------------------------------------------------------------------
    // ARM D -- rule 2, the equivalence SURVIVOR, and arm C/D's own discrimination pair.
    //
    // Scoped with SetRange("Main No.", 'FLT-D') for the same reason as arm C (finding 6).
    //
    // MEASURED DEVIATION FROM THE SPEC'S LITERAL TEXT. Section 2.7 states this arm's hash decoy
    // as '<%1|FLT-NONE', mirroring arm B's. 'FLT-NONE' is a valid decoy on arm B's field ("Main
    // No.", Code[20]) but NOT on this arm's field ("Entry No.", Integer): measured directly
    // against Cronus283 (scripts/r134-filter-probe/, README.md there records the run),
    // `SetFilter("Entry No.", '<%1|FLT-NONE', N)` raises immediately -- "The value \"FLT-NONE\"
    // can't be evaluated into type Integer" -- which would break this arm's own BASELINE call,
    // not just a mutant. The decoy here is instead a NUMERIC, out-of-band sentinel
    // ('999999999', an Entry No. no row anywhere in this fixture ever uses), confirmed by the
    // same probe to be inert and non-throwing. This still differs this call's original text from
    // arm C's plain '<%1' -- the actual purpose the decoy exists for: astSubtreeHash hashes a
    // text_literal node's text verbatim, so any distinct, inert alternative satisfies it; nothing
    // about the decoy's specific spelling is load-bearing beyond that.
    //
    // A sparse pair (N=79170 and N+2=79172, gap at N+1=79171), called with Threshold = N+1: no
    // row sits exactly at the shifted boundary, so the mutant is equivalent regardless of how
    // much data exists elsewhere -- the boundary-shift analogue of swap-find-direction's
    // zero-or-one-row equivalence class. Plus a residue decoy row in a different Main No. group
    // below the threshold, for the same scope-proving reason as arm C.
    //
    // PREDICTED: flip-filter-literal SURVIVED (baseline and mutant both count only N: 1).
    // void-method-call (deleting the SetFilter, leaving the SetRange) KILLED (counts both of the
    // arm's own FLT-D rows -- 2, not 1). remove-setrange (deleting the SetRange, leaving the
    // SetFilter unscoped) KILLED (counts the decoy too). All three by
    // `GapAtTheBoundaryMakesTheShiftEquivalent`.
    procedure CountBelowThresholdSparse(Threshold: Integer): Integer
    var
        Related: Record "Data Related";
    begin
        Related.SetRange("Main No.", 'FLT-D');
        Related.SetFilter("Entry No.", '<%1|999999999', Threshold);
        exit(Related.Count());
    end;

    // ---------------------------------------------------------------------------------------
    // ARM E -- rule 3 (open-range flip), the KILL, and the arm that removes dependence on the
    // range-inclusivity claim (spec section 0's REASONED-not-MEASURED premise).
    //
    // Scoped with SetRange("Main No.", 'FLT-E') for the same reason as arm C (finding 6).
    //
    // Rows strictly below AND above the bound but NONE exactly at it (N-2=79178, N-1=79179,
    // N+1=79181, called with Bound = N=79180): the baseline count is 2 whether '..N' is read as
    // inclusive or exclusive at N, because no seeded row sits exactly there (finding 4). Plus a
    // residue decoy row in a different Main No. group at or below N, for the same scope-proving
    // reason as arm C.
    //
    // PREDICTED: flip-filter-literal KILLED (baseline 2 under either inclusivity reading; '..N'
    // flipped to 'N..' matches only N+1, 1). void-method-call (deleting the SetFilter, leaving
    // the SetRange) KILLED (counts all 3 of the arm's own FLT-E rows, not 2) -- by the SAME
    // mechanism as arms C and D, since the filter matches only a SUBSET of the arm's own seeded
    // rows. NOTE: this contradicts spec section 3.3's own summary bullet, which groups arm E
    // under "predicted SURVIVED" alongside arms B, G and H; that bucket does not match this arm's
    // own worked arithmetic in section 3.1 (which explicitly derives KILLED and contrasts it with
    // "the unpredictable survivor an unscoped... seeding would have produced"). Flagged as a spec
    // inconsistency in Task B6's report for Task B7's precommitment to resolve deliberately.
    // remove-setrange (deleting the SetRange, leaving the SetFilter unscoped) KILLED (counts the
    // decoy too). All three by `RangeFlipChangesTheCountRegardlessOfInclusivity`.
    procedure CountUpToBound(Bound: Integer): Integer
    var
        Related: Record "Data Related";
    begin
        Related.SetRange("Main No.", 'FLT-E');
        Related.SetFilter("Entry No.", '..%1', Bound);
        exit(Related.Count());
    end;

    // ---------------------------------------------------------------------------------------
    // ARM G -- rule 4 (drop a placeholder-free alternative), the KILL.
    //
    // No SetRange scope: this arm's own two Main No. groups (the decoy tag and the passed-in
    // target tag) ARE the filter's whole subject, the same reason arms A and B are unscoped.
    //
    // 'FLT-G-DECOY|%1' -- a fixed, placeholder-free alternative plus a placeholder alternative.
    // Renamed from an earlier draft's 'T-DECOY'/'T-DROP' (finding 5): those collided with the
    // EXISTING CountForMainIgnoresDecoys test's own 'T-DECOY' seeding, which would have made this
    // arm's baseline count depend on residue from a different test.
    //
    // PREDICTED: flip-filter-literal KILLED (baseline matches 'FLT-G-DECOY' OR the target tag,
    // 2+3=5; dropping the placeholder-free alternative leaves only '%1', matching just the target
    // tag's 3). void-method-call SURVIVED (deleting the filter counts the whole table -- 5 rows,
    // the same 5 the filter already matched, since this test seeds no other rows). Both by
    // `DroppedPlaceholderFreeAlternativeChangesTheCount`.
    procedure CountDecoyOrTarget(MainNo: Code[20]): Integer
    var
        Related: Record "Data Related";
    begin
        Related.SetFilter("Main No.", 'FLT-G-DECOY|%1', MainNo);
        exit(Related.Count());
    end;

    // ---------------------------------------------------------------------------------------
    // ARM H -- the REFUSAL negative: a CLOSED range classifies successfully but no rule in the
    // ladder targets it (spec section 2.2 step 4; section 5's deferred closed-range item).
    //
    // Scoped with SetRange("Main No.", 'FLT-H'). The upper bound is a COMPUTED expression
    // (LowBound + 2), not a second bare identifier (finding 7): two bare same-typed identifiers
    // would let Tier-1 lethal.swap-call-arguments claim this site instead, and that mutant's
    // verdict would rest on an unmeasured platform question (does BC normalise a reversed range
    // inside a filter string) this arm cannot answer either way. A computed expression makes that
    // operator refuse.
    //
    // Rows across the closed range (LowBound=79190 and LowBound+2=79192; LowBound+1=79191
    // deliberately left to the residue decoy instead, tagged differently, so the decoy sits
    // INSIDE the same numeric range without being counted by the Main No. scope alone) plus that
    // residue decoy.
    //
    // PREDICTED: flip-filter-literal emits NOTHING (ladder exhaustion, not a parser refusal).
    // void-method-call (deleting the SetFilter, leaving the SetRange) SURVIVED (counts the same 2
    // FLT-H rows the closed-range filter already matched -- the filter's own alternatives already
    // cover the arm's full seeded set). remove-setrange (deleting the SetRange, leaving the
    // SetFilter unscoped) KILLED (the range now also admits the residue decoy sitting inside it
    // -- 3, not 2). Both scored collateral verdicts by `ClosedRangeCountIsScopedByMainNo`.
    procedure CountInRange(LowBound: Integer): Integer
    var
        Related: Record "Data Related";
    begin
        Related.SetRange("Main No.", 'FLT-H');
        Related.SetFilter("Entry No.", '%1..%2', LowBound, LowBound + 2);
        exit(Related.Count());
    end;

    // ---------------------------------------------------------------------------------------
    // ARM I (R141) -- the CHARACTER refusal negative, the other half of arm H.
    //
    // The operator refuses a filter string two structurally different ways, and until this arm
    // only one had ever run against a real server. Arm H measures LADDER EXHAUSTION: a closed
    // range CLASSIFIES and then no rule in the ladder matches it. This arm measures the CHARACTER
    // refusal, which happens earlier and for a different reason: `REFUSED_CHARACTERS` in
    // packages/builtin-tier2/src/filter-expression.ts is /[*?@()'&]/, so the mini-parser declines
    // the string outright and nothing is ever classified.
    //
    // The inner quote is the character worth measuring. `<>''` (not blank) is the commonest `<>`
    // shape in real AL, and it is the population where a BROKEN character refusal would do its
    // worst: rule 1 would rewrite `<>` to `=`, handing BC a filter the mini-parser never
    // validated. That fails in the bad direction -- a runtime filter error scores `killed` with no
    // assertion earning it and nothing tagging the mechanism (R86, R138) -- which is exactly the
    // false kill this project exists to catch.
    //
    // The AL literal is '<>''''' : five quotes, four of them the AL escape for the two inner
    // quotes BC's filter DSL reads as an empty string. Measured against Cronus283
    // (scripts/r141-filter-probe/, README.md there records the run): BC accepts it, reports the
    // filter back as `<>''`, and counts the non-blank rows.
    //
    // SCOPED BY ENTRY NO. BAND, not by "Main No.", and that is forced rather than stylistic: the
    // filter's own target field IS "Main No.", so a "Main No." scope would make the not-blank
    // filter redundant (every row in scope carries the tag), the baseline would equal the
    // filter-deleted count, and the arm's own assertion would no longer prove the filter ran at
    // all. The band's upper bound is a COMPUTED expression (LowBound + 3) for arm H's reason:
    // two bare same-typed identifiers would let Tier-1 lethal.swap-call-arguments claim the site.
    //
    // Seeding is the probe's, exactly: two tagged rows and one BLANK row inside the band, plus a
    // tagged residue decoy OUTSIDE it. The blank row is what makes the filter do work (without it
    // the filter matches the whole band); the out-of-band decoy is what makes the SetRange do work
    // (without it the unscoped mutant counts the same 2 and survives on data starvation).
    //
    // PREDICTED: flip-filter-literal emits NOTHING (character refusal, not ladder exhaustion --
    // and not the same code path as arm H's). void-method-call (deleting the SetFilter, leaving
    // the band scope) KILLED (counts the blank row too -- 3, not 2; MEASURED). remove-setrange
    // (deleting the SetRange, leaving the not-blank filter unscoped) KILLED (counts the
    // out-of-band decoy too -- 3, not 2; MEASURED). Both collateral verdicts by
    // `NotBlankFilterCountsOnlyTaggedRows`.
    procedure CountTaggedInBand(LowBound: Integer): Integer
    var
        Related: Record "Data Related";
    begin
        Related.SetRange("Entry No.", LowBound, LowBound + 3);
        Related.SetFilter("Main No.", '<>''''');
        exit(Related.Count());
    end;
}
