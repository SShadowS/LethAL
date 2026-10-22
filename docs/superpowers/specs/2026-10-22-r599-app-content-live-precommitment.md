# R-599 live-check pre-commitment (r3)

Plan: `docs/superpowers/plans/2026-10-22-r599-app-content-decision.md` (r3, adopted at bf387593). Server: **bc3**
only. Lane: bugs. Committed before the build and before any live run. The expected values below are fixed now.
Every difference is reported, and none is re-read as "close enough".

## Changes from r2

- **F2:** the alc precondition now claims only what was measured: five packages carry compiler 18.0.43.1464, not
  "every" one. The BLOCK rule in §1 fires only when an AL source entry (`src/...`) differs. A difference only in
  the compiler or in generated entries is a reported finding, not a BLOCK.
- **F3:** the steps are chained by `packageId` (§Chain). Steps 4 and 5 predict the exact after-row `packageId` from
  the local build's header. A new precondition: the worktree the bc3 config was copied from must not run setup
  during step 6.
- **The final state (orchestrator, at adoption):** §7 states what bc3 must hold when the check ends, read back.

## 0. Preconditions (each checked and logged before step 1)

- The build under test is the `lethal/r599` commit named in the log's first line. It must pass all of these:
  - `bun run typecheck`, which now covers the touched scripts;
  - `bun scripts/verify.ts`;
  - the three `bun build --target=bun` link checks;
  - both CI jobs.
- Before EACH step:
  - `holder bc3` is null;
  - `free -g` shows at least 10 GB available.

  Each tool takes and releases its own lease in lane bugs and heartbeats every 60 s. Nothing holds a lease between
  steps; the chain below catches a foreign change made in a gap.
- `git diff --exit-code fixtures/` exits 0.
- The local alc reports compiler 18.0.43.1464. That is the `CompilerVersion` of the five packages measured on bc3:
  Control, Sandbox App, Sandbox Names, Sandbox Names Tests and Sandbox Tests (`measure-bc3.log`). The other ten were
  not read. If alc differs, STOP: every digest would differ.
- `fixtures/sandbox-app/lethal.config.bc3.json` and `.vscode/launch.bc3.json` exist in the r599 worktree. They are
  copied with `cp` from a worktree where `bc-linux-setup.ts` wrote them, and never opened or printed.
- **That source worktree must not run `bc-linux-setup.ts` until step 6 has finished.** The config holds absolute
  paths into it (`packageCachePath`), and setup deletes and re-downloads that directory. The lane confirms this
  with the owner of that worktree and logs the confirmation.
- Logs go to `/coord/handoff/R-599/live/<step>.log`.

## Chain of custody (F3)

Every step prints the Names Tests row (version, `isInstalled`, `packageId`) BEFORE it acts and AFTER it acts.
- Each step's BEFORE row must equal the previous step's AFTER row, by `packageId`. The chain runs:
  §1 `1d69436c-c3de-4863-a104-bfd9ead0f447` → §2 → §3 → §4 before → §4 after (`P4`) → §5 before → §5 after (`P5`) →
  §5's second run, before and after → the row read before §6.
- Sandbox Names keeps `3fe55673-fc35-4552-909f-4454e08185cb` from §1 to the row read before §6. Only §6's own deploy
  may change it.
- Any break STOPS the check and is reported: it means something foreign changed the server between steps.

## 1. Setup's prediction, read-only

`bun scripts/bc-linux-setup.ts --server bc3 --lane bugs --predict`, with no `--with-continia`. It writes no config
or launch file, runs no doctor, and publishes nothing. Expected decisions:

