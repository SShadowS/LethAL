# R-371: a test's digest covers what it reaches, not only its own method (short plan)

**Problem.** R-278's digest covers the test method only. An edit to a helper, handler or library procedure the test calls leaves the digest unchanged, so verify treats the test as old. That is the unsafe direction.

## Measured first (eb250b2c, `scripts/r371-reach-measure/RESULTS.md`)

| Suite | Tests | Unfollowed edge | Reach max / p90 / p50 | New tests for helper edits: most-shared / p90 / median / top handler / local |
|---|---|---|---|---|
| DC | 1,301 | 75.6% | 406 / 29 / 4 | 406 / 29 / 4 / 44 / 4 |
| DO | 1,287 | 99.5% | 158 / 25 / 4 | 158 / 25 / 4 / 17 / 2 |
| BaseApp Test | 40,291 | 99.4% | 5,734 / 19 / 3 | 5,734 / 19 / 3 / 125 / 2 |
| sandbox-data-tests | 68 | 77.9% | 13 / 13 / 11 | 13 / 13 / 11 / none / 11 |

- **Cost:** extra executions are about S x N + 2N. A typical edit (median to p90) costs 2 to 30 new tests. The tail is the problem: the most-shared helper on BaseApp gives 5,734 new tests, about 585k executions at S = 100.
- **Unfollowed edges are almost all calls to codeunits in OTHER apps**, mainly test libraries such as Assert, Library Assert and Library - Sales. So R371's own example, "strengthen a shared assertion helper", is usually an edit OUTSIDE the test app.
- **In-app edges the walk cannot follow:** BindSubscription subscribers (up to 12.4%), Codeunit.Run (1.6 to 5.1%), with-receivers (13.9% of DC), interface dispatch, and procedures in non-codeunit objects.
- **Handlers:** the top handler reaches 17 to 125 tests, and the product walk does not follow `[HandlerFunctions]`.
- **RAM:** BaseApp peaks at 2.6 GB, 1.5 GB of it at the end of parsing, with about 1 GB from keeping per-test sets.

## Design

1. **Digest = own span + every test-app procedure it reaches.** The walk is testpage-scan's Scanner (exported, not copied), plus a `followHandlers` option for this use only. It adds the procedures named in the test's `[HandlerFunctions]` and walks them. The TestPage scan's behaviour does not change.
   - Each reached procedure contributes its span hash (the same normalization as R-278).
   - The test's digest is the hash of its own span plus the SORTED reached span hashes.
   - Key and "every test or none" are unchanged (NULL plus test-digests-unavailable).
2. **An unresolved edge never hides an edit.** Each kind resolves to something whose change is seen:
   - **Callee codeunit not declared in the test app (another app):** covered by the dependency fingerprint (item 3).
   - **In-app edges the walk cannot follow** (BindSubscription, Codeunit.Run, interface or with receivers, a non-codeunit object, anything else): the test's digest also includes the **whole-test-app digest** (the hash of every procedure span in the app). Any test-app edit then turns those tests new. That over-approximates, which is the safe direction, and it touches at most the measured share of tests.
3. **Dependencies outside the test app.** Every digest includes a fingerprint of the test app's dependency set: each dependency's id and version.
   - bcdev reads them from the PUBLISHED package's NavxManifest (R-372's rule). al-runner reads them from `app.json`.
   - A library upgrade then turns every test that reaches another app new, and the cap in item 4 names that case.
   - **Stated limit, filed as its own item:** a dependency rebuilt at an UNCHANGED version is not seen. R139 hit the same thing for the target app. Closing it needs each dependency's package hash, which means one more download per dependency: out of scope here.
