# R-599 plan r3

r3 is `plan-r2.md` with the changes below; every section of r2 not named here stands as written. Reviews:
`review-plan-opus.md` (r1) and `review-plan-r2-delta.md` (r2, ADOPT with fixes). Pre-commitment: `precommitment.md`
(r3 draft, not committed).

## Changes from r2

### Build order, step 1: the touched scripts go under typecheck (orchestrator ruling on F1)

Before any other change, add these to `scripts/tsconfig.json` `files`, so every later step is typechecked:
`bc-linux-setup.ts`, `bc-linux-setup.test.ts`, `bc-republish.ts`, `bc-republish.test.ts` and
`r594/cdo-publish.ts`. The new `bc-app-content.ts` and its test join the list when they are created.

**Measured now, offline: 0 existing type errors.** I ran `tsc` on a scratch tsconfig that extends the repo's
`tsconfig.base.json` with the same strict flags (composite and emit turned off, so it runs outside the project) over
those five files and everything they import. It exited 0 with no diagnostic. The config and its empty output are
`/coord/handoff/R-599/tsc-scratch.tsconfig.json` and `tsc-scratch.out.txt`. The scratch run did not use the
composite project's references, so the real `bun run typecheck` after the edit is the confirmation. If it reports
a TS6059/TS6307 (a file outside the project), that is a wiring issue, not a type error. The precedent is that
`measure-testpage-exclusive.ts` is already admitted and imports `packages/schemata/src/project` by relative path,
so no new reference is expected. Pre-existing fixes needed: **none**. If the real typecheck shows otherwise, small
ones are fixed and listed here as pre-existing fixes; anything larger stops for a ruling.

**The broader gap, filed as a roadmap item** (id re-checked on origin/master first). Of the 224 tracked `.ts` files
under `scripts/`, `scripts/tsconfig.json` lists 96. The other **128** are never seen by `bun run typecheck`, 26 of
them tests. Before this task's five are added, that list includes `bc-linux-setup*.ts`, `bc-republish*.ts`,
`r594/cdo-publish.ts` and `r554-probe/bc-reach.ts`. Rule: `git ls-files 'scripts/*.ts' 'scripts/**/*.ts'` minus
`files`. The list is `/coord/handoff/R-599/scripts-outside-typecheck.txt`. After this task, 123 remain. The item
records the count, the rule and the list, and proposes no fix, because many are spent probes.

The `bun build --target=bun` link check (below) stays as a belt.

### F1. Module moves, re-exports, typecheck and the build loop (r2 §5, §9)

- `controlAction` and `ControlAction` move DOWN into `scripts/bc-app-content.ts` with their bodies unchanged, so
  setup can use them without importing `bc-republish.ts` (that would bring the I6 cycle back).
- `bc-republish.ts` re-exports `packageStatus` and `controlAction`, so `bc-republish.test.ts`'s import line stays
  as it is.
- `bc-linux-setup.ts` keeps exporting `ensureApp` and `residentPackage`. `scripts/r594/cdo-publish.ts` imports
  them, along with `Conn`, `alcCompile`, `readSecretFile` and others, and setup re-exports every moved name it
  imports. `ensureApp` stays because `ensureContinia` and `cdo-publish.ts` use it. The fixture path stops calling it.
- `scripts/bc-app-content.ts` and `scripts/bc-app-content.test.ts` are added to `scripts/tsconfig.json` `files`
  when they are created. The module imports `packages/runner/src` (already a referenced project) and
  `packages/schemata/src/project.ts` for `CONTROL_SELECTOR_FILENAME`, by relative path. The admitted
  `measure-testpage-exclusive.ts` already imports schemata the same way.
- **The build loop gains one step, before every push:** `bun build --target=bun <file> --outdir <scratch>` on
  `scripts/bc-linux-setup.ts`, `scripts/bc-republish.ts` and `scripts/r594/cdo-publish.ts`. Bun refuses a missing
  named export, which neither `bun test` nor typecheck would catch for these three files.
