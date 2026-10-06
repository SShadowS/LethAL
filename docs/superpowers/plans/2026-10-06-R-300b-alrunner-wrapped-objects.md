# R-300b plan r2: score `#if`-wrapped objects on the al-runner paths only

r2, 2026-10-06, `lethal/r300b` at ee2fe651 (off master 44c22291). Plan text only. Folds in the Opus
review (REVISE: C1, I1-I3, minor). Evidence: `alrunner-results.md` (both legs, 2 rounds, H1 for W1, E1,
Q, R). The BC legs have not run.

## 0. Facts from the code that shape this plan

- **Inactive arms and undecided directives are already handled when mutants are generated.**
  `generateMutationSet` evaluates each file's arms under `effectiveBuildSymbols` (`app.json` + config +
  al-runner's predefined symbols; R214, R378). A site in a compiled-out arm is never generated
  (`startsInInactiveArm`). A file that `evaluateArms` calls `undecided` gets no mutant. So an
  inactive arm's lines carry no mutant, and al-runner never reports them. Nothing is guessed.
- **`LineMap` keeps one entry per `type:id`** (`byObject.set` overwrites, so the LAST declaration
  wins). Two arms of one wrapper declare the key twice. So do two FILES (C1: `#if BC24 codeunit 50100`
  in A, `#if not BC24 codeunit 50100` in B). Without a guard, a hit in A is named from B's procedures.

## 1. What lifts (al-runner one-shot, `--server`, resource selector mode)

**Admission rule.** One predicate in `line-map.ts`, `alRunnerAdmitsWrappedFile(root)`. It is true only
for the MEASURED shapes, each pinned live by the fixture in 6:
- exactly ONE top-level `preproc_conditional_object` that holds an object (`wrapperHoldsObject`);
- with no `preproc_else`/`preproc_elif` at its top level and no nested object wrapper;
- no object of any kind before or after it (narrowed per I2: code-free objects after the wrapper are
  NOT admitted, and `refusedAsMultiObject` is then false by construction);
- namespace, using and comment lines may sit before the `#if` or inside it; a statement-level `#if`
  inside the object is allowed. All three are in the fixture (I2).

**Indexing only the active declarations, and refusing duplicate keys (C1).** `buildAlRunnerCoverageIndex`
receives the session's effective symbols and runs `evaluateArms` on each instrumented file.
- A declaration in an inactive arm is NOT indexed and NOT added to `declared`. This applies to every
  file, wrapped or not.
