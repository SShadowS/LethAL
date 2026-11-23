# PR-386 pre-commitment: static reach from each not-run test into the target app, over-approximating (0 false negatives)

Written 2026-11-23, before the build. Moved from preproc (PR-383's groundwork). Interface agreed in writing with PR-381:
`/coord/handoff/PR-386/interface.md`. Inputs: `/coord/handoff/PR-383/inventory.md` (what exists),
`/coord/handoff/PR-381/predicate/result.md` (the truth set and the codeunit proxy's score).

## The question
PR-381 (the owner's ruling q-20261123T112833-7e045797) marks a survivor UNCONFIRMED when a test that v3 did not run at
baseline (refused, timed out or stopped: `v3NotRunAtBaseline`) might have killed it. Its default asks nothing of the code:
every not-run test reaches every survivor (`ALWAYS_REACHES`). PR-386 supplies `reaches(test, row)`: does the test's code,
followed statically through the test app into the target app, reach the mutant's member? It may say yes too often; it must
never say no wrongly.

## What is measured first (offline, PR-381's join; names and counts only)
- c3 (PR-357) and y3 (PR-204) share source and dependency hashes; all 43,511 sites join by the full site key.
- **Truth Y:** 9 of c3's refused tests ran in y3. They cover **253** c3 survivors (y3's `coveringTests`).
- **The codeunit proxy C** (a covering test in a codeunit holding a refused test) flags 5,024 of c3's 8,618 survivors, with
  **1 false negative** against Y. That miss is why C may only be a hint.

## The design
1. **One model over both apps.** The target app's files are parsed into the same `Unit`/`Proc` model as the test app's
   (`buildObjectUnit`/`scanFile` are not test-specific), and one `Scanner` is built over the union. A name either app declares
   now resolves; EXTERNAL means "neither app declares it" (a dependency, BaseApp or the platform).
2. **The walk.** For each not-run test, `Scanner.reach` from the test procedure, its `[HandlerFunctions]` and its codeunit's
   `OnRun`/`Initialize` path, exactly as the TestPage scan walks today, but continuing into target procedures and target
   objects (`enterObject`: triggers, parts, `SourceTable`, `objectRefs`, table triggers on `Insert(true)`/`Modify(true)`/
   `Delete(true)`/`Validate`).
3. **Why `reach` alone is not enough (spec review, BLOCK 1-3):** R-371's walk is sound only together with the digest's
   `subscriberFold` (test-digest.ts): several of `reach`'s "not an edge" rulings (Bind/UnbindSubscription, an extension's
   object not counted in `passesTestApp`, R685's id facts left to `foldIdTargets`) lean on that fold. So the reach set of a
   test is ALWAYS its own walk PLUS one blanket set `B`, computed once over the union of both apps and walked like any entry:
   - **B1, every event subscriber and every extension**, in BOTH apps: each `[EventSubscriber]` procedure, each
     `EventSubscriberInstance = Manual` codeunit, every trigger of every table, page, report and enum extension (a test-app
     mock bound with `BindSubscription`, or a test-app tableextension of a target table, is reached this way). There is no
     publisher-to-subscriber narrowing and no condition on an EXTERNAL call.
   - **B2, everything external code can run by id from data:** every target codeunit's `OnRun`, every target enum
     implementation codeunit, and every trigger of every target report, page, xmlport and query (BaseApp runs them from
     Report Selections, Job Queue entries, a table's card or lookup page, an enum value).
   - **B3, `foldIdTargets`** on each test's own state and on B (an id a walk saw, kept as a fact, may name any object of
     its kind).
   - **B4, every trigger of every target table and table extension** (delta review LOW C): BaseApp code over RecordRef
     (configuration packages, a Job Queue entry's record with a `TableNo` codeunit) can fire any table's triggers.
   - **How B is walked:** each B member is an entry through `foldEntryProc` (as `subscriberFold` walks its members), so a
     `var` parameter handed back is read too.
   - **A fallback met while walking B, or B3 over B, makes EVERY test `"all"`** (delta review BLOCK A; R-371's `onFallback`
     does the same for a fallback in the fold). B's first fallback reason is reported. On DO this may make every test
     `"all"`; that is the honest result, reported, never narrowed away.
   - B is a precision cost by design. Its size is reported; the claim is soundness, not a small B.
4. **Over-approximation, the hard rules (each `"all"` or `"unknown"`, which reaches):**
   - **Any fallback** the walk records (an unknown interface implementer, Variant, RecordRef/FieldRef, `Run` by a
     non-literal id or a variable, an unmodelled shape, a damaged unit visited): that test reaches EVERY member (`"all"`).
   - **Any parse damage anywhere in either app** (`model.damaged` non-empty): EVERY test is `"all"` (damage can swallow a
     whole subscriber codeunit, which then never becomes a unit, so B cannot hold it).
   - **A test name that does not resolve** (the qualified `"<Codeunit>.<Method>"` matches no `[Test]` procedure, or matches
     more than one codeunit, or sits in an `#if` arm the model does not see): that test is `"all"`. Never an empty set.
   - **Interfaces:** no narrowing in this PR. An interface call falls back (today's case 12), so `"all"`.
   - **A mutant row the closure cannot place** (no manifest entry for its full site key; no unit with exactly its
     `(objectType, codeunitId)`; no member of that unit with its name at any arity; a row with neither `procedureName` nor
     `triggerName`, such as a property or an initialiser site; an R318 arm the model does not see): `"unknown"`.
5. **The grain and the key.** A mutant is reached when a reached `Proc` belongs to the unit with exactly the manifest's
   `(objectType, codeunitId)` (an extension mutant is keyed by the EXTENSION object, not its base) and has the mutant's
   procedure name (any arity: every overload of that name counts) or trigger name (a control's trigger and the table field's
   trigger are different procs; both are matched by the manifest's own trigger key). No statement-level narrowing in this PR.
6. **A ruling, not silence:** install and upgrade triggers of a target codeunit (`OnInstallAppPerCompany`,
   `OnUpgradePerCompany`, ...) are not reached by a test (they run at publish, when no mutant guard is on). Every other
   trigger of a reached or entered codeunit is.
7. **The closure.** `buildNotRunReach({ manifest, targetModel, testModel, notRunTests })` returns a `NotRunReach` (the
   agreed type) plus a summary: per test, `"all"` or its reached-member count and the source of each member (walk, B, or
   `foldIdTargets`). Reach sets are computed once per test and cached.

## Hard claims (each a BLOCK if it fails)
- **H1, 0 false negatives against Y:** for each of the 9 tests y3 ran, every c3 survivor y3 shows it covering is reached.
  The run lists each of the 253 with HOW it was reached (walk, B, `foldIdTargets`, or the test's `"all"`). Guards against a
  pass for the wrong reason (spec review, SERIOUS 6):
  - at least one of the 9 tests is not `"all"`;
  - at least one Y row is reached by the walk alone (not B, not `"all"`);
  - proxy C's one false negative against Y is reached, and the run names how.
  - The bias is stated, not hidden: these 9 are the tests v3 could run, not the TestPage-heavy shapes the rule is for. H2
    and the fixture shapes below cover those.
- **H2, sound on every fixture:** on `fixtures/sandbox-app`, `-data`, `-harden` and the wrapped fixture, every member a
  test's al-runner v3 baseline coverage shows executed is reached by that test. Guards (SERIOUS 7):
  - each test's coverage list is non-empty, and the counts are reported (an empty list passes nothing);
  - the shapes the fixtures exercise are listed: an event subscriber, a TestPage with a handler, an extension trigger,
    `Codeunit.Run` by name. A shape no fixture exercises is a BLOCK until a unit test covers it.
  - v3's coverage is not authoritative (R586) and can under-report (R602's multi-object and `#if` cases); a miss is still a
    BLOCK, an under-report only weakens H2, so H2 is never the only claim.
- **H3, one red check per rule (LOW 9):** each of B1, B2, B3, B4, B's fallback rule, the damage rule, the
  unresolved-test rule and the "cannot place" rule is removed in turn, and a unit test that needs it goes red; restored, green.

## Reported, not judged
- **Flagged counts on c3:** how many of c3's 8,618 survivors at least one of c3's not-run tests reaches, against C's 5,024
  and `ALWAYS_REACHES`' 8,618, with preproc's precision bounds (unknown truth counted both ways).
- **How many not-run tests fall back to "all"**, and the first fallback reason of each, and B's own (if any).
- **How many rows are `"unknown"`, per reason** (no manifest entry, no `(objectType, codeunitId)` unit, no member name, no
  member at all) (delta review LOW D): a key whose vocabulary differs from the model's (the manifest's `objectType` against
  `Unit.kind`, the trigger-key format) shows up here instead of hiding as a safe answer.
- **Time** for the whole c3 set (target parse reused when available).

## Not changed
No verdict, no caveat rule (PR-381's), no report field. Wiring the closure into PR-381's `notRunSurvivors` waits for
PR-381 to land and is its own commit after these claims hold.

## Tests (red-checked each way)
- A target procedure reached only through a test-app helper calling it by name: reached; that call removed: not reached
  (when nothing in B reaches it).
- A target subscriber, and a test-app `Manual` subscriber that calls target code: reached by every test (B1), with no
  EXTERNAL call in the test.
- A target report reached only by id from data: reached (B2). A target table's trigger with no other path: reached (B4).
- A B1 subscriber that meets a fallback (an interface call): every test `"all"` (BLOCK A).
- An interface call: `"all"`.
- `Codeunit.Run(<literal>)` into a target codeunit: its `OnRun` reached; by a variable: `"all"`.
- A damaged file in either app: every test `"all"`. A test name that does not resolve: `"all"`.
- A row with no manifest entry, no matching `(objectType, codeunitId)` unit, or no member name: `"unknown"`.
- An extension mutant keyed by the extension's own id: reached through the extension's reached proc, not the base's.

## Spec review (spec-adversary, 2026-11-23, before commit)
4 BLOCK (no publisher-to-subscriber edge without an EXTERNAL call; test-app code external code can enter; objects external
code runs by id; an unresolved test name giving an empty set), 4 SERIOUS (parse damage; H1 passing for the wrong reason; H2
resting on v3 coverage; the extension key), 3 LOW (H3 too weak; interface narrowing; install and upgrade triggers). All are
folded in above: rules 3, 4, 5 and 6, and H1-H3. Delta review: all eleven close; one new BLOCK (a fallback met while
walking B had no stated effect: now every test `"all"`) and 3 LOW (B walked through `foldEntryProc`; B4, target tables;
the `"unknown"` count per reason), folded in.

## Checks
VERIFY (one at a time), spec-adversary review of this spec, Opus build review, selectLegs' gates, CI. The offline
measurement reads c3's and y3's reports and DO's source read-only under `/coord`; no DO source text is committed.
