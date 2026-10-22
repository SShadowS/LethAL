# R-631 plan, round 3

r2 (`/coord/reviews/R-631-plan/plan.r2.md`) stands, except for the four changes below. They answer
`/coord/reviews/R-631-plan/adversary-r2.md`.

## A. The prune set only EXCUSES links. It never drops real files.
- The constant is renamed `LINK_EXCUSED_DIRS = ["node_modules", ".git"]`. Names are compared
  case-insensitively (`name.toLowerCase()`), so `Node_Modules` matches on Windows.
- Inside such a folder the walk still lists every REAL file and real subfolder, exactly as today.
  A link found inside it, at any depth, is not refused; it goes to `skippedLinks`, is never
  descended, and is never yielded.
- There is no behaviour change for real files and no quiet shrink against what alc compiles. A real
  `.al` file under `node_modules` is mutated, hashed and discovered exactly as it is today.
- `WalkOptions.prune` from r2 is removed. The excuse is part of the `"refuse"` policy.
- Tests, each red-checked:
  - A link in `node_modules/.bin` and one in `.GIT/hooks` are excused. No throw, the link is listed
    in `skippedLinks`, and no path under its target is yielded.
  - A real `node_modules/pkg/X.al` is still yielded by `targetAlFiles` and `discoverTests`, as today.
    Red check: drop real files under excused folders, and this test goes red.
  - `Node_Modules` with an uppercase N is excused. Red check: compare case-sensitively, and this test
    goes red.

## B. A link that appears mid-run is drift, not the new error
- `watchProjectInputs`' inner scan runs with the `"skip"` policy, not `"refuse"`.
- In `check()`, every skipped link that is not excused becomes an ordinary change string,
  `added link <rel>`. It goes into `changes`, so the existing `ProjectChangedDuringRunError` path
  handles it unchanged.
- The up-front refusal still runs at session start. A link present before the run never reaches
  `check()`.
- Test: start the watch on a clean project, then create a linked folder (and, in a second case, a
  linked `.al` file). `check()` must throw `ProjectChangedDuringRunError` naming `added link <rel>`,
  and must NOT throw `ProjectSymlinkRefusedError`. Red check: remove the `added link` push, and
  `check()` passes silently.

## Note on r2's test (i)
`testAppHashFor` already catches errors and returns `undefined`, so a throw inside it cannot show
the refusal. Test (i) instead targets the up-front refusal: `runSession` with a linked helper in
`testDir`, and the compile counter at 0, throws `ProjectSymlinkRefusedError`. Test (ii), the forced
skip, still targets `testAppHashFor` and the v3 proof directly.

## Windows, stated plainly
- **Tested on the Windows CI job:** junctions, through the direct `lstat` assertion and the call
  counter.
- **Assumed, not tested:** a true Windows directory symlink (`mklink /D`, as opposed to a junction).
  Making one needs Developer Mode or admin rights, which CI does not promise. We assume Bun's `lstat`
  reports it as `isSymbolicLink()`, as Node does. Nothing in this plan measures that.
