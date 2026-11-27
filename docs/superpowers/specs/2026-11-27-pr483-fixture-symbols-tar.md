# PR-483 (R1128): the fixture symbol tar gets every fixtures/* project, and a guard keeps it so — pre-commitment r1

lethal-code, 2026-11-27. Written before building the tar or changing code.

## Measured

- The pinned tar (`165b17dd…`, `fixture-symbols.manifest`) has NO `.alpackages` member for **six** `fixtures/*`
  projects that have an `app.json`:
  - `sandbox-carry`, `sandbox-carry-tests`;
  - `sandbox-reach`, `sandbox-reach-tests`;
  - `sandbox-tailcut`, `sandbox-tailcut-tests`.
  - R1128 named only tailcut; carry and reach were added since.
- So `compile:fixtures` SKIPs all six on a fresh worktree.
- **Why no guard caught it:** `symbolTarDrift` skips a project with no members (`if (files.length === 0) continue;`),
  so a project missing from the tar passes.

## The new tar (R670 and PR-162's ruling: append, never rebuild by script)

- **New tar** = the pinned `165b17dd…` tar, every member byte for byte, PLUS `.alpackages` for the six:
  - each target (`sandbox-carry`, `sandbox-reach`, `sandbox-tailcut`): `Microsoft_System_28.0.47067.0.app`, the same
    bytes as the tar's existing copy (for example `sandbox-dates`');
  - each tests project: that file, plus `LethAL_<target's app.json name>_1.0.0.0.app`, an `alc` build of its target
    against that System symbol (no `/define`: none of the six has a `symbol-sets.json`).
- **Made by** copying the old tar and appending (`tar -rf`), so the earlier members stay byte-identical.
- **Named** `fixture-symbols-<sha12>.tar` beside the old one (R670).
- **Re-pin** in the same commit: `FIXTURE_SYMBOLS_TAR`, `FIXTURE_SYMBOLS_TAR_SHA256`, and `fixture-symbols.manifest`
  (`tar -tf`, directories left out, with its `# sha256` line). The comment above the pin is extended with this tar's
  provenance.

## The guard

- `symbolTarDrift` (or a sibling the same test calls) reports every `fixtures/*` project with an `app.json` that has NO
  member in the tar: "`<dir>`: in no fixture-symbol tar; compile:fixtures would SKIP it (R1128)".
- No exemption list. If a fixture must stay out, that is a new decision recorded here first.
- The existing CI test that runs `symbolTarDrift` against the committed manifest and the repo's `app.json`s now fails
  on the OLD manifest, naming exactly the six.
- **Red checks:**
  1. on the old manifest the guard names exactly the six; on the new one, none;
  2. putting `if (files.length === 0) continue;` back makes the new unit test (a project with no members) pass
     wrongly, so the test goes red.

## Proof, pre-committed

- A FRESH worktree (new `git worktree add`, no `.alpackages`, no marker), with the new tar in place, runs
  `bun run compile:fixtures --require-symbol-sets`: **0 SKIP, 0 FAIL**, all 37 projects compiled.
- `scripts/build-fixture-symbols-tar.test.ts` and the fixture-symbols tests pass. VERIFY passes. CI passes.
- Gates: per `legs.ts`.

## Re-pin consequence (stated)

- Every worktree whose two gate folders came from the old tar refuses until `bun scripts/fixture-symbols-reset.ts
  <worktree>` (the documented one-line fix).
- The tar exists only in `/work/lethal/.kraken-local` on this host. Another machine needs it delivered: the orchestrator
  is told.
