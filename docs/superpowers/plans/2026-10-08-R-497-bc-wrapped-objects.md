# R-497 plan r2: BC paths score the measured `#if`-wrapped shapes; H1b -> H1a

**r2 (after the opus plan review, `review-opus-r1.md`): section 4 AMENDS sections 2-3 and wins
where they differ.**

lethal-preproc, 2026-10-08. Worktree `/work/lethal-wt/r497`, branch `lethal/r497` off a46a697a.
Inputs: R-300b's BC measurement (`/coord/handoff/R-300b/bc-results.md`, pre-commitment
`precommitment.md`, probe sources `scripts/r300b-probe/` on master), step 1 (`step1.md`), the
shape census below. Scheme: the next free number at merge (master 34, R-500 holds 35).

## 0. Measured facts this rests on (R-300b, Cronus28, two identical rounds)
- Fenced (BC Code Coverage, object-relative): H1a for W1 (one arm, namespace inside), E1 (two
  arms, `#else` compiled, inner statement `#if`), Q (two arms, `#if` compiled, bare object before),
  R (bare object after Q's wrapper). H1a: base = 1 + last line of the previous COMPILED object
  (0 if none); directive lines and inactive-arm text belong to the object that follows them.
  Today's H1b (a wrapper is one unit, base after it = `#endif` + 1) is right for W1/E1/Q and WRONG
  for R (7/11/15 vs measured 18/22/26).
- Hub (procedure coverage): HUB-A for all six objects: each test's coverage names exactly the
  compiled arm's reached procedure, through the compiled app's `SymbolReference.json`, which lists
  the compiled arm's procedures only.
- bcdev `line` mode is not a coverage source (procedure payload only).

## 1. Shape census (offline, `scratch/shapes497.ts`; each project's effective bcdev symbols; master 15c3a620 dump for counts, each file counted once)
| class | BaseApp files / mutants | DC | DO | CDO |
|---|---|---|---|---|
| ADMIT one arm, alone in its file (W1) | 241 / 5,987 | 21 / 320 | 0 | 0 |
| ADMIT two arms, or bare object before/after | 0 | 0 | 0 | 0 |
| REFUSE nested object wrapper | 2 / 70 | 0 | 0 | 0 |
| REFUSE an arm without an object (incl. step 1's 21 bare-after files) | 21 / 0 | 0 | 0 | 0 |
| REFUSE no coverage identity (enum, interface, ...) | 35 / 0 | 0 | 0 | 0 |
| REFUSE whole wrapper compiled out | 2 / 0 | 3 / 0 | 1 / 0 | 0 |
So the live gain is the W1 shape: 5,987 BaseApp and 320 DC mutants move from refused to scored on
bcdev. The two-arm/middle/after shapes are admitted because they are measured, with 0 corpus sites;
they are pinned offline against the probe's measured numbers.
(Step 1's 6,914 counted a nested-module file once per project that includes it; 5,987 counts it once.)

## 2. Design
### 2.1 One predicate, arm-aware: `bcAdmitsWrappedFile(root, arms)` (line-map.ts)
True only when ALL hold:
- `arms` is `decided` (undecided -> refused by `undecidedArmsReason`, as al-runner);
- exactly ONE top-level object wrapper (`preproc_conditional_object` with `wrapperHoldsObject`);
- the wrapper has no `#elif` and no nested object wrapper; at most two arms (`#if` / `#else`);
- every arm holds exactly ONE top-level object, each with a coverage identity, all the SAME key;
- exactly one arm's object is compiled under `arms`;
- bare objects before and after the wrapper are allowed (P and R measured; base by the plain
  multi-object rule, already measured); namespace/using/comment lines anywhere; statement-level
  `#if` inside the object allowed (E1).
Everything else keeps a refusal NAMED by its shape (new sentence `refusedBcShapeReason(type, id,
file, shape)`): several wrappers, `#elif`, nested wrapper, several objects in an arm, an arm
without an object, arms declaring different objects, no coverage identity, wrapper compiled out.
al-runner's predicate (`alRunnerAdmitsWrappedFile`) is untouched.

### 2.2 Line map: H1a when arms are known
`fileLineMapEntries(root, identity, file, arms?)`. With `arms` decided and the file admitted:
entries only for compiled declarations (`activeEntries`), no `refused`, and after a wrapper
`previousEndLine` = last line of its COMPILED declaration (none compiled: unchanged, so the
directive and inactive lines fall to the next object). Without `arms` (every current caller that
does not pass them): exactly today's behaviour, so al-runner and `lethal verify` cannot move.

### 2.3 bcdev backend
- `BcDevMcpBackend.useBuildSymbols(symbols)` (the orchestrator's `handBuildSymbols` already calls
  any backend that has it). Coverage on and symbols never handed over -> throw (al-runner's rule).
- `indexArtifact` -> `buildLineMap(dir, declared, symbols)`: evaluates arms on the INSTRUMENTED
  text alc compiled, applies 2.1/2.2. An admitted source file whose instrumented text re-parses
  `undecided` is refused by name after deploy: the backend exposes `coverageRefusals()`, which the
  orchestrator's `withBackendRefusals` already merges per batch.
- `indexInstalled` (installed-artifact path) and the hub's `coverageRefusedFromSources` take the
  symbols too and read the same predicate.
- Hub: an admitted object is no longer in `hubRefused`; attribution stays by (object, method id).

### 2.4 Orchestrator / selection
- `coverageRefusedObjects(files, backend, armsOf?)` and `refusedObjectsOfFile(root, file, backend,
  arms?)`: under bcdev with arms, an admitted file refuses nothing; without arms, as today.
  `runSession` passes the source arms it already computes (orchestrator `evaluateArms`).
- Duplicate keys (R-300b C1: an object declared in two compiled files) refused on bcdev too.
- `carryBarredFiles` extended to bcdev admitted files (their post-deploy refusal is unknown before
  deploy), as for al-runner.
- `lethal verify` keeps refusing wrapped files by name (no arms passed): unmeasured there.

### 2.5 Tests (offline, each red-checked per direction)
- Predicate: every admitted shape true, every refused class false with its named sentence.
- **H1a against BC's own numbers**: build the line map over `scripts/r300b-probe/target` (the
  measured sources) under `PROBESYM` and assert the marker lines resolve as measured: W1 10/14/18,
  E1 18/22/27, Q 8/12/16, R 18/22/26, controls C1 10/14/18 and P 7/11/15. Red: H1b gives R 7/11/15.
- Fenced: rows for an admitted wrapped object produce entries; an inactive-arm declaration has no
  entry; a refused shape still drops rows and is named once.
- Hub: an admitted object is attributed; a refused one is not.
- Orchestrator per-backend test: bcdev W1-shape mutants scored (was: no-coverage, refused).
- Undecided-after-instrumentation: refused by name post-deploy, never all-green, never carried.
- Tests that pin today's bcdev refusal move deliberately (bcdev-backend R298 fenced/hub suites,
  `r300b-wrapped.test.ts` "(a) the BC paths keep refusing W1", orchestrator R-300b bcdev case,
  line-map R298 suite): each edited to the admitted/refused split above, none weakened.

### 2.6 Live: a bcdev wrapped leg (pre-committed, on master, BEFORE the run)
- `fixtures/sandbox-wrapped` + `-tests` unchanged, `WRAPDEF` as the config symbol, published to
  Cronus28 over the dev endpoint by `runSession` (as `itest:bcdev`), under the container's lease;
  ids 78900-78949 checked free on Cronus28 first. Coverage `fenced`.
- Expected shapes under bcdev (`WRAPDEF` + app.json's `WRAPAPP`): WrappedTop, WrappedPre,
  WrappedPairA admitted (one arm); WrappedArms admitted (two arms, `#if` compiled); WrappedPairB
  compiled out. So unlike the al-runner leg, WrappedArms' mutants are SCORED on bcdev.
- Per-mutant table derived offline (bcdev generation, the bcdev predicate), every verdict, killing
  and covering test pre-committed with its reason, twins equal per mutant both ways.
- New baseline `bcdev.wrapped.baseline.json` (GATE_BASELINES, R332 record once, then a confirming
  pass). Placement: a separate script `itest:bcdev-wrapped` (so `itest:bcdev`'s frozen 3/12/4 and
  its baseline do not move), wired like al-runner's wrapped leg.
- `itest:bcdev` itself re-run unchanged (sandbox-app has no wrapped file).

### 2.7 Prose
CHANGELOG (scheme, what is admitted per path), R497 done, R300 note, fixtures/README, the CLAUDE.md
sentence for the new leg drafted for the owner.

## 3. Questions for the review
1. Is allowing ANY number of bare objects before/after the single wrapper sound, given only one
   before (P) and one after (R) were measured, and the plain multi-object base rule is measured?
2. Two arms with `#if` compiled ALONE in its file (WrappedArms) combines E1 (two arms, alone) and
   Q (`#if` compiled, in the middle); H1a = H1b there (base 1). Admit, or refuse as unmeasured?
3. Evaluating arms on the INSTRUMENTED text for the line map (al-runner's precedent) vs mapping the
   source arms: any frame hazard?
4. Is a wrapper whose every arm is compiled out, with bare objects around it, safe to keep refused
   (it is: 0 mutants in it), or should its neighbours be admitted under H1a?

## 4. r2 amendments (opus plan review r1: no false kill; four fixes, all adopted)

**A1 (F1, wrong verdict): a declaration in an inactive arm gives NO entry and NO refusal key on
bcdev when arms are known.** Refusals and the `LineMap` merge by object key alone, so refusing a
compiled-out wrapper's declaration also refused its compiled twin in ANOTHER file and quoted the
wrong file. Measured (census, F1 column): DC 2 cases (`CDCTestUpgradeLibrary` 82445,
`CDCTest2700Upgrade` 82443, each compiled in another test file), BaseApp 0, and the live fixture's
`WrappedPairB` vs `WrappedPairA` (78905). So `fileLineMapEntries` with arms drops inactive-arm
declarations before any refusal (al-runner's `activeEntries` precedent); a file whose only wrapper
is compiled out refuses only its bare neighbours (Q4), never the compiled-out key. Test: the
pair, A scored and not refused, B no entry (red: refuse by key).

**A2 (F2, all-green fallback): `coverageRefusals()` returns the backend's WHOLE refused set**
(`lineMap.refusedByKey()` on fenced, `hubRefused` on the hub), whatever the reason, not only
"undecided after instrumentation". Otherwise an object the backend refuses on the instrumented
parse but selection admitted on source sends its table-trigger mutants down FALLBACK 2. Test: a
source-admitted table whose instrumented parse is refused -> its trigger mutants read no-coverage,
named (red: return only the undecided ones).

**A3 (F3, last arm wins): two invariants.** (a) In the `LineMap` constructor, two entries for one
declared key refuse that key by name (no legitimate shape gives two compiled entries; closes any
path that skips arm filtering). (b) In the backend, a file the SOURCE admits must be admitted on the
INSTRUMENTED text with the same compiled key, else it is refused by name. Tests for each (red:
remove the invariant; feed both arms as plain entries).

**A4 (F4, verify): bcdev with no symbols keeps today's refusal and never throws**; `runSession`
asserts the handover for bcdev itself (a session that reaches deploy without it is a defect,
thrown there). `lethal verify` (`runNamedMutants`) hands over nothing and keeps refusing wrapped
files by name, unchanged; its reach rule already fails closed for refused objects.

**A5 (F5): the H1a-after-wrapper rule is pinned OFFLINE only, and through the real path.** Besides
the raw-probe test (2.5), one test instruments a wrapped project holding the E1, Q and R shapes
with mutants, then runs the real `indexArtifact` after `useBuildSymbols` and checks each marker
line's procedure. Red-checks: drop the handover; drop the arm filter; revert H1a to H1b. The live
leg is stated as a plumbing and arm-selection check (WrappedArms' inactive `#else` copy of `Pick`
must not take the compiled arm's lines), not an H1a check: every live admitted object is alone in
its file, so H1a = H1b there.

**A6 (F6): the live leg runs twice, `fenced` and `procedure` (hub)**, per-mutant equal, in the same
`itest:bcdev-wrapped` script, one baseline.

**A7 (F7): the census figures are an upper bound.** An admitted file whose instrumented text is
refused after deploy is not scored. The first BaseApp/DC bcdev run reports that count. Extending
`carryBarredFiles` to bcdev admitted files removes known-survivor and full-batch-resume carry
for them (a cost). Any bcdev campaign stage whose baseline holds such files needs a deliberate
re-freeze; none of the committed stages does (to be checked in the build).

**Answers adopted:**
- **Q1:** admit AT MOST ONE bare object before and AT MOST ONE after the wrapper (exactly the
  measured P / Q / R), refuse more by name. 0 corpus sites either way; the measured surface only.
- **Q2:** admit two arms with `#if` compiled alone in its file (base 1 under every rule; arm
  selection checked live by WrappedArms).
- **Q3:** arms on the INSTRUMENTED text, with A3's source/instrumented cross-check.
- **Q4:** neighbours of a compiled-out wrapper stay refused; the compiled-out key is never refused
  (A1).
- "Exactly one object per arm" splits arms at the wrapper's own `preproc_else` children, not via
  `containerNodesOf` (which flattens arms).

**Live leg, test app:** confirm in the build whether `runSession` publishes the tests app on bcdev
(`test-app-publish.ts`) or the leg must publish it first (`itest:bcdev`'s way, R56 stale guard). The
per-mutant pre-commitment is committed to master BEFORE the run, after this plan is adopted.