4. **Cost: a named refusal, not a silent cap.** Verify refuses `too-many-new-tests` when N new tests exceeds the limit. The limit defaults to 50, which is above every measured p90 edit, with a `--max-new-tests <n>` flag.
   - The message names N, the reached helpers that changed (up to 5), and the remedy: run `lethal run` again, or raise the flag.
   - A refusal never gives a wrong verdict. Dropping tests to fit under the limit would give one, so the plan does not do that.
   - A per-survivor filter (a new test joins only the survivors it can reach) needs the new tests' coverage, which verify does not have without an extra coverage run. Not now; say so in the refusal item.
   - The new refusal value is a VERIFY_REFUSALS addition, so bump the verify schema version (R233's rule), with its ripple.
5. **Published source (R-372) and the one-time break.** bcdev digests the published package's source, al-runner the disk, and env-tool records NULL. A run recorded under R-278's per-method digest has a digest that no longer matches the new shape. So the digest gains a scheme tag (`v2:` prefix), and verify refuses a `v1` source run as `source-predates-verify` with a message saying why. The CHANGELOG notes the one-time refusal again.
6. **RAM: one parse per file, shared.** Today the TestPage scan and the digest each parse the test app. Change `readTestAppSources` callers so both use ONE parse and one units list.
   - Per procedure, the span hash is computed once. Per test, the reached set is built, hashed and dropped immediately; no per-test set outlives its hash.
   - Measure the peak RSS on DC with the product path before and after, and state it.

## Tests (red-checked)

- **A helper edit turns the test new:**
  - a same-codeunit helper;
  - a helper in another test-app codeunit;
  - a `[HandlerFunctions]` handler;
  - an in-app unfollowable edge (Codeunit.Run) whose target is edited, via the whole-app digest;
  - a dependency version change.
  Red-check each by removing its clause.
- **An unrelated helper edit does NOT turn the test new**, when the test has no unfollowable in-app edge. Red-check: always including the whole-app digest makes it red.
- **The v1 digest refusal;** the `too-many-new-tests` refusal at limit + 1 and not at the limit; flag parsing.
- **One parse:** a counter on the parse shows 1 per file.

## Tasks

1. Export the Scanner walk plus `followHandlers`; one shared parse.
2. The reachable digest, whole-app and dependency fingerprints, and the v2 scheme; tests.
3. `too-many-new-tests` with the flag, the schema bump and its ripple; tests.
4. File the unchanged-version dependency item and the per-survivor filter item. Close R371, write the CHANGELOG and update the agent guide.
5. itest:agreement live; I tell the orchestrator before leasing.

---

# r2 (after review r1, rulings at H:/lethal-coord/reviews/R-371-plan/rulings-r1.md)

Approved and unchanged: a default cap of 50; the `--max-new-tests` flag; a named refusal instead of a silent subset; the v2 tag; one shared parse; R-372's published-source rule; every test or none.

## Design changes

**C1: what a digest covers.** A test's digest covers:
- its own span;
- for every REACHED object: the object header and properties, the global declarations with their initialisation, every trigger, and every reached procedure span;
- all test-app event-subscriber codeunits (see C2);
- the dependency fingerprint (see C3).

The broad fallback is a digest of the WHOLE test-app source. That means every `.al` file, normalized the same way, keyed by path, plus the build inputs in `app.json` that change what compiles: `preprocessorSymbols`, `runtime`, `features`, `target`, `application` and `platform`.

**C2: fail closed.** The classifier's cases are listed in `scripts/r371-reach-measure/RESULTS.md` (r2), cases 1 to 20.

- **FOLLOWED:**
  - a bare call or `this.` call that resolves to a procedure of the same codeunit (every overload);
  - a call through a variable typed as a test-app codeunit, where `.Run()` walks OnRun;
  - a `[HandlerFunctions]` handler;
  - `Codeunit.Run(Codeunit::X)` of a test-app codeunit;
  - a built-in on a test-app record, page or other object that cannot fire a trigger with code;
  - a bare call inside a `with`, resolved through the declared type.
- **EXTERNAL:** the object is not in the test app and IS declared by a dependency. This is checked against the dependency symbol packages when they are present; otherwise "not in the test app" is used, and the digest says which.
- **UNFOLLOWED, which takes the broad fallback:**
  - Bind or UnbindSubscription (see the ruling request below);
  - an object run by id or through a variable;
  - interface dispatch;
  - a Variant receiver (except `Is*`);
  - a RecordRef or FieldRef call that can fire a trigger;
  - a procedure of a non-codeunit test-app object;
  - a trigger-capable call on one whose code makes calls;
  - an object declared nowhere visible;
  - a receiver shape the walk does not model;
  - a `with` target of unknown type;
  - a named handler that is not found.
- **Not an edge:** built-in functions and built-in type methods.

Every test-app subscriber codeunit is folded into EVERY digest. That covers both automatic and manual (`EventSubscriberInstance = Manual`) subscribers.

**C3: dependencies.** Microsoft-published dependencies are fingerprinted by publisher, id and version; that is the stated limit. Every OTHER dependency, transitive ones too, is fingerprinted by the SHA-256 of the package that RAN:
- **bcdev:** the resident package, through the same `/packages` read as R-372, one package at a time, hashed and then dropped.
- **al-runner:** the resolved `.app` the run loaded, under the R147 pin.

An unreadable package gives NULL plus `test-digests-unavailable`. Measured on DO: 6 non-Microsoft packages, 14.1 MB, hashed in 9 ms, RSS from 74 to 89 MB. The live download time on bcdev is measured in the build and stated in the submit.

**I4: with-receivers.** They are resolved through the declared type. On DC all 7 with-sites resolve; the other suites have none.

**I5: subsets.** Any future subset mode must leave the survivors it did not test marked UNVERIFIED, never old.

## Measured cost of r2 (166b9bbb): routine edits DO exceed the cap on DC

N is the number of tests one edit turns new, as p50 / p90 / max, over every test-app procedure edited in turn. "Object" means a global or header edit.

| Suite | Tests | On broad fallback | Procedure edit | P(N>50) | Object edit | P(N>50) |
|---|---|---|---|---|---|---|
| DC | 1,301 | 3.3% | 44 / 71 / 1,301 | **19.6%** | 51 / 284 / 1,301 | **53.8%** |
| DO | 1,287 | 6.9% | 90 / 199 / 1,287 | **100%** | 107 / 1,287 / 1,287 | 100% |
| BaseApp | 40,291 | 15.8% | 6,383 / 40,291 / 40,291 | 100% | same shape | 100% |
| sandbox | 68 | 0% | 1 / 1 / 13 | 0% | 68 (one object) | |

- **Where the tail comes from:** subscriber codeunits hold 6.0% (DC), 9.9% (DO) and 14.6% (BaseApp) of test-app procedures. Any edit to one turns EVERY test new.
- **Where the floor comes from:** the broad-fallback tests join every edit, which is why DO fails under the strict rule. 78 of its 89 fallback tests are there only because of BindSubscription.

**Plainly: with a cap of 50, verify would refuse about 1 ordinary procedure edit in 5 on DC and about 1 object edit in 2. On DO it would refuse every edit, and on BaseApp every edit.**

## Rulings requested

1. **Treat Bind or UnbindSubscription as not an edge.** I argue this is safe, because every subscriber codeunit it can bind is already in every digest (C2). It changes no coverage; it only stops a second, redundant trigger of the fallback. Relaxed numbers:
   - DC: fallback 2.9%; procedure edit P(N>50) 15.9%; object edit 42.8%.
   - DO: fallback 0.9%; procedure edit P(N>50) 10.9% (p50 12); object edit 22.1%.
   - BaseApp: still 100%, because its p50 is 1,571.
   I recommend taking it.
2. **The cap.** Even relaxed, 50 refuses 1 in 6 DC procedure edits and every BaseApp edit. The options:
   - (a) keep 50, and verify is a tool for small suites and local edits;
   - (b) a default of about 300, which covers DC's object-edit p90 of 284 (the cost is S x N; at S=10 that is about 3k extra executions);
   - (c) keep the default and make the refusal message give the number to pass as `--max-new-tests`.
   I recommend (c): the refusal is safe, and the operator sees the cost before paying it.
3. **The per-survivor filter** (a new test joins only the survivors it can reach). It is the only thing that bends the BaseApp curve. It needs new-test coverage, so it stays a filed item, not this build.

## Tests (M6), each red-checked

- **Each edge kind as the ONLY path in its test:**
  - a same-codeunit helper;
  - a cross-codeunit helper;
  - a handler;
  - a with-resolved call;
  - a `Codeunit.Run(Codeunit::X)`;
  - an unfollowed edge (fallback);
  - a subscriber edit;
  - globals, the object header and properties, and triggers of a reached object;
  - a non-Microsoft dependency rebuilt at an UNCHANGED version. On the fake bcdev this compares the source run's PUBLISHED dependency package with verify's changed one.
- **Negative cases:**
  - an unrelated edit against a test with a CLASSIFIED external edge does not turn it new;
  - an unrelated edit to an unreached object's globals does not turn it new;
  - a Microsoft dependency rebuilt at an unchanged version does not turn it new (the stated limit, pinned).
- **Also:** an unreadable dependency gives NULL; the v1 refusal; the cap at the limit and at limit + 1; one parse per file.

## Tasks

1. Export the Scanner walk with the classifier, handlers and with-resolution; one shared parse.
2. Object parts, the subscriber fold, the broad fallback and the v2 tag; tests.
3. Dependency fingerprints on bcdev and al-runner, with the download cost measured live; tests.
4. `too-many-new-tests` with `--max-new-tests`, the schema bump and its ripple; tests.
5. File the per-survivor filter item and the Microsoft unchanged-version limit. Close R371, then the CHANGELOG and the agent guide.
6. itest:agreement live, telling the orchestrator before leasing.
