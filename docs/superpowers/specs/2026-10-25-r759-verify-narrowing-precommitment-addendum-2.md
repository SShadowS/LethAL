# R759 pre-commitment, addendum 2 (lane bugs, R-759b, 2026-10-25): attempt 1 on bc3 was void (harness bug); re-run on bc1 with the original build

Committed before the re-run. The pre-commitment (master d550809b) and addendum 1 (master 54511d86) are not edited.

## Attempt 1 (bc3, 16:07Z, head 5151f1fa): void, by a harness bug, not a product result
- The proof script built the verify `--db` path as `<worktree>/<path>` while the probe driver now reports an absolute
  path, giving `/work/lethal-wt/r759//work/lethal-wt/r759/.kraken-local/...`. Both V1 and V0 therefore refused with
  `unknown-artifact` ("there is no results database at ..."), so neither reached the code under test. P8/P9 were not
  tested. Steps 1-3 and cleanup ran; their logged exit codes are not trustworthy either (the script read `$?` after a
  `$(date)` substitution). Evidence kept: `/coord/handoff/R-759b/proof.attempt1-harness-bug/`.
- Attempt 1 published id set 1 on bc3 and cleaned it up; BC keeps installed-version records until a restart (R605), so
  set 1 is no longer fresh on bc3.
- Fixed in the script (not in the repo): the path is used as given when absolute (refuses if the store is missing), and
  each exit code is saved before it is printed.

## Re-run
- Server: bc1 (back in use since ~13:30Z; set 1 was never published there).
- Probe build: the ORIGINAL bc1 build of the pre-commitment, restored byte for byte from the builder's backup, with the
  pre-committed sha256s: L1 `c24fb61a8a85cb988e2279328824df12fbd21914cf669e4b641526a7e796c8b7`, L2
  `e0f9c725c7bf04e15c04a743237e107edb57a082d035b8ff9a077c1f65df62ee`, P
  `d86ca85da6aa9010b9991561e35895852a895d44a24a724520c3101ce68dd09a`, Q
  `3656bbcd178a3a940e9a3cfa9963246dcd231b95c45908181a923ff7df277357`. Addendum 1's bc3 shas no longer apply.
- Predictions P1-P10 stand exactly as written in the pre-commitment (with R745 addendum 1's corrected P6 caveat set),
  including step 1's read-back (only 1.0.0.1 rows of set 1 on bc1, else stop and mint a set 3 under a further addendum).
