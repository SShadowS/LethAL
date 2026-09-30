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