- **The tsconfig gap** is handled by build step 1 above: this task's files go IN, and the broader gap is filed.
  Run `ls docs/roadmap/` on origin/master right before writing the id. With r2's two items, that makes three new
  items (R619 to R621 if nothing lands first).

### F2. The changed-content line names the differing entries (r2 §2)

The changed-content line becomes:
`published in place <name> <v>: content changed in <entry>, <entry>... (resident digest <12 hex>, compiler <c>; local <12 hex>, compiler <c>)`.
The names come from comparing the two packages entry by entry: both are already unpacked for the digest.
`--predict` prints the same entry list on a `publish in place` decision. This is what separates a stale SOURCE
(`src/...` differs) from a different compiler (only `NavxManifest.xml`, `SymbolReference.json` or `DocComments.xml`
differ). The pre-commitment's BLOCK rule uses it. One test: two packages that differ only in one `src/` entry
name exactly that entry.

### F4. "Installed fixture dependent" in both modes (r2 §2 row 6, §4)

The input to row 6 is computed in BOTH modes, over ALL fixture manifests (`fixtureManifests()` with the existing
`dependsOn`). For each fixture that depends on the app, the tool reads that fixture's automation rows; one
installed row counts. So `republish sandbox-app`, where the target is at its app.json version with other content
and `sandbox-tests` is installed, is refused by row 6 instead of being published in place. New test: exactly that
case in republish mode gives the `same-version-target` refusal and 0 publishes. It goes red if the dependents are
looked up only in the requested list.

### F5. `--predict` with `--with-continia`, and the config writes (r2 §3)

- `ensureContinia` splits along the same line as everything else. Its reads (P1's Microsoft versions, each
  Continia app's resident version, the dependency check) run in the decide pass. Its publishes run in the act pass,
  only when no app anywhere was refused. `--predict --with-continia` therefore prints P1 and the Continia
  decisions and publishes nothing. Its rules (equal version skips, a different version refuses) are unchanged.
- `setupServer` writes the configs and launch files BEFORE it takes the lease today. Under `--predict` that block
  is skipped entirely (the git-ignore check still runs, read-only).
- Tests:
  - `--predict --with-continia` with the fake ops makes 0 publishes, and the Continia reads happen;
  - `--predict` makes 0 config or launch writes (the writer is injected or counted);
  - a refusal in a fixture step means the Continia apps are not published in the act pass either.

### F6. Two act-pass failures print their remedy (r2 §3)

1. **A 422 "newer version ... already installed"** from `publishBytes`, which happens when an earlier removal left
   R605's installed-version record and row 1 said `publish`. The error is parsed with `parseVersionConflict`
   (`packages/runner/src/app-version.ts`, already tested) and printed as
   `<name>: BC holds an installed-version record at <v> (R605); publish a newer build: bc-republish.ts republish --mint <fixture>`.
   Test: a fake publish that throws that 422 text gives a message with R605, the version and the `--mint` line.
2. **A test app refused by BC after its target was kept as a minted build.** The old minted target may lack a
   procedure the new test app calls. The error gets the line
   `the target <name> is a kept minted build <v>; run the target's gate, or bc-republish.ts republish --mint <target>, then re-run setup`.
   Test: a fake that refuses the dependent's publish after a `keep` on its target gives that line.

Both fail in the safe direction: in case 1 the app was absent already, and in case 2 the old build stays installed.

### Wording (from the r2 review's "checked and holds")

r2's "the path `itest:testapp` steps 6 and 7 already run (through altool, same endpoint)" stays as written.
The client is NOT the same: `itest:testapp` publishes through `altool publishapp --schemaupdatemode ForceSync`,
and this plan publishes through a direct POST to `dev/apps` (`publishBytes`, `SchemaUpdateMode=forcesync`). Live
step 4 is therefore the measurement of the direct path, and its STOP clause stays.

## Cost

r2's estimate plus about 6 tests (F2, F4, F5 x3, F6 x2) and the moved `controlAction`. Still about half a day of
code and tests.
