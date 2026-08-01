# Execution plan — R79 (silent bug), then the R69 go/no-go, then R70

**Written 2026-08-02**, at the end of two days on R69. Order chosen on value-per-effort and on
risk, not on what is most interesting.

**Shape:** one certain fix, then one measurement that decides whether a large open thread continues
at all, then the dangerous engine bug that has been waiting behind it.

---

## Why this order

R69 has consumed two days and produced one shipped report fix, a large amount of correct-but-unwired
machinery, a fixture, and a great many NEGATIVE results (the hub is closed three independent ways;
`--stop-hung-sessions` does not help; the router watches the wrong moment). The negative results are
real and recorded. The coverage recovery R69 was opened for still does not exist.

Meanwhile **R79** is a silent correctness bug affecting any real suite, and **R70** — ranked FIRST in
the queue on 2026-07-31 and displaced ever since — is a wrong-claim bug in the core engine that all
four frozen gates are blind to.

So: fix the certain thing, then force R69 to justify itself with a number, then return to the
engine.

---

## PHASE 1 — R79: a comment silently deletes tests from discovery

**Do this first. It is the only uncontested item on the list.**

`discoverTests` (`packages/runner/src/discovery.ts`) splits a file into codeunit sections with
`CODEUNIT_HEADER_GLOBAL = /codeunit\s+(\d+)\s+("([^"]+)"|(\w+))/gi` and skips any section without
`Subtype = Test`. The regex does not skip comments, so PROSE matching that shape opens a bogus
section, the rest of the file falls into it, and **every `[Test]` after that point vanishes**.

Direction is silent under-reporting: the tests are simply absent, the baseline reports green, and
the mutants they covered read `no-coverage`. A dropped test is indistinguishable from one that never
existed. This project names every other such condition loudly (R31 stale-test-app, R35 permissions);
this one says nothing at all.

**It is not a fixture-only shape.** Writing `codeunit 50100 "Sales Post"` in a comment above a test
is ordinary AL commenting.

### Tasks

- [ ] **1.1 — Failing test first.** In `packages/runner/tests/` add a discovery test over a fixture
  source string containing a comment line `// see codeunit 50100 "Sales Post"` ABOVE a `[Test]`
  procedure, asserting the test IS discovered. Run it; watch it FAIL. Report the failure.
- [ ] **1.2 — Fix.** Strip comments before sectioning (`//` to end-of-line, and `/* … */`). That is
  the correct fix, not an anchor tweak — a `codeunit` header inside a string literal has the same
  shape. Keep the change small and local to `discovery.ts`.
- [ ] **1.3 — Watch it pass**, then the full loop: `bun run typecheck` → `rm -rf packages/*/dist` →
  `bun test`.
- [ ] **1.4 — Add the loud guard the bug argues for.** Discovery should REFUSE, not shrug, when its
  section-parse disagrees with a naive whole-file `[Test]` count. Fail loudly on a caller-contract
  violation is this repo's rule, and this is exactly that shape. If a mismatch is somehow legitimate,
  say so in the code with the reason; do not soften it to a warning without one.
- [ ] **1.5 — Red-check with `mutation-red-checker`.** Two mutations: revert the comment-stripping
  (the new test must go RED), and remove the count guard (its test must go RED). A surviving mutation
  means the test is not load-bearing — report it as a hole.
- [ ] **1.6 — Verify against the real case.** `fixtures/sandbox-data-tests/src/DataTests.Codeunit.al`
  currently has its comment DEFENSIVELY REWORDED to dodge this bug. Restore the natural wording
  (`` `codeunit 79308 "Data Value Source".GetValue` ``) and confirm discovery still returns 22. That
  is the honest end state: the fixture should not have to work around a bug we have fixed.
- [ ] **1.7 — Live gate.** `LETHAL_ITEST_TABLES=1 bun run itest:tables` must still report
  **69 killed / 9 survived / 9 no-coverage over 87** with exactly one named baseline failure.
- [ ] **1.8 — Commit**, and mark R79 done in `ROADMAP.md` with the commit sha.

---

## PHASE 2 — The R69 go/no-go. ONE number decides it.

**Do not build anything in this phase.** Its entire purpose is to produce a number and apply a
threshold that was fixed BEFORE the number was known.

Every R69 sizing statement so far has been in the wrong unit. "9 of 104 test files" turned out to be
unreproducible against any checkout on this machine (see R76); "18% of tests" is a test-denominated
figure and does not say what it is worth. **The only number that matters is how many MUTANTS are
covered exclusively by TestPage tests**, because that is precisely the set the whole R69 apparatus
would recover.

### Tasks

- [ ] **2.1 — Pre-commit the threshold, in writing, in `ROADMAP.md`, BEFORE measuring.** State the
  number that would justify continuing and the number that would close R69. Committing it first is
  what stops the result being rationalised afterwards — this row has produced five retracted
  over-generalisations in two days and the pre-commitment is the countermeasure.
