# DO live campaign — committed records (2026-08-03)

Per rung, committed BEFORE the next rung starts:

- `rung<N>.precommit.md` — the expected result, written before the run.
- `rung<N>.anchors.json` — the machine half of the pre-commitment (mutant cardinality, baseline
  test count, covered procedure ranges), read by `scripts/campaign/anchors.ts`. Committed BEFORE
  the run it gates.
- `rung<N>.report.json` — the run's `--out` report, archived from OUTSIDE the worktree. Written
  only after it has matched `rung<N>.baseline.json`, so the two always describe the same run; a
  report that did NOT match is archived as `rung<N>.mismatch[-n].report.json` instead.
- `rung<N>.baseline.json` — run 1's per-mutant verdicts, semantic-identity keyed.
- `manifest.md` — pinned worktree commit, **LethAL's own commit** (`git rev-parse HEAD` in this
  repo at run time), resolved selector ids, alc version, flag set, environment id. For rung 3 also
  record **the commit the standalone binary was built from, plus its sha256 and build timestamp**:
  rungs 0–2 run from source and rung 3 runs `build/lethal-*-windows-x64.exe`, whose filename
  carries only the package version (`0.1.0-alpha.1`) and therefore cannot distinguish a fresh
  build from a months-stale one. The 2026-07-27 binary lacked two operators the rung-1 set depends
  on and nothing in its name said so.

The 2026-07-28 DO anchor is unusable because none of this was kept: only aggregates survived, in
prose. `git worktree remove` would have deleted the rest of it here too.
