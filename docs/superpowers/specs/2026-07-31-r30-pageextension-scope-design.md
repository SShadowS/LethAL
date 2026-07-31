# R30 close-out — `pageextension` variable scope, and the first LIVE proof of extension mutants

**Status:** design, 2026-07-31. Closes the last measured hole in R30 and converts extension support
from unit-only to live-gated.

## 1. Where R30 actually stands

Two of R30's three halves shipped 2026-07-28:

1. `OBJECT_KINDS` (`packages/builtin-tier2/src/receiver.ts`) admits `tableextension`/`pageextension`,
   and an implicit `Rec`/`xRec` inside a `tableextension` resolves to the EXTENDED table through the
   header's `base_object` field. Measured on Continia Document Output: **+2** mutants.
2. `buildSymbolTable` indexes a `tableextension`'s own members (globals, procedure locals and
   parameters) for VARIABLE SCOPE, under a namespaced key (`extensionScopeKey`), so a call on a
   variable DECLARED inside a `tableextension` resolves. Measured on DO: **+18** (961 → 979).

**What is left, measured 2026-07-31 with `scripts/probe-r30-pageext.ts` against DO Cloud (554 `.al`
files):**

| shape | sites |
|---|---|
| Tier-2-shaped call on a record var **declared inside a `pageextension`** | **18** (1 file, all procedure locals) |
| Tier-2-shaped call on a `pageextension`'s implicit `Rec`/`xRec` | **0** |
| `pageextension`s extending a page **declared in this project** | **0 of 93** |

The probe is calibrated, not merely plausible: its `tableextension` count (17) reproduces the +18 the
symbol-table half actually gained, so its `pageextension` count of 18 is a like-for-like prediction
rather than a guess.

`pageextension` members are indexed **nowhere**: `parseTableExtensionHeader` matches only
`tableextension_declaration`, `parseObjectHeader`'s kind map omits both extension kinds, so a
`pageextension` node falls through the loop entirely. Every call on a variable declared inside one is
therefore refused as an unresolvable receiver (rule 4). Safe direction; still a hole.

That also makes the current doc comment in `receiver.ts` wrong in two places, and both are corrected
here: it claims the symbol-table half is "the remaining half of R30" (it shipped), and it claims that
inside a `pageextension` "only explicitly-typed record variables can claim" (they cannot — nothing
can).

## 2. What ships

### 2.1 `pageextension` members get a scope key (engine)

`buildSymbolTable` indexes a `pageextension`'s globals, procedure locals and parameters under a
scope key, exactly as it already does for `tableextension`. `extensionScopeKey` takes the object KIND
as well as the name — `tableextension:X` vs `pageextension:X` — because AL permits a `tableextension`
and a `pageextension` to share a name, and one namespace for both would let one extension's variables
resolve inside the other.

**`tableExtensions` stays table-only.** That array feeds `extensionDeclaresProcedure`, the rule-3
shadowing guard keyed on the extended TABLE. A `pageextension`'s `extends` target is a PAGE, so
adding it there would compare a page name against a table name — a coincidental match would refuse a
legitimate site, and, worse, the array is the only thing that documents "these declare procedures on
a table". Scope and shadowing are separate indexes and stay separate. A test pins it.

### 2.2 The implicit `Rec` of a `pageextension` stays refused

Unchanged, and now measured rather than reasoned: 0 such sites on DO, and 0 of 93 `pageextension`s
extend a page this project declares, so the `SourceTable` needed to resolve `Rec` is not available
even in principle. Claiming it would be a guess, and a wrong receiver CLAIMS a site wrongly —
mislabelling the mutation and suppressing the correct Tier-1 mutant under §3.2 dedup precedence.

### 2.3 The fixture grows an extension pair — the first live extension mutants

No fixture declares an extension object (`grep -rln '^tableextension\|^pageextension' fixtures/`
returns nothing), so **every extension mechanism above has only ever run in a unit test.** It has
never been instrumented, compiled by `alc`, published to a BC server, or executed. R62 states the
same fact from the other side: "no fixture's SymbolReference declares an extension array".

`fixtures/sandbox-data` gains:

- **`tableextension "Data Main Ext" extends "Data Main"`** with two procedures, one per mechanism:
  - `ExtRequireCategory` — an IMPLICIT `TestField(Category)`, which only claims if the implicit `Rec`
    resolves to the extended table (§1 half 1).
  - `ExtCountInCategory` — `Related.SetRange(...)` on a `Record "Data Related"` declared as a
    procedure LOCAL inside the extension (§1 half 2).
  Both are reachable from a test: a `tableextension`'s public procedures are callable on a variable
  of the extended table's type, which is the same AL rule the shadowing guard exists for.
- **`page "Data Main List"`** (code-free, `SourceTable = "Data Main"`) plus
  **`pageextension "Data Main List Ext"`** whose `OnOpenPage` carries a `SetRange` on a record
  declared as a trigger-procedure local — exactly the site §2.1 makes claimable — and writes an
  observable count onto a `Data Main` row.

Tests in `fixtures/sandbox-data-tests` kill the `tableextension` sites directly, and reach the
`pageextension` site by opening a `TestPage`.