- A file that is `undecided` is not indexed at all; it has no mutants anyway.
- After the pass, any key that is still declared in more than one indexed file is removed from the
  index and refused by name: `duplicateObjectReason` ("<key> is declared in <file A> and <file B>;
  coverage cannot tell them apart (R300)"). It goes into `exempt`, and selection reads the same refusal.
- This also fixes today's latent case: a plain object with a compiled-out wrapped twin elsewhere is
  no longer overwritten by the twin.

**Three consumers, one rule** (R387's precedent):
- `buildAlRunnerCoverageIndex`: an admitted file is indexed. Its `fileLineMapEntries` entries are kept
  with `refused` removed (destructure, no `!`), and the base line is 1. `resolveFileLine` then turns
  al-runner's FILE line into the same object line, which is H1.
- `alRunnerCoverageSupport`: `wrappedObjectFiles` lists only non-admitted files. Then `cli.ts`
  `applyAlRunnerCoverageGuard` no longer drops the run to `"none"` for an admitted file.
- `coverageRefusedObjects(files, backendKind, symbols)`: the backend kind is REQUIRED (minor).
  - Under `"al-runner"`: an admitted file adds no refusal, every other file keeps today's rule, and
    duplicate keys are refused as above.
  - Under `"bcdev"`: today's result exactly.
  - `orchestrator.ts` passes the session's kind. `verify.ts` (`refusedObjectsOfSources`) and
    `coverageRefusedFromSources` (hub) pass `"bcdev"` explicitly.

**`--server` disagreement (I3).** In `alRunnerCoverageFromServer`, a statement in an ADMITTED wrapped
file whose `scope` disagrees with the procedure its position names is DROPPED, with a named warning.
The position does not win there. The R383 rule (position wins) stays as it is for every other file.

**Not lifted on al-runner:** two-arm, nested, several wrappers, any object beside a wrapper, and
every multi-object file. Each keeps a named refusal. The new shapes say "a #if object wrapper of a
shape not measured on al-runner (R300)".

## 2. BC paths: unchanged, by name

No change to `fileLineMapEntries`, `LineMap` (`refused`, `isRefused`, `lookup`),
`buildFencedCoverageMap`, `nameRefusals`, `indexHubRefusals`, `buildCoverageMap`,
`coverageRefusedFromSources` (only the explicit `"bcdev"` argument is added), or
`verify.ts`/`verify-reach.ts`. They keep `refusedCoverageReason`. R300 stays open for them.

## 3. Path-separation tests (each one red in its own direction)

All three use the same source: the probe's W1 shape.
- **(a) bcdev:** `coverageRefusedObjects(files, "bcdev", …)` names W1. The fenced `LineMap` gives
  nothing for its lines. `coverageFilter` gives `no-coverage` with that note.
- **(b) al-runner:**
  - Cobertura (lines 10/14/18) and `--server` both give entries naming `Hit`.
  - The al-runner refusal set is empty.
  - The `Hit` mutant is covered, and the `Miss` mutant reads `no-coverage` as a real miss, not a refusal.
- **(c) one `runSession` test per backend,** on the same project, with the existing fakes.
  Hard-coding `"bcdev"` at the orchestrator call turns the al-runner test red. Hard-coding `"al-runner"`
  turns the bcdev test red. Both results are reported.

Each consumer and guard also gets its own red-check:
- **The admission rule:**
  - dropping it from the index, or from `alRunnerCoverageSupport`, goes red;
  - widening it to two-arm goes red (the Q shape names the wrong span);
  - widening it to code-free objects after the wrapper goes red.
- **C1:**
  - a unit test with the two-file pair (A active, B inactive) attributes A's hits to A. Dropping the
    active-only filter turns it red.
  - a pair with both declarations active is refused by name. Dropping the duplicate refusal turns it red.
- **I3:** a disagreeing `scope` on an admitted file drops the line. Letting the position win turns it red.

## 4. Edge cases

- **R (a bare object after a wrapper).** Not admitted. R383 still refuses it, because the probe measured
  R on UN-instrumented text only. For the BC side, today's base after a wrapper (H1b) is predicted
  11 lines wrong; that is the BC follow-up's problem, untouched here.
- **Nested `#if`.** A statement-level `#if` inside a one-arm wrapper is admitted and put in the fixture.
  A nested OBJECT wrapper stays refused (BaseApp: 2 files, 68 sites).
- **Header inside `#if`, body outside** (`preproc_split_declaration`, R305). No identity and no mutant.
  Unchanged.
- **Undecided symbol.**
  - A symbol the config does not define is decided as false: the object is compiled out, it has no
    mutants, and (C1) it is not indexed.
  - A condition `evaluateArms` cannot read makes the file `undecided`: no mutants, and not indexed.
- **R383.** Still applies and is unchanged. The rule never admits a file with a second object, and
  any multi-object file still turns the whole run's coverage off.

## 5. Offline measurement (2026-10-06, scratch scripts `r300b-census.ts` and `r300b-dupkeys.ts`)

| corpus | admitted shape (one arm, single object) | nested | two-arm | keys declared in 2+ files (any / active in 2+) |
|---|---|---|---|---|
| BaseApp (BC.History, 519 app.json dirs) | 142 files with sites, about 7,191 sites | 2 files, 68 sites | 1 file, 0 sites | 0 / 0 |
| CDO (`/work/src/DO`, 7 projects) | 0 | 0 | 0 | 0 / 0 |
| fixtures/ (17) | 0 | 0 | 0 | 0 / 0 |
| unit fixtures | 1 file (r214/p13), 2 sites | 0 | 0 | not run |

- Site counts come from one file at a time (approximate; R-305's whole-project count was 143 files,
  7,138 sites).
- The duplicate-key detector was checked on a toy pair first, and it found both kinds of duplicate.
- **The 142 files were counted before the r2 narrowing.** The code-free-after exclusion and the
  extra fixture shapes may lower the count. Re-count at landing.
- **No al-runner gate fixture holds an object wrapper or a duplicate key.** `sandbox-symbols`'
  `#if LETHALA` is statement-level. So no frozen `itest:alrunner` figure can move (one-shot, server,
  resource, symbol, layout, multiobject, cli-default), and nothing needs pre-committing there.

## 6. Live pin, tests, scheme, wording

**Live pin (I1).** A new `fixtures/sandbox-wrapped` + `-tests` pair. It gets a new `itest:alrunner`
leg through one-shot, `--server` AND resource selector mode, at one batch.

What the fixture holds:
- **Files:**
  - W-top: the wrapper is the first line, the namespace is inside, and there is a statement-level
    `#if` in a procedure;
  - W-pre: usings and a comment come before the `#if`;
  - an UNWRAPPED twin of each, with identical text and the `#if`/`#endif` lines replaced by comments;
  - a C1 pair: one key in two files, one arm active;
  - one two-arm file as the refusal control.
- **Layout:** follow the R353 pattern.
  - Put the mutation sites ABOVE the hit statements, and order the procedures so that a misread
    frame lands in the NEIGHBOURING procedure.
  - The instrumented text is longer than the source, so a misread moves both the verdict and the
    covering test.

Each mutant's verdict AND its covering test are pre-committed in a spec before the run. That gives:
- killed, survived and `no-coverage` cases;
- the two-arm file reading `no-coverage` with the new sentence;
- the C1 pair attributed to the active file.

The gate asserts:
- each wrapped file gives the same verdict and covering test as its unwrapped twin, per mutant;
- zero R383 "the position wins" warnings;
- zero I3 drops.

The baseline `al-runner.wrapped.baseline.json` is recorded once, per R332. `compile:fixtures` covers
the fixture.

**Unit tests:** the tests in 3, under `packages/runner/tests/`. Run `bun scripts/verify.ts`, and
red-check each test with `mutation-red-checker`.

**Scheme:** no key tuple moves, and the emitted AL is byte-identical. Bump `IDENTITY_SCHEME` anyway
(27 to 28; re-read the value at landing), for R318's scheme-4 reason: an unchanged key's verdict can
change from `no-coverage` to scored. The bump is global, so it also refuses bcdev history,
`--resume` and marks recorded under 27. Say so in the CHANGELOG.

**CHANGELOG:** "al-runner (one-shot, `--server` and resource modes) now scores a `#if`-wrapped object
that is alone in its file, joining its coverage by the original file's line numbers (measured,
R-300b). Declarations in a compiled-out arm are no longer indexed, and an object declared in two
active files is refused by name. Two-arm, nested and multi-object wrapped files, and every BC
coverage path, still refuse by name. IDENTITY_SCHEME 28: history recorded under 27 (bcdev included)
is not carried."

**R300 status:** stays `open`. Add a dated line: "al-runner half landed (<commit>); the fenced line
map and the hub still refuse; the probe's BC legs have not run."

Hard rule for every brief: edit files ONLY with the Edit and Write tools, never sed -i or inline
scripts.
