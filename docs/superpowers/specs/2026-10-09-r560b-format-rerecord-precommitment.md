# R-560 part B: re-record the 5 BC gate baselines under R556's format (pre-commitment)

Committed to master BEFORE any record run (R332). Lane `lethal-preproc`, 2026-10-09. Part A
(`2026-10-09-r560a-format-rerecord-precommitment.md`, merged at 22bd1bd9) did the 7 al-runner files. This part uses
the same rules, on Cronus28.

## What changes, and what must not

This is a FORMAT-only re-record. A "row" below is one mutant entry in a baseline file.

- Each file changes from a bare array to R556's object `{ "identityScheme": <n>, "entries": [...] }`.
- Each row gains `mutatedTextSha256`, a sha256 hash of the mutant's mutated text. The text itself is never stored.
- Nothing else may change. With the hash removed, every row's `key`, `verdict`, `killingTest`, `errorClass` and
  `coverageFiltered` must be byte-identical to master's file, and the set of keys and the row count must be
  unchanged. Any other difference, including a `killingTest`-only one, is a BLOCK: report it, do not record it.
- Row ORDER is compared too. An order-only difference is reported in the submit note before anything is committed.
- `identityScheme` must equal `IDENTITY_SCHEME` on master when that gate is recorded: **38** today. R-531 will take
  39. If it lands mid-batch, the gates not yet recorded wait for it, so each recorded file carries the scheme of the
  master it is merged into. If a gate was already recorded at 38 when 39 lands, I ask the orchestrator before
  continuing.
- Every row must carry a hash. A row without one means its text was clipped (longer than 600 characters) or not a
  string. That is a finding to report, not a pass.

## Files, with the figures that must come back unchanged

| file | gate | rows | killed / survived / no-coverage / timeout-killed | sha256 of master's file (first 12 hex) |
|---|---|---|---|---|
| `bcdev.baseline.json` | `itest:bcdev` | 19 | 3 / 12 / 4 / 0 | a265c31fd531 |
| `bcdev.wrapped.baseline.json` | `itest:bcdev-wrapped` | 98 | 60 / 38 / 0 / 0 | c1609a29d5eb |
| `hang.single.baseline.json` | `itest:hang` | 38 | 24 / 9 / 0 / 5 | ba07f72204c2 |
| `harden.baseline.json` | `itest:harden` | 21 | 16 / 5 / 0 / 0 | 18ac09ca280d |
| `tables.baseline.json` | `itest:tables` | 406 | 314 / 70 / 22 / 0 | 1c01219e895f |

Each gate's other frozen figures (for example `groupedCalls`, `warmKills` and the named baseline failure in tables)
are asserted by the gate itself and must pass unchanged in the confirm run.

## Not in this part

- `envtool.baseline.json` stays UNVERIFIED: the environment tool is host-only.
- `itest:chunked` has no baseline file: it compares its two legs with each other.
- `itest:verify-scale` and `itest:verify-agreement` only READ `tables.baseline.json` and `harden.baseline.json`,
  through `readGateBaseline`, so they need no record.
- The 6 campaign stages are a later batch.

## Procedure, per gate (R332)

One gate per Cronus28 lease. The lease is released between gates, so other lanes' runs can interleave.

1. Take the lease (`coord.sh lease Cronus28 preproc`) and start the heartbeat.
2. Delete that gate's baseline file.
3. Record: `LETHAL_ITEST_<GATE>=1 LETHAL_ITEST_RECORD_BASELINE=<file> bun run itest:<gate>`. It must exit 3.
4. Check mechanically: strip `mutatedTextSha256`, then compare to `git show <master>:<file>`, once sorted by `key`
   with keys canonicalised by `jq -S`, and once unsorted (order). Check the scheme and that every row has a hash.
   A difference is a BLOCK: restore master's file, release the lease and report.
5. Confirm: the same gate with no record variable. It must PASS, and print no UNVERIFIED line for that file.
6. Release the lease and stop the heartbeat.

If a gate refuses before measuring (for example a stale test app, or a container that needs an owner recycle),
restore master's file, release the lease and report. That is not a difference.
