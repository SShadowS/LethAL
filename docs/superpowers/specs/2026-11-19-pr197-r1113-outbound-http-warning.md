# PR-197 design and pre-commitment: warn before a run about test codeunits that can make real outbound HTTP calls (R1113 fix 2)

Coord PR-197 (lethal-code, 2026-11-19). Roadmap: R1113, fix 2. Evidence: `/coord/handoff/PR-197/`.

## 1. The problem
- **One test that waits on the network can quarantine a whole bcdev baseline** (R1113: three DO hangs on bc4). Two of them were
  Azure tests (`CDO Azure Blob Folder Tests`, `CDO ABS Auth Settings Tests`).
- **BC's default `TestHttpRequestPolicy` lets the request out** (PR-176, bc3): with no policy set, the call goes out exactly as
  under `AllowAllOutboundRequests`. `BlockOutboundRequests`, and `AllowOutboundFromHandler`, error before sending.
- **DO's test app sets the policy nowhere**, in 0 of its 113 test codeunits.
- **Nothing tells the user before the run.**

## 2. What was measured before designing (a regex prototype, `/coord/handoff/PR-197/proto-do2.tsv`)
- **Object-level reach** (a test codeunit, then every codeunit it names, then every codeunit those name, ending at a codeunit that
  declares `HttpClient`), over DO's test app, DO, and the source shipped inside every dependency `.app` in bc4's package cache:
  - it flags **83 of 113** DO test codeunits;
  - it **does** find both Azure codeunits: `CDO Azure Blob Folder Tests` and `CDO ABS Auth Settings Tests`, both through
    `CDO Azure Blob Storage`, then `CTS-SYS Azure Blob`, then `CTS-SYS Http`;
  - most hits pass through hub codeunits (`CSC Core Session Manager` 47, `CSC Credential Management` 14), which name an HTTP
    codeunit somewhere in an object whose other procedures the test calls.
- **The first prototype also matched dependency codeunits by name** (Http, Azure, Blob and so on). That flagged 88 through
  `Temp Blob`, a memory buffer. It is dropped: names are not evidence.
- **So object-level reach is too noisy to act on** (owner principle 34). The design is procedure-level reach.
- **Every dependency `.app` measured ships its AL source:** 78 files for Continia System Application, and 1,339 for Microsoft's System
  Application.

## 3. The change
1. **The scan (a new module, `packages/runner/src/outbound-http.ts`), static and offline:**
   - **The scope:** the test codeunits the run selects, after `--tests-only`, `--only`, `--exclude-test`, and any other test
     filter. The scan runs on the same selection the baseline would run.
   - **Guarded:** a test codeunit whose `TestHttpRequestPolicy` is `BlockOutboundRequests` or `AllowOutboundFromHandler`. BC
     errors before sending under both (PR-176). It is never warned.
   - **The reach** for an unguarded codeunit:
     - **Starts** at every `[Test]` procedure, and every handler procedure its tests name (`HandlerFunctions`).
     - **Edges**, from a procedure:
       - a bare call to a procedure of the same object;
       - a call `X.P(...)` where `X` is a variable, parameter or return of type `Codeunit "N"`: the procedures named `P` of
         codeunit `N`, every overload;
       - `Codeunit.Run(Codeunit::"N")` and `Codeunit.Run(<id>)`: `N`'s `OnRun`.
     - **The sink:** a procedure whose body calls a method on a variable of type `HttpClient` (`Send`, `Get`, `Post`, `Put`,
       `Delete`, `Patch`).
     - **Sources:** the test project and the target project from disk, plus the `.al` files inside every `.app` in the run's
       package cache (`packageCachePath` for bcdev; the symbol sources v3 is given). Dependency files are parsed only when the
       reach enters one of their objects, found through a name-to-file index built from object header lines.
   - **Not followed, and named in the warning text:**
     - event subscribers (a publisher's subscribers are not edges);
     - interface calls;
     - `Codeunit.Run` on a variable id;
     - table, page and report triggers;
     - objects with no source in the cache.

     So the scan is an under-approximation: a codeunit it does not list can still make a call.
   - **Parsing:** the engine's native parser. A file the parser refuses, or an unresolved receiver, is skipped and counted. It
     is never treated as a sink or as safe in silence; the count is printed.
2. **Where it runs:**
   - At the start of `lethal run` for `bcdev` and `al-runner-v3`, after test selection and before the first server or
     al-runner call.
   - In `lethal run --dry-run`, through PR-194's shared `preflightRunConfig` if the selected test set is known there;
     otherwise in the dry run's own path.
   - Never in `doctor`: doctor has no test selection.
3. **What it prints** (stderr, as a `warning` event; the report is unchanged):
   - `[lethal] N selected test codeunit(s) can reach an outbound HTTP call with no TestHttpRequestPolicy set to block it.
     One of them waiting on the network can hang the whole baseline (R1113).`
   - One line per codeunit: its name, its file, and one shortest call path down to the sink (`Codeunit.Proc -> ... ->
     HttpClient.Send`).
   - **The advice:** set `TestHttpRequestPolicy = BlockOutboundRequests` (or `AllowOutboundFromHandler` with a handler) on these
     codeunits, or leave them out with `--exclude-test` / `--tests-only`.
   - The skipped and unresolved counts, and the scan's limits, in one line.
   - Never a refusal, and no flag needed (owner principle 17: the default keeps the fact).
4. **Tests** (invented AL sources, with no Continia text):
   - a direct sink is flagged;
   - the reach crosses a codeunit-typed variable;
   - the reach crosses a dependency `.app`'s source;
   - **the precision case:** a test whose codeunit calls one procedure of a codeunit that has an HTTP procedure, but not that
     one, is not flagged;
   - both guarded policies are skipped, and a policy of `AllowAllOutboundRequests` is flagged;
   - `Codeunit.Run(Codeunit::"N")` reaches `N`'s `OnRun`;
   - an event subscriber is not followed;
   - an unresolved receiver is counted;
   - the warning prints in a `run` and in a `--dry-run`;
   - red checks in both directions for the guard, the precision case and the receiver edge.

## 4. Predictions (the build, measured offline: DO's test app, DO, bc4's package cache)
- **P1:** the DO list contains `CDO Azure Blob Folder Tests` and `CDO ABS Auth Settings Tests`, each with a path through
  `CTS-SYS Azure Blob` to an `HttpClient` call.
- **P2:** the DO list is strictly shorter than the object-level prototype's 83. Every codeunit the prototype flags that the build
  does not is a precision gain, by construction. Every codeunit the build flags that the prototype did not is named and read:
  each needs a call path the prototype could not see, or it is a bug.
- **P3:** `CDO Data Upgrade Tests` (the codeunit of PR-68's third hang, which made no HTTP call) is reported as the build finds
  it, flagged or not. Either way it is not counted as evidence: that hang had no network call.
- **P4:** the scan of DO takes under 30 s of wall time on the container, and that time is printed.
- **P5:** the fixtures of every gate print no such warning (none uses `HttpClient`), so no gate's stdout or figures move.

## 5. Gates
- A static stderr warning. The al-runner-v3 gate and `itest:bcdev` on the final head check that it prints nothing on the fixtures
  (P5).
- No control-app change.