- [ ] **2.2 — Measure.** On the available Document Output corpus (`/u/Git/DO`), run under
  `coverageMode: "procedure"` so the baseline survives, and count mutants whose covering-test set
  consists ONLY of tests that declare a `TestPage`. Read the number off a report, not an estimate.
  Note honestly that this corpus is NOT the one the original 9-of-104 figure came from.
- [ ] **2.3 — Apply the threshold. Do not re-argue it.**

### If ABOVE the threshold — R69 continues, in this order

1. **R74 + R75** — both are plain discards, not architecture. `orchestrator.ts` (~:3933-3935) passes
   `undefined, undefined, undefined` into `record(...)` for the routed path, throwing away the
   attestation and the coverage attribution. ~30 lines plus tests. `report.ts` already has the
   `guardObserved === false` survivor category waiting for the data.
2. **R78** — redesign the routing trigger. Gate 1 currently keys on the FENCED BASELINE's failure
   text, but in the only configuration where a real TestPage suite survives baseline
   (`coverageMode: "procedure"`) that test PASSES baseline, so gate 1 can never fire. Key on the
   MUTANT RUN's refusal instead.
3. **Wire `routedTransport`** (removing the R74/R75 tripwire in the same change), and prove it on the
   fixture: **`Data Value Card` / `Data Value Source`'s three mutants must flip from `no-coverage` to
   scored, tagged `runner: "client-services"`.** That is the standing, committed statement of the
   gap — it is already in `tables.baseline.json`.
4. Gate on a per-**(mutant, runner)** join across all four frozen gates, plus
   `/coverage-differential`.

### If BELOW the threshold — close R69 honestly

- Mark R69 **"named, not recovered; recovery measured unprofitable at `<sha>`"**. That is a finished
  row, not a failed one.
- **Delete** `batch-transport.ts`, `testpage-router.ts`, the routed orchestrator code, the R74/R75
  tripwire, and control-app objects **71011-71014**. A dead OData surface on customer containers is
  liability, not insurance. The spec plus commit `47fbd19` is a complete re-derivation kit.
- **KEEP** `testpage-unsupported.ts` and its report wiring — that is the shipped value and it is
  independent.
- **KEEP** the fixture pair and its three `no-coverage` mutants: they are the permanent, measured
  statement of what is not recovered, and the gate asserts them.

---

## PHASE 3 — R70: the dangerous engine bug that has been waiting

Ranked first on 2026-07-31 and displaced by two days of R69. Unlike everything above, this one can
produce a WRONG CLAIM rather than a missed one.

`buildSymbolTable` keys scope on the BARE object name, so `page "CDO Setup"` overwrites
`table "CDO Setup"` — whichever is parsed last wins wholesale. **Measured on Document Output: 13
names shared across kinds, 12 of them page+table** — the ordinary "card page named after its table"
convention, not an edge case.

The direction is the unsafe one: a receiver that SHOULD be unresolvable (a rule-4 refusal) can
resolve through the page's declaration and be CLAIMED, and a receiver resolving to a DIFFERENT table
sends rule 3's shadowing guard at the wrong table. Verdicts stay honestly measured, so this is a
wrong-CLAIM bug, not a wrong-verdict one — but a wrong claim mislabels the mutation and, under §3.2
dedup precedence, DELETES the correct Tier-1 mutant at that site.

**All four frozen gates are blind to it**, because no fixture has a cross-kind name collision. The
fixture is part of the fix.

- [ ] **3.1** Reproduce the overwrite in a unit test FIRST — `globalsOf("CDO Setup")` returning the
  page's variables where the table's are expected.
- [ ] **3.2** Apply R30's `scopeKeyOf(kind, name)` shape one namespace over. Touches four call sites
  (`receiver.ts` `lookupVar`, `types.ts` ×2, `callers.ts`) plus every engine test that asks
  `globalsOf` by bare name. Must NOT change `resolveObject`, which is already kind-aware.
- [ ] **3.3** Add a fixture with a genuine cross-kind collision, so the gates stop being blind.
- [ ] **3.4** Red-check, then all four gates per-mutant.

---

## Standing rules for all three phases

- **Measure, do not reason, about BC.** Every confident claim in this thread that went unmeasured was
  wrong at least once.
- **Verify the row's prescribed fix against the code BEFORE implementing.** This has repeatedly
  turned a stated hazard into a non-issue, and caught two plan defects in two days.
- **A differing gate verdict is a BLOCK**, never "close enough". Join per-mutant, never on aggregates.
- **Red-check every load-bearing test** with `mutation-red-checker`. In this session that practice
  found two holes in a guard the controller had just written.
- Update `ROADMAP.md` as things land — it is the durable record; SDD ledgers are scratch.