| app | resident on bc3 (`measure-bc3.log`) | expected | basis |
|---|---|---|---|
| LethAL Control | 1.0.0.23, raw sha256 `c2a95948...` | `already-pinned` | measured |
| Sandbox Probes | 1.0.12.1 = app.json | `skip` | not measured |
| Sandbox App | 1.0.20748.2314 | `keep` (minted, instrumented) | measured instrumented |
| Sandbox Data | 1.0.20748.2221 | `keep` | minted; instrumentation not measured |
| Sandbox Hang | 1.0.20747.36740 | `keep` | minted; not measured |
| Sandbox Harden | 1.0.20747.37990 | `keep` | minted; not measured |
| Sandbox Wrapped | 1.0.20747.36977 | `keep` | minted; not measured |
| Sandbox Names | 1.0.20747.42866 | `keep` | measured instrumented |
| Sandbox Tests | 1.0.0.4 = app.json | `skip` | resident source = repo source (r1 review, offline) |
| Sandbox Names Tests | 1.0.0.0 = app.json, digest `99f9d28a...` | `skip` | measured digest |
| Sandbox Data Tests | 1.0.0.21 = app.json | `skip` | not measured |
| Sandbox Hang Tests | 1.0.0.3 = app.json | `skip` | not measured |
| Sandbox Harden Tests | 1.0.0.1 = app.json | `skip` | not measured |
| Sandbox Harden Answers | 1.0.0.1 = app.json | `skip` | not measured |
| Sandbox Wrapped Tests | 1.0.0.5 = app.json | `skip` | not measured |

Every app must show exactly one row, installed. How each kind of difference is read:
- **A test app, or Sandbox Probes, is predicted `publish in place`, and its differing entries include an AL source
  entry (`src/...`).** bc3 held a stale build. That is a **BLOCK on bc3's earlier proofs of the gates that use
  it**. It is reported to the orchestrator and NOT fixed in this task. The gates per app:
  - Sandbox Tests: `itest:bcdev`, `:verify`, `:lease`, `:stale-publish`, `:testapp`;
  - Data Tests: `:tables`, `:chunked`, `:verify-scale`;
  - Hang Tests: `:hang`;
  - Harden Tests and Harden Answers: `:harden`, `:agreement`;
  - Wrapped Tests: `:bcdev-wrapped`;
  - Names Tests: `:bcdev-names`;
  - Probes: `:bcdev`.
- **The same, but only `NavxManifest.xml`, `SymbolReference.json` or `DocComments.xml` differ** (for example a
  different compiler). A REPORTED finding, with the entry names and both compiler versions. Not a BLOCK.
- **A minted target is predicted `refuse above-build`** (it is not instrumented). No gate block, under ruling (a),
  but setup would fail on bc3. Reported.
- **Any `content-unknown`.** Reported, with the rows printed.
- A difference on LethAL Control, Sandbox Names or Sandbox Names Tests STOPS the check here. A difference on any
  other app is reported and does not stop steps 2 to 6, which touch only the names pair.

## 2. A refusal, live, that changes nothing

`bun scripts/bc-republish.ts republish --server bc3 --lane bugs --token-dir /coord/handoff/R-599/live sandbox-names`,
without `--mint`. Expected:
- exit 1, with `refuse above-build` naming LethAL Sandbox Names, resident 1.0.20747.42866 above 1.0.0.0, and the
  remedy `--mint sandbox-names`;
