# DO live campaign — run manifest

Pinned inputs for the 2026-08-03 campaign. A verdict file without its configuration is an
unreproducible aggregate, which is how the 2026-07-28 anchor died.

## Source under test

| field | value |
|---|---|
| DO worktree | `U:/Git/do-lethal` |
| worktree branch | `lethal/campaign-2026-08-03` |
| **pinned commit** | `5f2a71d36215a83fa4a554de90637f151521feb5` |
| commit subject | Merged PR 51384: Bug #77641: Opt-in template-linked scheduling on Document Output queue |
| cut from | `U:/Git/do-rel2`, branch `development/dfc491cc-814e-4739-b23f-6f647f140d38-promotion` |
| pull performed? | **No** — `git fetch` only. The user's checkout was already current (`HEAD == @{u} == 5f2a71d3`), and their working tree was never touched. |
| DO app | Continia Document Output `28.4.0.0`, `runtime 17.0`, `idRanges 6175271–6175468` |

## LethAL under test

| field | value |
|---|---|
| repo | `U:/Git/LethAL`, branch `master` |
| **commit at rung 0** | `30685d0` |
| campaign tooling merged at | `bbacfca` (branch `campaign-tooling`, 13 commits) |
| rungs 0–2 run from | source (`bun packages/runner/src/cli.ts`) |
| rung 3 runs from | the standalone binary — **rebuilt at rung 3 per Task 8 step 1b**, see below |

### Binary provenance (rung 3 only) — filled in at rung 3, not before

`build/` is gitignored, so git records nothing about which commit produced a binary, and the
filename carries only the package version. R88. These fields are the only place the provenance can
live:

| field | value |
|---|---|
| binary source commit | `0c7a6b083eac29abe5f4f3386596647aef95bf46` |
| sha256 | `75d1124520e683cf83f5742eb96add9edf8edbd691ea285f66552c62a879088d` |
| build timestamp | `2026-08-05 00:46:19` |
| operator presence check | **PASS** — `grep -ac` returns 3 for each of `swap-call-arguments`, `remove-commit`, `remove-setrange`, `negate-conditional`, `void-method-call`. The superseded 2026-07-27 build returned **0** for the first two. Filename is byte-identical between the two builds (R88). |

## Selector ids

| role | id |
|---|---|
| `selectorId` | 6175468 |
| `controlId` | 6175467 |
| `tableId` | 6175466 |

Verified free against the 116 codeunit ids `Cloud/` declares, and inside the app's own `idRanges`.

## Toolchain

| field | value |
|---|---|
| alc | **17** (pinned via `bcdev.alcPath`; DO declares `runtime 17.0`, and R43 measured alc 18 writes a package BC 28 cannot load) |
| alc version observed | _(gate 0 item 3)_ |
| environment tool | `U:/Git/CLI/continia.exe` |

## Environment

| field | value |
|---|---|
| profile | `c803cb93-a8e4-4fb1-b61f-e5f60f17b43a` (BC 28.0.0.0, NavUserPassword, demoportaldev) |
| name | `lethal-do-campaign` |
| environment id | `f5f11bf2-4b02-48f1-9707-2bd49f81bf2b` |
| `expiresUtc` | `2026-08-18T08:09:48` (created `2026-08-04T08:09:48`) |
| created fresh? | Yes — **not** reusing `f19aca88`. R31 detects a test app missing tests, but R56's shape (an older-but-COMPLETE published build) is invisible, and a fresh environment is its only mitigation. |

## Flag sets

Recorded per rung as each runs.

| rung | flags |
|---|---|
| 1 | `--only "Al/Codeunit/Codeunit 6175297 CDO Send Cust. Statement Mgt.al" --tests-only "Src/AutomaticDocuments/**" --stop-hung-sessions` |
| 2 | _(rung 2 — module chosen by measurement; `--allow-large-run` required above 1,000 sites)_ |
| 3 | _(rung 3)_ |
