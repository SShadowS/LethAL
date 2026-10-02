# R404 pre-commitment: two whole-member `#if` arms declaring the same procedure (r2)

Task: `H:/lethal-coord/tasks/R-404/task.md`. Item: `docs/roadmap/R404.md`. Lane `lethal-preproc`, master d83b131e. **Committed BEFORE any live run.** No product code changes in this task.

**r2 (before any run, at the orchestrator's request).** r1 (68ad78d9) covered only an active FIRST (`#if`) arm. r2 adds Bar, whose SECOND (`#else`) arm is the active and covered one. That is the risky case: an attribution that resolves the name to the first span would lose the `#else` arm's covered lines, and a reached mutant would read `no-coverage`. In each pair the twins now have different lengths, in both directions: Foo's `#else` is longer than its covered `#if`, and Bar's `#if` is longer than its covered `#else`. So no span lines up with its twin by accident. r1 ran nothing (the dry runs only); every r1 prediction is replaced below.

## Question
`packages/runner/src/line-map.ts` spans every member it finds, in every arm. One shape has never been checked against coverage attribution, and so against `no-coverage` verdicts: two WHOLE-member arms in one object that declare the same name.

- **The right answer:** a mutant in the compiled arm is covered exactly when a test executes that arm, whichever arm (first or second) it is.
- **A failure:** coverage from the other procedure or the object attributed to it; or a reached arm read as `no-coverage`.

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
    var
        Y: Integer;
    begin
        Y := X + 100;
        if X > 1000 then
            exit(0);
        exit(Y);
    end;
#endif

#if LETHALX
    procedure Bar(X: Integer): Integer
    var
        Z: Integer;
    begin
        Z := X * 3;
        if X > 1000 then
            exit(0);
        exit(Z);
    end;
#else
    procedure Bar(X: Integer): Integer
    begin
        if X > 1000 then
            exit(0);
        exit(X - 1);
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
    procedure BarOnlyWithoutX()
    begin
#if not LETHALX
        if Logic.Bar(5) <> 4 then
            Error('Bar(5) must be 4 in the no-symbol build');
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

| Build | Foo | Bar |
|---|---|---|
| `[X]` | reached, FIRST arm (short; its `#else` twin is longer) | not reached |
| `[]` | not reached | reached, SECOND arm (short; its `#if` twin is longer) |

`PlainDoubles` covers the OBJECT in both builds.

## Deployed mutants (offline, `generateMutationSet` + `writeInstrumentedProject` on d83b131e)
Each build has 9. The member span is the manifest's `procedureStartLine`-`procedureEndLine`, and `reachGrain` is `statement` for all.

| # | Build | Member, arm | Operator | Original | Span |
|---|---|---|---|---|---|
| N1 | `[]` | Foo `#else` | empty-block | body | 11-19 |
| N2 | `[]` | Foo `#else` | remove-assignment | `Y := X + 100` | 11-19 |
| N3 | `[]` | Foo `#else` | conditional-boundary | `X > 1000` | 11-19 |
| N4 | `[]` | Foo `#else` | return-value | `exit(Y)` | 11-19 |
| N5 | `[]` | Bar `#else` | empty-block | body | 33-38 |
| N6 | `[]` | Bar `#else` | conditional-boundary | `X > 1000` | 33-38 |
| N7 | `[]` | Bar `#else` | return-value | `exit(X - 1)` | 33-38 |
| N8 | `[]` | Plain | empty-block | body | 41-44 |
| N9 | `[]` | Plain | return-value | `exit(X * 2)` | 41-44 |
| X1 | `[X]` | Foo `#if` | empty-block | body | 4-9 |
| X2 | `[X]` | Foo `#if` | conditional-boundary | `X > 1000` | 4-9 |
| X3 | `[X]` | Foo `#if` | return-value | `exit(X + 10)` | 4-9 |
| X4 | `[X]` | Bar `#if` | empty-block | body | 23-31 |
| X5 | `[X]` | Bar `#if` | remove-assignment | `Z := X * 3` | 23-31 |
| X6 | `[X]` | Bar `#if` | conditional-boundary | `X > 1000` | 23-31 |
| X7 | `[X]` | Bar `#if` | return-value | `exit(Z)` | 23-31 |
| X8 | `[X]` | Plain | empty-block | body | 41-44 |
| X9 | `[X]` | Plain | return-value | `exit(X * 2)` | 41-44 |

Before the run, a dry run on each backend must report **9 deployed** per build. Any other count is a STOP.

## Predictions (identical on al-runner and bcdev, per mutant)
| # | Verdict | Killing / covering test |
|---|---|---|
| N1, N2, N3, N4 | **no-coverage** | none (Foo is not called under `[]`) |
| N5, N7 | **killed** | `R404 Tests.BarOnlyWithoutX` (Bar returns 0, not 4) |
| N6 | **survived**, covered | `BarOnlyWithoutX` (`X >= 1000` does not change `Bar(5)`) |
| N8, N9 | **killed** | `R404 Tests.PlainDoubles` |
| X1, X3 | **killed** | `R404 Tests.FooOnlyUnderX` (Foo returns 0, not 11) |
| X2 | **survived**, covered | `FooOnlyUnderX` |
| X4, X5, X6, X7 | **no-coverage** | none (Bar is not called under `[X]`) |
| X8, X9 | **killed** | `R404 Tests.PlainDoubles` |

Totals per build: `[]` is 4 killed, 1 survived, 4 no-coverage; `[X]` is 4 killed, 1 survived, 4 no-coverage. That gives **36 predictions** (18 mutants × 2 backends), matched PER MUTANT, not by count. N6 and N5/N7 are the second-arm cases: if they come back `no-coverage`, the defect the orchestrator named is real.

**Gates for each run:**
- the baseline is green (all 3 tests pass in both builds, on both backends);
- the report's `buildSymbols` equals the build;
- on al-runner, coverage is ON (`alRunner.coverage: "al-runner"`), and the report's `coverageMode` is not `"none"`.

A run that fails a gate cannot answer the question. It is recorded and re-run, never read as a result.

## What is recorded per run (the evidence for the ruling)
- **The report:** per-mutant verdict, `killingTest`, `executionProven`, and covering tests.
- **Coverage rows** for `R404 Logic`, and the member each was attributed to. On bcdev these are the fenced rows (object and line) against the line map of the EMITTED source; on al-runner, its `--coverage` output. All five spans are listed: Foo ×2, Bar ×2 and Plain.
- **Expected covered spans:** under `[X]`, the Foo FIRST span and Plain only; under `[]`, the Bar SECOND span and Plain only. No line may land in an inactive twin's span.

## Procedure
1. **al-runner** (the pinned build `H:/al-runner-builds/c39ad5de/al-runner.exe`, one-shot, `coverage: "al-runner"`): `lethal run` on the target with `--test-dir` set to the tests, once per build, with `preprocessorSymbols` `[]` and then `["LETHALX"]`. al-runner compiles both apps with the defines.
2. **bcdev on Cronus28,** under `bash scripts/coord.sh lease Cronus28 preproc`. For each build:
   - compile the plain target (`/define` per build) into the tests' `.alpackages`;
   - compile the tests app with the same defines;
   - publish the target, then the tests (scratch apps only, with version bumps between builds);
   - then `lethal run` with the same `preprocessorSymbols`.

   Afterwards: unpublish both scratch apps (tests first), and release the lease. Gate fixtures are not touched.
3. Reports and logs go to `H:/lethal-scratch/R-404/out/`.

## Ruling rule
- **If all 36 verdicts match,** and the covered spans are as stated, R404 closes BY RULING, with no change.
- **If ANY verdict differs,** I STOP and send the orchestrator a short plan (lead: R378's `armOf` on the target's ranges in the span builder), with no code.
