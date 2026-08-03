# DO live campaign — committed records (2026-08-03)

Per rung, committed BEFORE the next rung starts:

- `rung<N>.precommit.md` — the expected result, written before the run.
- `rung<N>.report.json` — the run's `--out` report, archived from OUTSIDE the worktree.
- `rung<N>.baseline.json` — run 1's per-mutant verdicts, semantic-identity keyed.
- `manifest.md` — pinned worktree commit, resolved selector ids, alc version, flag set,
  environment id.

The 2026-07-28 DO anchor is unusable because none of this was kept: only aggregates survived, in
prose. `git worktree remove` would have deleted the rest of it here too.
