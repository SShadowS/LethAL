# R404 pre-commitment: two whole-member `#if` arms declaring the same procedure

Task: `H:/lethal-coord/tasks/R-404/task.md`. Item: `docs/roadmap/R404.md`. Lane `lethal-preproc`, master d83b131e. **Committed BEFORE any live run.** No product code changes in this task.

## Question
`packages/runner/src/line-map.ts` spans every member it finds, in every arm. One shape has never been checked against coverage attribution, and so against `no-coverage` verdicts: two WHOLE-member arms in one object that declare the same name (`#if X procedure Foo() ... #else procedure Foo() ... #endif`).

- **The right answer:** a mutant in the compiled arm is covered exactly when a test executes that arm.
- **A failure:** a covered line from the other procedure, or from the object, attributed to Foo; or a reached Foo reported `no-coverage`.

## Scratch fixture (outside `fixtures/`, in `H:/lethal-scratch/R-404/`; never a gate)
- **Target** `target/` (app "LethAL R404 Scratch", id `4f3a2b10-4040-4404-8404-000000079900`, ids 79900-79949, runtime 13.0, no dependencies), `src/R404Logic.Codeunit.al`:

```al
codeunit 79900 "R404 Logic"
{
#if LETHALX
    procedure Foo(X: Integer): Integer
    begin
        if X > 1000 then
            exit(0);
        exit(X + 10);
    end;
#else
    procedure Foo(X: Integer): Integer
    begin
        if X > 1000 then
            exit(0);
        exit(X + 100);
    end;
#endif

    procedure Plain(X: Integer): Integer
    begin
        exit(X * 2);
    end;
}
```

- **Tests** `tests/` (app "LethAL R404 Scratch Tests", id `...079950`, ids 79950-79999, depending on the target), `src/R404Tests.Codeunit.al`:

```al
codeunit 79950 "R404 Tests"
{
    Subtype = Test;

    var
        Logic: Codeunit "R404 Logic";

    [Test]
    procedure FooOnlyUnderX()
    begin
#if LETHALX
        if Logic.Foo(1) <> 11 then
            Error('Foo(1) must be 11 in the LETHALX build');
#endif
    end;

    [Test]
    procedure PlainDoubles()
    begin
        if Logic.Plain(2) <> 4 then
            Error('Plain(2) must be 4');
    end;
}
```

So the test that reaches Foo reaches it under `[LETHALX]` ONLY. Under `[]` it runs but calls nothing. `PlainDoubles` covers the OBJECT in both builds, which is what would expose an attribution that lets object-level or other-member coverage leak onto Foo.

## Deployed mutants (offline, `generateMutationSet` + `writeInstrumentedProject` on d83b131e)
These are the same 5 in each build. Foo's mutants come from the arm that build compiles, and the 3 sites in the other arm are `compiled-out`. Each is identified by build, member, operator and original text:

| # | Build | Member (manifest) | Operator | Original | Manifest member span |
|---|---|---|---|---|---|
| N1 | `[]` | Foo | empty-block | the `#else` body | 11-16 |
| N2 | `[]` | Foo | conditional-boundary | `X > 1000` | 11-16 |
| N3 | `[]` | Foo | return-value | `exit(X + 100)` | 11-16 |
| N4 | `[]` | Plain | empty-block | Plain's body | 19-22 |
| N5 | `[]` | Plain | return-value | `exit(X * 2)` | 19-22 |
| X1 | `[X]` | Foo | empty-block | the `#if` body | 4-9 |
| X2 | `[X]` | Foo | conditional-boundary | `X > 1000` | 4-9 |
| X3 | `[X]` | Foo | return-value | `exit(X + 10)` | 4-9 |
| X4 | `[X]` | Plain | empty-block | Plain's body | 19-22 |
| X5 | `[X]` | Plain | return-value | `exit(X * 2)` | 19-22 |

Every mutant has `reachGrain: statement`. Before the run, a dry run on each backend must report **5 deployed** per build. Any other count is a STOP (rule 2).

## Predictions (identical on al-runner and bcdev)
| # | Verdict | Killing / covering test | Why |
|---|---|---|---|
| N1, N2, N3 | **no-coverage** | none | Under `[]` no test calls Foo. `PlainDoubles` covers the object, so the object-level coverage must NOT reach Foo |
| N4, N5 | **killed** | `R404 Tests.PlainDoubles` | Plain returns 0 instead of 4 |
| X1, X3 | **killed** | `R404 Tests.FooOnlyUnderX` | Foo returns 0 instead of 11 |
| X2 | **survived** | covered by `FooOnlyUnderX` | `X >= 1000` does not change `Foo(1)`. The arm is REACHED, so it must not be `no-coverage` |
| X4, X5 | **killed** | `R404 Tests.PlainDoubles` | as N4 and N5 |

Totals per build: `[]` is 2 killed, 0 survived, 3 no-coverage; `[X]` is 4 killed, 1 survived, 0 no-coverage. Both backends must match **per mutant**, not by count.

**Gates carried for each run:**
- the baseline is green (both tests pass in both builds, on both backends);
- the report's `buildSymbols` equals the build;
- on al-runner, coverage is ON (`alRunner.coverage: "al-runner"`), and the run's `coverageMode` is not `"none"`. A run with coverage off cannot answer the question, so it is a STOP, not a pass.

## What is recorded per run (the evidence for the ruling)
- **The report:** per-mutant verdict, `killingTest`, `executionProven`, and covering tests.
- **Coverage rows** for `R404 Logic`, and the member each line was attributed to:
  - al-runner: its `--coverage` output and the `serverSuite` / line-map member;
  - bcdev: the fenced coverage rows (object, line) and the line map's spans for the EMITTED source. Both Foo spans and the Plain span are listed.
- **Explicitly recorded:** which Foo span, if either, receives a covered line under each build. Expected: under `[X]`, lines in the FIRST Foo span (the active arm) only; under `[]`, no Foo line at all.

## Procedure
1. **al-runner** (the pinned build `H:/al-runner-builds/c39ad5de/al-runner.exe`, one-shot): `lethal run` on the target with `--test-dir` set to the tests, once per build, with the config's `preprocessorSymbols` set to `[]` and then `["LETHALX"]`. al-runner compiles target and tests itself, with the defines.
2. **bcdev on Cronus28,** under `bash scripts/coord.sh lease Cronus28 preproc`. For each build:
   - compile the plain target with alc (`/define` per build) into the tests' `.alpackages`;
   - compile the tests app with the same defines;
   - publish the target, then the tests app (scratch apps only, bumping versions between builds);
   - then `lethal run` with the bcdev config and the same `preprocessorSymbols`.

   Afterwards: unpublish both scratch apps (tests first), and release the lease. The gate fixtures' resident apps are not touched.
3. Reports and logs go to `H:/lethal-scratch/R-404/out/`. Reports carry only scratch source.

## Ruling rule
- **If all 20 verdicts** (10 mutants × 2 backends) match the table, and the attributed coverage is as stated, R404 closes BY RULING: the line-map span builder is right for this shape, and no change is made.
- **If ANY verdict differs,** I STOP and send the orchestrator a short plan (lead: R378's `armOf` on the target's ranges in the span builder), with no code. A differing verdict is never "close enough".
- **A run that cannot answer** (coverage off, baseline red, a wrong deployed count) is recorded as such and re-run, never read as a result.