**The `TestPage` leg is the one uncertain part of this design, and it is deliberately attempted
rather than assumed.** Every verdict runs in a `GuiAllowed=No`, `ClientType=ODataV4` session (R57/R60);
whether a `TestPage` opens there is not measured. If it does not, the test is removed and the
`pageextension`'s mutants stay in the fixture as permanent `no-coverage` entries — which still proves
instrumentation, `alc` compilation, publication and installation of a `pageextension`-carried guard
on a live server, none of which has been proven before — and the spec records `pageextension` scope
resolution as **unproven live**. The fallback is stated up front so a failure is a recorded outcome
rather than an improvisation.

### 2.4 The tables baseline moves, by construction

New sites mean new deployed mutants. Per the execution plan's stop conditions, that is expected for
this item and is NOT a regression — but **every pre-existing mutant must keep its verdict.** The gate
is the per-mutant join on the pre-existing set; new mutants have no frozen entry by construction. The
baseline is re-recorded deliberately (`LETHAL_RERECORD_BASELINE=1`) and then PROVEN to compare
against itself on a second run, because R29 exists precisely because a committed baseline could never
match itself and nobody noticed.

## 3. Safety analysis

The failure direction that matters is a WRONGLY CLAIMED site: Tier 2 outranks Tier 1 in §3.2 dedup
precedence, so a wrong claim both mislabels the mutation and deletes the correct Tier-1 mutant.

| change | can it claim a site it should not? |
|---|---|
| index `pageextension` members for scope | Only a call whose receiver is a variable DECLARED IN THAT EXTENSION and typed `Record` becomes claimable. The type classification (`classifyDeclaredType`) is unchanged, and rule 3's shadowing guard still applies to whatever table the receiver names. |
| kind-namespaced scope key | Strictly narrowing: without the kind, a `pageextension` named like a `tableextension` would resolve the other's variables. |
| `tableExtensions` unchanged | The shadowing guard's input set does not move, so no site becomes claimable by a guard that stopped firing. |

Direction of the residual risk is unchanged from R30's original entry: a missed site costs one
operator's signal, and Tier-1 `void-method-call` still covers it.

## 4. Testing

Unit (engine): a `pageextension`'s globals/locals/parameters resolve under the kind-namespaced key;
`resolveProcedure("<bare extension name>", …)` still answers `null` for BOTH kinds; a same-named
`tableextension` and `pageextension` do not share variables; `tableExtensions` still contains only
table extensions.

Unit (tier-2): a `SetRange` on a record local declared inside a `pageextension` is claimed; the same
call inside a `pageextension` on an implicit `Rec` is still refused; rule 3 still refuses a call whose
name a `tableextension` declares on the receiver's table.

Every fix red-checked by revert (`mutation-red-checker`), because a test that passes with the change
reverted closes nothing.

Fixture: `bun run compile:fixtures` — mandatory, R56 is exactly the failure of not doing it.

## 5. Gates

- `itest:tables` — primary. Per-mutant on the pre-existing set; new sites enumerated and explained.
- `itest:bcdev` — must be unchanged at 3/10/3 (that fixture declares no extension, so a move there
  would mean the engine change leaked into a project with no extensions at all).
- `compile:fixtures` — AL changed.
- `itest:alrunner`/`itest:envtool` are not required: neither fixture gains an extension, and both run
  the same `sandbox-app` target as `itest:bcdev`.

## 5a. Outcome (recorded 2026-07-31, after the gates)

**The `TestPage` leg failed, in the way §2.3 named as possible, and the fallback was taken.** The
test was written, compiled, published to Cronus283 and run. The fenced session went
`in-flight-unknown` on `PageExtCountsMatchingRelated` **at baseline**, the run quarantined the tier
and scored nothing (`killed=0 survived=0 noCoverage=0 baselineGreen=true`), and recovery needed
`force-reset-lease` (serverGeneration rotated, epoch → 91). Opening a `TestPage` on the
`GuiAllowed=No` / `ClientType=ODataV4` path hangs rather than failing. Filed as **R69** — it is much
bigger than this fixture, because R58 made the fenced path the default for baselines too and a real
BC suite uses TestPage heavily.

The test was removed; the `page`/`pageextension` pair stayed. Final figures: `itest:tables`
**69 killed / 9 survived / 6 no-coverage** over 84 deployed mutants (93 raw specs),
`untargetedTriggerCount` 0, run twice verdict-identical. Per-mutant join against the previous
baseline: **0 changed verdicts on pre-existing keys, 0 missing, 9 new** (5 tableextension, all
killed; 4 pageextension, all no-coverage). `itest:bcdev` unchanged at 3/10/3.

One design detail was wrong in the first draft and is corrected here: the pageextension's records
were declared inside the `OnOpenPage` trigger, and a variable declared in a TRIGGER's own `var`
section is resolved in NO object kind (`lookupVar` handles procedure locals, parameters and object
globals only). That generated four specs with no `remove-setrange` among them. Moving the
declarations to the extension's own `var` section made the site claimable. The gap itself is **R68**.

## 6. What this does NOT prove

- `pageextension` scope resolution is proven live only if the `TestPage` leg works; otherwise it is
  unit-proven plus the DO measurement, and the roadmap row must say so.
- The implicit `Rec` of a `pageextension` remains unresolvable by design. A project whose
  `pageextension`s extend its OWN pages would have a resolvable `SourceTable`; DO has zero such
  cases, so it is not built. Filed separately if a project ever wants it.
- Nothing here changes coverage attribution for extension objects — R40 measured BC reports an
  extension's code under the EXTENSION's own object id, and `buildCoverageMap` already maps types 14
  and 15. The fixture's new extension mutants are the first live exercise of that mapping.
