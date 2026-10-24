# R709 probe: BC's full 422 body when an upgrade breaks installed dependents

**Status: run once on bc2, 2026-10-24 16:00:37Z (R-709b, pre-commitment 95ce48db; every build's sha256 matched).
Results: `/coord/handoff/R-709b/measure.md`. Do not re-run without rebuilding under a new pre-commitment: bc2 holds
installed-version records for T and U at 1.0.0.2 until a restart (R605).**

Question (R709): when an UPGRADE of a target breaks installed dependents and BC "could not restore", what is
the exact format of BC's list of removed extensions, for ONE dependent and for TWO? R707's probe cut every body
at 500 chars and lost it. This probe never truncates a body: each refusal body is written whole to
`.kraken-local/r709-probe/body-<step>.txt`, and its sha256 and length go into the step's JSON line (with the
full text).

Invented AL, no tables. Publisher `LethAL Probe`. Source dirs: `t1 t2 u1 u2 d1 d2 e`.

| App | Id | Object ids | Builds |
|---|---|---|---|
| R709 Probe Target (T) | `9ff560dd-bcde-4128-8f36-d9eaf8110c4c` | 93730-93739 | T1 (1.0.0.1, `Answer()` returns 1); T2 (1.0.0.2, `Answer` removed, `Other()` instead) |
| R709 Probe Dep One (D1) | `6a564aa8-4536-4653-98d2-2a9d762df994` | 93740-93744 | 1.0.0.1, depends on T >= 1.0.0.1, web service `R709DepOne` |
| R709 Probe Dep Two (D2) | `e1042b90-751b-4790-b064-1731c55bb830` | 93745-93749 | 1.0.0.1, depends on T, web service `R709DepTwo` |
| R709 Probe Target Solo (U) | `4ccbac7b-5f98-4140-8575-8110a8ddac49` | 93750-93754 | U1 (1.0.0.1, `Answer()`); U2 (1.0.0.2, `Answer` removed) |
| R709 Probe Dep Solo (E) | `d296a165-7cc2-482b-b43a-3836b2f160f8` | 93755-93759 | 1.0.0.1, depends on U >= 1.0.0.1, web service `R709DepSolo` |

Each dependent's `Call(): Integer` returns the target's `Answer()`. Its Install codeunit registers the web
service (Tenant Web Service). D1, D2 and E compile against T1, T1 and U1.

## Run

Build once, offline (System symbols from `/coord/cache/bc-symbols/<server>`, no server call):

    bun scripts/r709-probe/drive.ts --build --server bc2

Output goes to `.kraken-local/r709-probe/` (gitignored), with `shas.json`. Do not rebuild after the
pre-commitment records the hashes: every alc build gets a fresh header id.

Under a lease on the server, from the worktree root:

    bun scripts/r709-probe/drive.ts --server bc2 --lane <lane> --step 1   # then 2, 3, 4, 5, cleanup
    bun scripts/r709-probe/drive.ts --server bc2 --lane <lane> --all

It refuses (exit 2) unless `kraken coord holder bc2` names `--lane`. The login is read inside the process and
never printed. Each step reads state first (by app id only, R433) and refuses if it is not what the step
expects. Each prints one JSON line of facts. Every call times out at 120 s. `--all` runs 1..5 then cleanup, and
stops at the first refusal-to-proceed (cleanup still runs).

## Steps

1. Publish T1, D1, D2. Read each back (installed 1.0.0.1).
2. Call `R709DepOne_Call` and `R709DepTwo_Call` over OData. Expect HTTP 200, value 1.
3. Publish T2 (the upgrade). Expect a refusal. Save the FULL body. Read T, D1, D2 and call both services.
4. Publish U1, then E. Read back. Call `R709DepSolo_Call` (200, 1).
5. Publish U2. Expect a refusal. Save the FULL body. Read U and E, call the service.
- `cleanup`: uninstall then unpublish every row of D1, D2, T, E, U that exists. Read back absent. Print what remained.

## After the run

bc2 keeps its installed-version records for T and U at 1.0.0.2 (R605) until a restart. Say so in the submit
note.
