# PR-14 pre-commitment: al-runner v3 against BC, test by test, batch 2 (five BC.History modules with support apps)

Lane lethal-bugs, coord PR-14 part 2, 2026-11-15. Committed before any publish to a BC server. Same method as PR-03
(`docs/superpowers/specs/2026-11-15-pr03-bc-differential-precommitment.md`, R1020), under the owner's standing approval (kraken
q-20261114T210729-30bf7112): small BC.History app+test pairs on bc2 or bc3, scratch ids, the lease held throughout, each app
unpublished after its run.

## What is new against PR-03

The test apps need SUPPORT apps the server does not have (a module's own test library, Permissions Mock, Any). Each is published
as a renumbered copy too (publisher "LethAL Scratch", new app id, objects in 91600-91799, object names unchanged), but only
those that compile offline against the server's symbols (System Application, Library Assert, System), i.e. use no System
Application internals (`/coord/handoff/PR-14/bc/compile.md`). Dropped as using internals (AL0161): the test libraries of Client
Type Management, Confirm Management, SharePoint and Advanced Settings. Publish order: support apps first; each run removes its
apps in reverse order (uninstall with data, unpublish).

A support copy keeps the original's object NAMES. If the server refuses a publish because a test-toolkit app it already has
uses the same name, that module is dropped from the batch (recorded), never forced.

## The modules and the v3 baseline (measured 2026-11-15 on `current` edge-5a58a0f16, master bf221273)

| module | test codeunits (scratch id) | tests | support apps | v3 |
|---|---|---|---|---|
| Field Selection | Field Selection Test (91640) | 4 | Permissions Mock, Field Selection Test Library | 4 pass (PR-03 run) |
| Encoding | Encoding Test (91660) | 3 | Any | 3 pass |
| Azure Storage Services | Stor. Serv. Account SAS Test (91670), Stor. Serv. Shared Key Test (91671) | 2 | Any | 2 pass |
| Video | Video Test (91690) | 2 | Video Test Library, Permissions Mock | 2 pass |
| Navigation Bars | Navigation Bar Sub. Test (91710) | 2 | none | 2 pass |

v3 evidence: `/coord/handoff/PR-14/v3/` (configs, stores, events) and `/coord/handoff/PR-03/fieldselection.*`.

## Predictions

1. Every one of the 13 tests passes on BC: v3 and BC equal per test.
2. A test that fails on BC only because the server has Base Application installed (Microsoft runs these tests on System
   Application alone; R1020's Document Sharing case) is recorded as an environment difference, not a v3 defect: the failure
   text must name a Base Application object for that call.
3. Any other difference is decided by BC's answer and filed as in PR-03 (invented repro, upstream issue or comment, roadmap,
   regression-set entry).

## Amendment 1 (2026-11-15, after the first publish was refused, before any test ran)

On bc2 (lease attempt 369) the first publish, the copy "PR14 Permissions Mock", was refused (HTTP 422: permission set name
'ALL OBJECTS' exists in both): the server already has Microsoft's own Permissions Mock (40860557-...dc80) and Any
(e7320ebb-...280b), both 28.4.53241.56646 and installed. BC restored its state; nothing was installed. The rule above says to
drop such a module. Instead, before any further publish and before any test of this batch ran, the method changes for these
two apps only: the test apps and test libraries depend on the SERVER's own Any and Permissions Mock (compiled against
Microsoft's symbols of the same app ids from the corpus pool) and no copy of either is published. The renumbered test-library
copies (Field Selection, Video) stay. The modules, tests and predictions are unchanged. Rebuilt apps:
`/coord/handoff/PR-14/bc2/` (`compile.md`).
