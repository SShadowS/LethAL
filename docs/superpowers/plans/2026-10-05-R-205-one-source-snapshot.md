# R-205 plan r4

Ruled pin-and-warn (edit never built; warning names every changed file; untouched tree silent).
C02-06 pins parse and staging. Left: ranges, coverage guard, `targetOf`, dry run read live; a
failed snapshot read falls back to live. Engine: `git diff --no-index` (no diff dependency).

## Fix
1. Snapshot once, first. `runFromCli` calls `readTargetSource` before `resolveLineRanges`
   (cli.ts:3729) and `prepareAlRunnerSession` (:3818); the `--dry-run` branch (:5610) too. The map
   goes to every reader below and to `runSession` as `SessionConfig.source`. Without it,
   `runSession` reads its own at the very start, BEFORE `testAppIdentity` (orchestrator.ts:4848).
2. Base blobs by id. `git rev-parse --show-prefix`, then ONE `git ls-tree -r -z --full-tree <mb>`:
   keep `.al` blobs under the prefix, key = path minus prefix, keep the object id. ONE
   `git cat-file --batch` fed the ids, read as bytes through `Bun.spawn` (`SpawnFn` decodes to
   strings). A `missing` reply, a short read or a non-zero exit throws naming the path and id.
3. Binary/UTF-16, checked by us, not git's prefix heuristic: before diffing, every snapshot `.al`
   whose bytes differ from its base blob (or has no base blob) is scanned in full; any NUL byte or
   a UTF-16 BOM (FF FE / FE FF) throws the existing `binaryAlMessage(path)`. UTF-8 BOM is kept.
4. Diff. Base blobs to `<tmp>/base/<key>`, snapshot `.al` bytes to `<tmp>/snap/<key>`, raw. Run in
   `<tmp>` with `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` = a nonexistent file (as
   tests/helpers/git-repo.ts does): `-c core.quotePath=false -c core.autocrlf=false diff --no-index
   --no-renames` plus today's flags minus `--find-renames`, operands `base snap`. Exit 0 and 1 are
   success; anything else throws with stderr. No repo, so no attributes, filters, index, worktree.
5. Paths. `parseUnifiedDiffAdded` strips `b/`, leaving `snap/<key>`; a new step requires the
   `snap/` prefix (else throws) and maps it to the key. Spaces: git's trailing tab is trimmed
   (existing). A quoted `.al` path still throws by name (existing).
6. Semantics, one rule: a snapshot file is diffed against the SAME path at base. With
   `--no-renames`, a rename is a delete plus an add, so the new path is selected whole; untracked,
   ignored and new files the same way, with no special case. A deletion adds nothing. This
   over-selects on renames, the safe direction for `--changed-since`.
7. Refusals kept, now on snapshot paths. Submodule: gitlinks (mode 160000) from the base
   `ls-tree` plus the index (`ls-files -s`, as today); refuse when a snapshot key lies under one.
   Nested repo: `ls-files --others --exclude-standard` directory entries (as today); refuse when a
   snapshot key lies under one. Messages unchanged. The assume-unchanged/skip-worktree refusal is
   deleted: the index is no longer read for content.
8. `untrackedFiles` keeps its meaning (untracked, not ignored): same `ls-files --others` output,
   `.al` entries that are snapshot keys. Ignored `.al` are selected whole, not listed there.
9. Coverage guard: `alRunnerCoverageSupport(projectDir, snapshot)` parses snapshot `.al` keys.
10. With a snapshot, a missing `app.json` key means absent, never "read disk": `appJsonSymbols`
   returns `[]`; `targetOf(projectDir, snapshot?)` throws its `DependencyUnreadableError`.
11. The first read throws `SourceSnapshotUnreadableError extends Error`, naming path and cause;
   an app.json ENOENT alone is allowed. The last-batch re-read stays diagnostic: unreadable ->
   warn and withhold the hash, never abort.
12. `source-changed-during-run` names added, removed, changed paths. Drop line-filter.ts:200's
   ponytail. R205.md (pin-and-warn; renames whole; ignored `.al` selected) and CHANGELOG (same,
   plus index-flag refusal removed).

Ripple: `SessionConfig.source` (wiring-completeness); optional snapshot param on six helpers
(fixes 1, 9, 10); `SourceSnapshotUnreadableError`. No keys, schema, events, report or Caveat change.

Existing tests that change (changed-since-git.test.ts): "renames, spaces, non-ASCII..." gets
`src/My New.al` 1..4 (was 4..4); low-similarity rename unchanged; index-flag refusal tests become
"edited bytes give the edit's range".

## Tests, one targeted red-check per mechanism (real git, exact ranges and names)
- OID selection: subfolder project, root-level `src/A.al` decoy with different text. Revert: look
  up by `<mb>:<key>` (root path) -> decoy's diff, red.
- Binary transport: base blob with invalid UTF-8 and a BOM, one later line edited. Revert: read
  blobs through `SpawnFn` text -> spurious ranges, red.
- BOM: edit line 3 of a BOM file; exactly `3..3`, no `1..1`. Same revert. Binary scan: changed file with a NUL at byte 20000, and a changed UTF-16 file -> named refusal.
  Revert: drop the scan -> late NUL yields text ranges, red.
- `snap/` mapping (space, non-ASCII names) and exit 1 (any edit). Reverts: skip the mapping;
  accept only exit 0. Each red.
- `--no-renames`: an identical-content rename, and the outer `Old.al` deleted beside an identical
  `sub/X.al` -> new path whole. Revert: drop the flag -> 0 ranges, red.
- Refusals: submodule and nested repo holding a snapshot `.al` -> named refusal; neither holding
  one -> no refusal. Revert each check -> red.
- Missing blob object (`missing` reply) -> named throw. Revert: treat as absent -> red.
- A->B->A around the diff: A's ranges. Revert: the live commit-to-worktree diff.
- Pin-and-warn, edit injected in `validateSelectorIdsForProject`: added, removed, edited `.al`,
  app.json, symbols; build holds snapshot bytes; warning names exactly those. Revert: drop
  `SessionConfig.source`. Untouched control: no warning. Revert: always warn.
- Coverage guard multi->single and single->multi; dry run edited after the snapshot; one-shot
  EACCES refusal + readable control; last re-read failure warns; app.json-less snapshot never
  reads disk. Each reverted to its disk read or fallback.

Out of scope: al-runner test sources, resources, caches, verify, anchors. Points 2, 3 filed, open.

## Changes since r3
1. `--no-renames`: renames, untracked and new files all selected whole by one rule (fix 4, 6).
2. Submodule and nested-repo refusals kept, checked against snapshot keys; missing blob throws (2, 7).
3. Own full scan for NUL and UTF-16 BOM before diffing (fix 3).
4. One red-check per mechanism; BOM test edits line 3 (Tests).
5. `untrackedFiles` still from `ls-files --others`, filtered to snapshot keys (fix 8).

## Build notes from sol r4 (SOUND as a plan, /coord/reviews/R-205-plan/sol-plan-r4.md)
- The rename red-check mutates `--no-renames` to explicit `--find-renames`. The `Old.al`/`sub/X.al` fixture uses an ordinary directory.
- Wording: "selected whole" applies to a path absent at base. The kept repository-boundary refusals say the inner repository's baseline is unavailable.
- Implementation:
  - prefix matching must respect path separators;
  - create both diff operand directories even when empty;
  - keep `isEnumeratedAl` filtering after path mapping;
  - check each batch object's type and size;
  - drain the pipes concurrently.
  - Test that a binary base turned text gets a named refusal.
