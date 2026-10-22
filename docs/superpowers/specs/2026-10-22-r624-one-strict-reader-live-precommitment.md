# R-624 live pre-commitment: one strict dev/packages reader, read-only on bc3

Committed to master by lane bugs before any live run below. Plan: `docs/superpowers/plans/2026-10-22-r624-one-strict-resident-reader.md` (r2, adopted).
All runs are read-only, on bc3 only, lane bugs.
- **Candidate:** the code of `lethal/r624` at `fb1a753a`. Any later commit before the live runs must change no code
  under `scripts/` or `packages/`; if one does, this file is amended and committed again before the runs.
- **Control:** master `d5a8288a`. Its code is identical to `origin/master` 4bdd459d
  (`git diff --stat d5a8288a 4bdd459d -- scripts/ packages/` is empty). It runs from a scratch worktree,
  `/work/lethal-wt/r624-control`, where `bun install` has run and the native parser is built, and nothing is edited.

Step 0 has already run, before any code: bc3 answers **404** for an app it cannot hold, both for publisher `LethAL`
and for publisher `Microsoft` (`/coord/handoff/R-624/live/0-absent-status.log`).

## The rule

For each step the CONTROL command runs first, then the CANDIDATE command, back to back.

**Every decision and every read value in the candidate's output equals the control's.** The two outputs are
compared line by line after one normalisation:
- On `compiled` lines only, the `sha256 <hex>` and `header packageId <uuid>` fields are masked. alc does not
  reproduce its builds byte for byte: it writes a random header id and a build timestamp on every compile (R599
  F2). The `digest` field is NOT masked.
- Timestamps, lease tokens and the `=== ... build <sha>` banner are not compared.

Everything else must be byte-equal: every resident version, row, packageId read from the server, digest, decision
word, P1 line and Continia line. The comparison is a `diff` of the two normalised logs, and an empty diff is a pass.

- **Any difference is a STOP.**
  - If `kraken coord` shows another holder of bc3 between the control run and the candidate run, re-run the pair
    ONCE: a gate can mint a new target version in between.
  - A difference that persists after that re-run is a BLOCK for the owner. So is one with no other holder in
    between.
- A candidate run that exits non-zero where the control exited zero is a BLOCK, whatever its message.
- If the control itself fails or refuses, do not run the step on the candidate. Report it instead.

## Preconditions (each step)

- `kraken coord holder bc3` is null.
- `free -g` shows at least 10 GB available.
- Setup and republish take their OWN coord lease in lane bugs, so no lease is held by hand around them.
- cdo-publish takes no lease, so step 4 runs under a hand lease: `kraken coord lease bc3 bugs`, a heartbeat every
  3 minutes, released at once.

## Steps (control in `/work/lethal-wt/r624-control`, candidate in `/work/lethal-wt/r624`)

Logs go to `/coord/handoff/R-624/live/<n>-<name>.{control,candidate}.log`, plus `<n>-<name>.diff`.

1. **Setup, the fixtures and the control app.**
   - Command: `bun scripts/bc-linux-setup.ts --server bc3 --lane bugs --predict`
   - Reaches:
     - the shared cache fill (`downloadSymbol`); bc3's cache is already complete, so it reports `1 download`;
     - `downloadSymbols` in every compile;
     - `realOps.resident` for every fixture and for LethAL Control.
   - Expected, from R-599 run 2 §1 (unless a gate has moved a minted version since):
     - `already-pinned LethAL Control 1.0.0.23`;
     - every test app `skip ... same content`;
     - every target `kept minted target`;
     - `predicted: nothing published, ...`, then `ok`, and exit 0.

   The standard the candidate is compared against is the control's output.
2. **Setup, Continia (I2).**
   - Command: `bun scripts/bc-linux-setup.ts --server bc3 --lane bugs --predict --with-continia --accept-build 28.4.53241.56646`
   - Reaches `residentVersion` through `realContiniaOps` and `decideContinia`. The build is bc3's R594 build, from
     `docs/roadmap/R594.md` §Install and the R594 pre-commitment.
   - Expected:
     - 11 lines `P1 Microsoft <app>: 28.4.53241.56646`, none marked `(DIFFERS)`;
     - `P1 Microsoft System: <v>`;
     - `every Continia app's declared dependencies are satisfied`;
     - all 5 Continia apps `skipped ... (resident, equal)`;
     - then step 1's lines, and exit 0.
3. **Republish, a LethAL dependency outside the named apps.**
   - Command: `bun scripts/bc-republish.ts republish --server bc3 --lane bugs --token-dir /coord/handoff/R-624/live/<control|candidate> --predict sandbox-names-tests`
   - Reaches the in-`main` dependency read. `sandbox-names` is not named, so the compile reads the resident
     `LethAL Sandbox Names` through the reader, after `downloadSymbols`.
   - Expected: the compile line, the rows line of the resident dependency, a `skip ... same content` decision,
     nothing published, and exit 0.
   - It writes only its gitignored scratch directory `.kraken-local/bc-republish/bc3/` and its token file.
   - **`alpackages` mode is NOT run:** it refills `fixtures/<dir>/.alpackages` inside the worktree.
4. **cdo-publish `--check-only`** (under the hand lease).
   - Command: `bun scripts/r594/cdo-publish.ts --check-only`
   - It is read-only by its code: with `--check-only`, the whole publish block is skipped, both `ensureApp`
     publishes included.
   - What remains:
     - the version reads, before and after;
     - one read of the test app's package, hashed against the local `/work/lethal-wt/cdo-r396/Test/**/*.al`, which
       is only read.
   - Expected: `P2 before` equals `P2 after`, `P3: ... multiset equal: true`, and exit 0.

## Not run

- No itest, per plan I1: nothing under `packages/` imports these scripts.
- No Continia or CDO publish, no `alpackages` mode and no `control` mode.
- The seam's default (`send` falling back to `bcFetch`) is not red-checked. Reverting it would send the unit tests'
  requests to the real bc3 without a lease. All three production `Conn` objects are written out with only `server`
  and `authorization`.
- Cronus28 and Cronus284 are never touched.