- no publish line;
- Names: `packageId` `3fe55673-...`, one row, installed;
- the Names Tests row (read as Names' installed fixture dependent, F4) still `1d69436c-...`.

## 3. Same content: skipped

`republish ... sandbox-names-tests`. Expected:
- `skip`, digest `99f9d28afe4d...`;
- one row, installed, version 1.0.0.0, `packageId` `1d69436c-c3de-4863-a104-bfd9ead0f447` before and after;
- no publish line; exit 0.

## 4. Same version, changed content: published in place

With the Edit tool, append exactly `\n// R-599 probe comment\n` to the end of
`fixtures/sandbox-names-tests/src/NamesTests.Codeunit.al`. These are the same bytes as the offline `nt-comment.app`
build. Then `republish ... sandbox-names-tests`. Expected:
- the compile line prints the local build's header id, read from bytes 12 to 27 in .NET GUID byte order. Call it
  `P4`. It is printed before the publish;
- `publish in place`, content changed in exactly `src/src/NamesTests.Codeunit.al`;
- resident digest `99f9d28a...`, local digest **`a56ae76c2b18...`** (predicted exactly from
  `offline/nt-comment.app`), both compilers 18.0.43.1464;
- nothing uninstalled or unpublished;
- read-back: version 1.0.0.0, raw sha256 equal to the local build's, digest `a56ae76c2b18...`;
- the after row: exactly one, **`isInstalled` true**, version 1.0.0.0, **`packageId` = `P4`**;
- exit 0.

If BC refuses the publish, the old build stays installed. STOP and report it as a measurement that the direct
`dev/apps` path behaves differently from `itest:testapp`'s altool path.

## 5. Back to the repo build

Revert the comment with the Edit tool. `git diff --exit-code fixtures/` must exit 0. Then
`republish ... sandbox-names-tests`. Expected:
- the compile line prints `P5`, the new local header id;
- `publish in place`, content changed in exactly `src/src/NamesTests.Codeunit.al`;
- resident digest `a56ae76c2b18...`, local digest `99f9d28afe4d...`;
- read-back raw sha256 equal to the local build's;
- one row, **`isInstalled` true**, version 1.0.0.0, **`packageId` = `P5`**.

Then run the same command once more. Expected: `skip`, digest `99f9d28afe4d...`, no publish, and the row's
`packageId` still `P5`, before and after.

If step 4 published and step 5 fails, bc3 holds the comment build of Names Tests. Its behaviour is the same, but
`itest:bcdev-names` is not admitted on bc3 until it is replaced. Reported.

## 6. Re-prove the gate that uses the app

First read the rows, with `republish --predict sandbox-names-tests`. Expected: Names Tests `P5`, Sandbox Names
`3fe55673-...`.

Then run `LETHAL_ITEST_BCDEV=1 LETHAL_ITEST_CONFIG=lethal.config.bc3.json bun run itest:bcdev-names`, in the
foreground, never signal-stopped. Expected, per `docs/gates/bcdev-names.md`:
- first line `[itest target] config=lethal.config.bc3.json server=...:7249 ...`;
- `names leg (bcdev): fenced killed=36 survived=0 noCoverage=0`;
- every verdict and killing test equal to `bcdev.names.baseline.json` and to the R557 pre-commitment
  (`docs/superpowers/specs/2026-10-09-r557-names-precommitment.md`);
- each of the 36 kills `killReproduced`, with exactly 2 mutated rows for its killing test (R582);
- `bcdev names itest: PASS`.

Any differing verdict is a BLOCK. On a PASS, add the pair (bc3, `itest:bcdev-names`) to `servers.md`'s R582 table,
with this log.

## 7. The final state, read back (required)

After §6, read the rows once more (`republish --predict sandbox-names-tests` and `setup --predict`). bc3 must end:
- **Sandbox Names Tests at its ORIGINAL content:** digest **`99f9d28afe4d...`**, version 1.0.0.0, exactly one row,
  `isInstalled` true, `packageId` `P5`. This is read back from the server (the `dev/packages` download digested), not
  assumed from §5. A `skip` decision on it is the expected output.
- Sandbox Names: a minted, instrumented build. §6's own deploy may have replaced `3fe55673-...` with a newer minted
  version (that is what a gate does), and setup's prediction must read it `keep`.
- Every other app: the same decision as in §1.
- The repo: `git diff --exit-code fixtures/` exits 0.

If any of these does not hold, the check is not closed. The difference is reported with the rows, and the remedy is
named (republish Names Tests from the repo build).

## What this check does not prove

- The in-place publish of a TARGET with installed dependents. Row 6 refuses it, and it is filed as a roadmap item.
- Setup's act pass on bc3: only `--predict` runs there. The act pass shares its publish and read-back code with
  steps 4 and 5.
- `--predict --with-continia`. It is unit-tested only; bc3 carries the R594 Continia oracle, and nothing here
  touches it.
- The unmeasured rows in §1. They are predictions: a difference is a finding, not a failure of this check, except
  where §1 says it stops.
