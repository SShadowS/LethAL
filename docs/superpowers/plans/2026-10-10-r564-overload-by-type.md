# R-564 plan r2: choose a HOP callee's overload by argument type (lethal-preproc, 2026-10-10)

**r2: these rules REPLACE r1's "Rule" section** (opus plan review r1, `review-opus-plan-r1.md`: B1, B2 and I1
were blocking or important).

**Identity, not spelling.** Two engine helpers in receiver.ts, beside `resolveReceiverTable`:
- `recordTableObjectOfName(name, at, ctx)`: the project TABLE object a bare-name argument binds to. It uses
  `lookupDeclaredState` and returns null on "unknown" (an ambiguous `#if` local, an unindexed member, a `#if`
  trigger-header name), so it never falls through to the implicit record. It also returns null when the record's
  table does not resolve (`resolveTable`) to a project table.
- `tableObjectOfRef(idOrName, ctx)`: a parameter's `Record` reference, by id or name, resolved by `resolveTable`
  to a project table, else null.

Two tables are "the same" only when both resolve to the same project table object; "different" only when both
resolve, to different ones. Everything else is unknown.

**Narrow only when ALL of these hold:**
1. **No candidate is preprocessor-split:** each has exactly one `parameter_list`, with no preprocessor node in it.
2. **Every argument resolves:** `recordTableObjectOfName` is non-null for each argument.
3. **Every candidate's every parameter is a `Record` type whose table resolves** (`tableObjectOfRef`). One
   Variant, RecordRef, enum, Integer or unresolvable parameter anywhere keeps all.
4. **Exactly one candidate matches POSITIVELY** (same table at every position), and **every other candidate
   mismatches DEFINITELY** (different tables at some position).

If any condition fails, keep ALL candidates, as today. The DO payoff passes all four (measured: one argument,
`xRec`, and two all-Record overloads of two different project tables).

**Tests** (r1's T1 to T7 stand, re-based on this rule), plus:
- **T8:** one test per spelling form, each with a Variant sibling, each staying refused:
  - an argument declared by id against a parameter by name, and the reverse;
  - a qualified against an unqualified name;
  - `xRec` in a tableextension with a qualified `extends`.
- **T9:** a split (`#if`) callee keeps all.
- **T10:** RecordRef beside Variant keeps all.
- **T11:** all 4 call sites wired, including the R562 table/codeunit path and `r531TableProcs` with a
  tableextension of the table.
- **T12:** two candidates match positively (identical parameter tables), so both are kept. This fails if "several
  survive" kept the survivors only.
- **T13:** an `#if`-ambiguous local argument (I1) keeps all.
- **Comment-node arguments:** `F(xRec /*c*/)` keeps today's behaviour at every site. If "no candidates" does not
  refuse at a site, it is filed.

**The alc probe** (`scratch/`) checks that a Record A argument fails to compile against a by-value, a `var` and a
`temporary` `Record B` parameter.

---


Branch `lethal/r564` from master 0c967952. Measurement: `measure.md`. Only DO's 2 calls are affected (+8 keys); no
key or ordinal moves, so the scheme stays 39.

## Rule (the orchestrator's, made concrete)
At `r531ProcsIn`, when more than one overload fits the call by parameter count, narrow ONLY when ALL of these hold:
1. **Every argument is known:** each argument is a bare name that resolves to a RECORD of a known table, through
   `recordTableOfName` (the engine's receiver resolution, exported). A literal, an expression, a field, an Integer
   variable, a RecordRef, a Variant: any of these makes the call unknown, and all overloads are kept.
2. **An overload is ruled out** only when, at some position, its parameter is declared `Record B` and the
   argument's table A is not B (normalized names). An overload whose parameter at a position is anything other
   than a `Record` type (Variant, RecordRef, Integer, an enum, a codeunit, unresolvable) is NEVER ruled out by
   that position.
3. **Exactly one overload survives.** Then follow only it. If none or several survive, keep ALL (unchanged).

## Why each case is safe (the un-refusal direction: a wrongly dropped overload re-deploys a hang)
- **A Record A argument cannot bind to a `Record B` parameter.** AL has no implicit conversion between record
  types; alc rejects it. So the dropped overload is one the call can never reach. This is to be pinned by an alc
  probe in the build (`scratch/`): the same call with only the wrong-typed overload must fail to compile.
- **Variant and RecordRef parameters are never ruled out** (rule 2). So if AL could choose a Variant or RecordRef
  overload for a Record argument, that overload is kept. When both a Record and a Variant overload fit, two
  survive, and both are kept by rule 3. No AL tie-breaking preference is assumed.
- **Option and enum parameters** cannot take a Record argument, but they are kept anyway (rule 2,
  conservative). The rule needs no claim about them.
- **Temporary, `var` and by-value Record parameters** match on the table name only. AL binds a Record argument to
  all of them by table.
- **tableextensions:** a Record parameter names the base table; extensions do not create a record type.
  `objectsOfType` lists the table and its extensions, and each object's overloads are narrowed on their own. An
  overload pair split across a table and its extension is never narrowed (each list has one), which is
  conservative.
- **Unknown argument resolution** (`recordTableOfName` null) means rule 1 fails, so everything is kept.
- **The receiver, for a `Rec.P()` call:** only the arguments are typed. The receiver selects the object, as today.

## Change
- engine: export `recordTableOfName(name, at, ctx)` (receiver.ts, beside `resolveReceiverTable`).
- loop-hazard.ts: `r531ProcsIn(obj, name, arity, call, ctx)` gets the narrowing, with no env var. All 4 call sites
  pass the call node and `ctx`: `r531TableProcs`, the R562 same-object path, the R562 table/codeunit path, and the
  R531 HOP loop.
- Doc comment on `r531ProcsIn` and the R531/R562 header prose: overloads are chosen by argument type when every
  argument is a known record and exactly one survives.

## Tests (packages/builtin-tier1/tests, each red-checked per direction)
- **T1, type picks one:** a table with `F(R: Record A)` and `F(R: Record B)`, both setting a filter that a
  consuming loop's exit depends on. The caller passes `xRec` (table A). The B overload's `SetRange` mutant is
  DEPLOYED, and the A overload's stays refused. (Revert the narrowing: B refused, red.)
- **T2, an unknown argument keeps all:** the same, with a field or literal argument, or a `RecordRef` variable.
  Both stay refused. (Narrow regardless of unknown arguments: red.)
- **T3, two survive and both are kept:** `F(R: Record A)` and `F(V: Variant)`. Both stay refused. (Treat Variant as
  a mismatch: red.)
- **T4, none survive and all are kept:** a call whose argument table matches neither (a resolution gap). Both stay
  refused. (Return the empty list: red.)
- **T5, the R531 consumer HOP path**, and **T6, the R562 same-object path:** T1's shape through each call site, so
  every site is wired. (Drop `call`/`ctx` at that site: red.)
- **T7, two arguments, one unknown:** `F(A: Record A; N: Integer)` vs `F(B: Record B; N: Integer)` called with
  `(xRec, 5)`. All kept, because rule 1 requires every argument known. (Relax rule 1: red.)

## Live
No gate fixture has the shape (fixtures +0, measured). The live effect is the 8 DO keys, verified by the identity
diff. No scheme change.
