# R-668 plan r2: plan r1 plus the deep review's three changes

Base: `/coord/handoff/R-668/plan.r1.md`. Review: `/coord/reviews/R-668-plan/adversary-r1.md` (CHANGES, no false-kill
door). Class: FULL (owner ruling). Gates: the v3 legs, itest:alrunner, and itest:bcdev on bc1 (leased only when it
is free).

## The fix

1. **By name.** `isProjectResource` also excludes file names matching `/^lethal\.config(\.[^/\\]+)?\.json$/i`, at
   any depth. That covers the batch copy and `source-drift.ts`.
2. **By identity (r2: replaces the path-only match).** When a run has a `--config` file, `stat` it once. Any walked
   project entry with the same `dev` and `ino` is dropped from the batch copy, whatever its name, case or path
   (symlinked dir, hard link). The config path also joins `runOutputPaths`, so the drift check ignores it.
3. **Warning (r2).** When any of the app's `resourceFolders` covers a file that rule 1 or 2 dropped, print one
   warning naming the file:
   - LethAL left it out of its batch;
   - a test that reads it as a resource fails at the baseline;
   - the user's own build still ships it, so take it out of `resourceFolders`.
   No refusal.
4. **The R668 note (r2)** names what stays behind from earlier runs, and the advice:
   - the latest `installed_bundles` row per group;
   - SQLite free pages after a prune;
   - the resident app on BC until the next publish;
   - scratch dirs from failed or killed runs.
   Advice: rotate the password, re-run once, then `VACUUM` the store. No migration.

## Tests (each red in each direction)

- **Name rule:** these are excluded:
  - `lethal.config.json`
  - `lethal.config.bc1.json`
  - `LETHAL.CONFIG.JSON`
  - a nested `sub/lethal.config.json`
  These near-misses are still copied:
  - `lethal.config.json.bak`
  - `my-lethal.config.json`
  - `lethal.configuration.json`
  - an `.xlf`
- **Identity rule:** a `--config` passed under another name inside the project, in another case, through a
  symlinked dir, and as a hard link: each one is excluded. A different file with the same content is still copied.
- **Drift:** a changed `--config` file of another name inside the project is not a project change. A changed real
  resource still is.
- **Warning:** printed when `resourceFolders` covers a dropped file, and not printed otherwise.
- **Pin:** dot-files stay out, as today.
- **End to end with alc,** offline with a dummy marker: with `resourceFolders: ["."]`, the batch `.app` holds no
  `lethal.config*` entry. Without the fix, it does.

## Live

- **Gates:** `itest:alrunner-v3` on all legs and `itest:alrunner`, through the chain driver, on the final head.
  `itest:bcdev` on bc1 under a lease, `LETHAL_ITEST_CONFIG=lethal.config.bc1.json`.
- **Expected:** every per-mutant verdict is unchanged, because no fixture has `resourceFolders`.
- **The pre-commitment** is committed to master before any live run.
