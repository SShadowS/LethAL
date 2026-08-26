# R164: `loop-truncate`, and the cession that has to come with it

Design, written before any code. R164 says the precedence question "has to be designed rather than
bolted on", and the first thing the design found is that the mechanism everyone would reach for does
not work here.

## 1. The finding that changes the design

**§3.2 tier precedence CANNOT displace the hanging mutant.** `dedupeSpecs` keys on
`before.kind`, `before.startIndex`, `before.endIndex` **and `after.text`**
(`packages/schemata/src/dedup.ts:22`), so the replacement TEXT is part of the identity. At
`until Rec.Next() = 0`, `negate-conditional` produces `Rec.Next() <> 0` and `loop-truncate` would
produce `true`: same node, same span, DIFFERENT text, therefore two different identities, and both
survive. Making `loop-truncate` Tier 2 would change nothing.

So without an explicit cession this operator ADDS a mutant beside the hanging one and fixes nothing.
That is the whole reason R164 could not be closed by "add an operator", and it is now measured rather
than suspected. The rule itself is correct: it is what lets a swap and a deletion coexist at one call
site (R82) and a filter splice coexist with a deletion (R134). It just does not do what this row
needs.

## 2. Measured: the loop landscape on `do-rel2/Cloud`

426 loops in executable bodies, 367 of them carrying an exit condition:

| loop kind | count |
| --- | ---: |
| `repeat` | 334 |
| `for` | 46 |
| `while` | 33 |
| `foreach` | 13 |

Of the 334 `repeat` loops, **313** compare against a `.Next(...)` call and **292** match the strict
canonical `<rec>.Next(...) = 0`.

**Who claims a loop exit condition today**, which turns out to be four operators, not one:

| operator | at `repeat` | at `while` |
| --- | ---: | ---: |
| `negate-conditional` | **327** | 11 |
| `conditional-boundary` | 8 | 16 |
| `remove-not` | 8 | 8 |
| `toggle-blank-string` | 3 | 2 |

R164 is written about "290 loop-exit negations". The negation is 327 of the 346 claims at `repeat`,
so it is 95% of the problem but not all of it. Two Tier-1 operators, `shift-integer` and
`negate-guard`, ALREADY refuse loop conditions outright for exactly this reason, so the codebase is
currently inconsistent about it.

## 3. The operator

**`lethal.loop-truncate`, Tier 1**: rewrite a `repeat` loop's exit condition to `true`, so the body
executes exactly once.

**334 raw sites, 25x R13's bar.** A survivor is a precise statement, and an unusually useful one:
*no test drives this loop over more than one row*, which is the most common weakness in a BC suite.
It scores on the default path, needs no session kill, and cannot hang, because `until true` has no
input that fails to terminate.

**Scoped to `repeat_statement` only.** `while`, `for` and `foreach` are deliberately out.
`while <cond>` has no "run once" rewrite: `while false` runs the body ZERO times, which is a
different mutation with its own overlap question. `for` and `foreach` have no boolean exit condition
at all. That is 92 loops left alone, and it is a separate question rather than a gap in this one.

## 4. The cession: `negate-conditional` refuses a `repeat` exit condition

A Tier-1 to Tier-1 cession, coded in the operator, exactly as R171 built one between `remove-not` and
`negate-guard`. It is a POSITIONAL refusal of the same kind `shift-integer` and `negate-guard`
already carry, so it makes three operators consistent rather than making one special.

**Why the negation specifically, and not all four claimants.**

At the canonical shape the negation is both the hazard and a duplicate:

```al
repeat BODY until Rec.Next() = 0;     // original: BODY per row
repeat BODY until Rec.Next() <> 0;    // >=2 rows: BODY once, then exit. <=1 row: NEVER TERMINATES
repeat BODY until true;               // BODY once, always
```

On a set of two or more rows the negation and the truncation express the SAME mutation, the body runs
once, differing only in where the cursor ends. On a set of one row or none, which is the common
fixture shape, the negation does not terminate. So ceding loses nothing measurable at 292 of the 327
sites, and removes the hazard at all 327.

**The other three keep their claims, deliberately.** `conditional-boundary` shifts a bound by one,
which usually makes a loop run one extra iteration rather than never finish, and it is not a
duplicate of truncation. `remove-not` (8 sites) and `toggle-blank-string` (3) have an unmeasured
hazard. Ceding any of them would also delete a WORKING mutant from a gate: `itest:hang`'s M0005 is
`conditional-boundary` on `until Counter >= Limit`, it terminates, and it is killed. Removing a
terminating, killed mutant to prevent a hypothetical hang is a real cost against no measured benefit.

**The residual is recorded, not hidden.** After this build, 19 claims at `repeat` conditions and 37
at `while` conditions remain hang-capable in principle. That gets its own roadmap row carrying these
numbers, rather than being absorbed into a closing note here.

## 5. The fixture arm, and why it is recordset-free

R164 rules the arm belongs in `fixtures/sandbox-hang`, whose gate runs both legs and already isolates
non-termination so the scored gates never pay for it. `sandbox-hang` has no tables, and it should not
gain one. `HangLogic`'s own doc comment explains why the original arm avoided a real recordset, and
the reasoning applies here unchanged:

> That hang depends on table data, which makes it useless as a fixture: it would hang or not
> depending on what happened to be in the table when the run started.

So the arm mimics `Next()` exactly, deterministically:

```al
/// Returns 1 while rows remain and 0 once exhausted, and 0 forever after: BC's `Rec.Next()`
/// contract with no table behind it.
local procedure NextRow(): Integer
begin
    if Remaining <= 1 then begin
        Remaining := 0;
        exit(0);
    end;
    Remaining -= 1;
    exit(1);
end;

procedure CountRows(Rows: Integer): Integer
var
    Seen: Integer;
begin
    Remaining := Rows;
    repeat
        Seen += 1;
    until NextRow() = 0;
    exit(Seen);
end;
```

`CountRows(1)` returns 1 and `CountRows(3)` returns 3, matching a real `FindSet`/`Next` walk. Negated
to `until NextRow() <> 0`, the one-row case never terminates, which is R164's hazard reproduced with
no data dependency at all.

## 6. What the arm has to prove, in order

1. **BEFORE the cession**, with `loop-truncate` registered and `negate-conditional` unchanged: the
   arm's negated mutant is scored **`timeout-killed`**, taking `itest:hang` from 3 non-terminating
   to **4**. This measurement proves the hazard is real on this shape rather than assumed, and it has
   to be taken before the fix, because afterwards it is unobservable.
2. **AFTER the cession**: the non-terminating count returns to **3**, and the mutant at that span is
   `lethal.loop-truncate` rather than `lethal.negate-conditional`. That is an operator-NAME change
   the per-mutant baseline catches and a matching total would not, which is R171's lesson.
3. **`loop-truncate` is killable**: the covering test asserts `CountRows(3) = 3`, so `until true`
   returns 1 and dies. A test driving only ONE row would make it an equivalent mutant, which is why
   the arm takes a row count at all.

## 7. What would refuse the build

- Step 1 not producing a `timeout-killed`. Then the shape does not hang here, the arm is not the
  canonical hazard, and the cession would rest on reasoning rather than measurement.
- The non-terminating count NOT returning to 3 after the cession: something else at that span still
  hangs, and the cession is incomplete.
- `loop-truncate` surviving on a fixture whose test drives three rows: the operator does not do what
  it claims.
