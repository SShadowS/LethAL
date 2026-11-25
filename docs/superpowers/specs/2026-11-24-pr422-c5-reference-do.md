# PR-422 pre-commitment: c5, the next full-DO reference run (edge-e5176a9fd, master with PR-396, PR-408/419, PR-411)

Coord PR-422 (lethal-preproc, 2026-11-24), on the orchestrator's word. Written and committed before the run. The kit is in
`/coord/handoff/PR-422/`:
- `arm.sh` (PR-379's, copied);
- `v5.json`;
- `compare-c5.py`, with its self-tests `selftest-c4.txt` and `selftest-plant.txt`;
- `restarts.py` (PR-409's, taking the events file), with c4's counts `restarts-c4.txt`.

## The run
- **When:** on the orchestrator's go, after PR-410 lands. If PR-410 is not in the head by then, claim 4 drops.
- **c4's settings** (PR-379's `arm.sh`):
  - `ciSessionKind` client and `--ci-session-kind client`, companies CRONUS International Ltd.;
  - 5 of 8 lanes, CPUs 0-11, `LETHAL_V3_PACK_ENTRIES=256`, every other `LETHAL_*` unset;
  - the triage baseline first, a fresh store and a fresh `cacheDir`.
  - `v5.json` is c4's `v4.json` with only `cacheDir` and the binary's `path` changed (diffed).
- **The binary:** al-runner edge-e5176a9fd, sha256 `9b0e90bd…`, version `al-runner 3.0.0-alpha.15+edge.20261124 (e5176a9fd)`.
  It is `current` now. It is checked before and after, by the run's version line, and in every serve daemon's
  `/proc/<pid>/exe` (`exe.tsv`).
- **The head:** origin/master of the moment, in `HEAD.txt`. It **must contain** the merges of PR-365, PR-381, PR-396,
  PR-408, PR-411 and PR-419, or the run does not start. PR-410's merge is logged.
- **The box:** `box.tsv` samples CPUs 12-21 per core, as for c4. server1 is shared (the owner's rule of 2026-11-23), so there
  is no quiet window, and speed against c4 is indicative only.

## What changed since c4 (main-bf3a3e863, head b1a0e6717)
- **The build: main-bf3a3e863 → edge-e5176a9fd.** That is 950 upstream commits (41 first-parent merges).
  - PR-415 re-ran every refusal family on both builds: 56 of 3,418 cells moved, all in the SetRange/SetFilter conversion area
    (53 fieldref-convert, 1 t10, 2 t12). The other 23 families did not move.
  - That is the guide, not a bound: DO reaches code the families do not.
- **PR-396:** a v3 kill whose failure carries the #8721 stale-buffer text is withheld as `error` with a named note.
- **PR-408 and PR-419:** keep rows for edge's reworded setrange-other-type-convert refusals (Code 'GL00000000', Text '=18' and
  '1=18').
- **PR-411:** four keep rows (the two placeholder Pdf reads, Evaluate-Boolean GlobalLanguage 1044, the RunRequestPage
  parameters string).
- **PR-410,** if in: the carry walk skips a walk its first kept codeunit's flagged first pass dooms.
- Other merges since b1a0e6717 that touch the v3 path are listed in the result from `git log`, each with its own claim if it
  has one.

## Predictions against c4, by name (joined on the full site key; `compare-c5.py`)
1. **Every verdict or killingTest move has a named cause, or it is a BLOCK.** The classes, tried in this order:
   - `PR-396 #8721 guard`: M13065 and M13625.
   - `conversion area (PR-415)`: c4's or c5's row texts (`failureNote`, `killingTestFailure`) hold a SetRange/SetFilter
     conversion text (the pattern is in `compare-c5.py`).
   - `c4 refusal gone on edge: <text>`: c4 read `error` on a refusal whose normalised text appears in no c5 row. Edge
     measured or reworded it.
   - `new refusal on edge: <text>`: c5 reads `error` on a refusal whose text appears in no c4 row.
   - Anything else is `UNEXPLAINED`: a BLOCK, listed by mutant. It is analysed one by one, and is explained only by a named
     upstream commit and the row texts that show it.
   - **Every gained kill** (c5 `killed` where c4 was not) is listed with its class and killing test. A gained kill in
     `c4 refusal gone on edge` is the false-kill direction: listed for a BC check, never quoted as confirmed.
   - Every class's moves are reported with counts and texts.
2. **PR-396:** M13065 and M13625 read `error` with the #8721 note (c4: both `killed`). Any other verdict is a BLOCK.
3. **The keep rows of PR-408, PR-411 and PR-419:** 0 `serve-daemon-closed` events on their seven texts.
   - c4 had 24 on PR-411's four (10 Pdf read, 8 Evaluate, 6 RunRequestPage). c4's build never gave PR-408/419's wording.
   - These rows move no verdict: a move in a mutant they touch needs another class.
4. **PR-410, if in:**
   - A walk the skip predicts is not sent. Its mutant's note names the skip ("skipped before request 1: …").
   - Its verdict equals c4's, which was `survived` for all 129 c4 walks, unless another class explains it.
   - **The count of skipped walks is reported, not pinned:** PR-410's amendment 1 leaves open whether edge flags the same DO
     tests c4's build did.
   - A skipped mutant that c4's walk KILLED is a BLOCK (c4 had none).
5. **The not-run caveat and the headline (PR-381), as c4's amendment 2 checked them:**
   - c5's `notRunAtBaseline` against c4's 237, by name. Every name in one list and not the other is listed and explained by
     the test's refusal text (a refusal gone or new on edge); an unexplained one is a BLOCK.
   - `validity.caveats` holds `survivors-beside-unrun-tests`. `survivorsBesideUnrunTests.notRunTests` equals c5's list,
     and `survivors` equals c5's survivor rows.
   - The line after `score:` in `stdout.txt` opens literally with `<survivors> survivors, all in a run with <n> tests v3 did
     not run at baseline`, with c5's own counts.
6. **Cost (R1183): comparable, reported against c4 and not judged.**
   - The comparable figures: daemon starts and warm-up seconds by cause (`restarts.py` on both runs). c4: after-unkept-row
     115 (6,407 s), after-refusal 56 (2,244 s), after-timeout 20 (881 s), first 5 (301 s), lazy-prove 301 (1,526 s);
     195 closes.
   - **Expected, as a direction only:**
     - after-refusal falls by at least PR-411's 24, less any new refusal text edge closes on (named);
     - after-unkept-row falls by the walks PR-410 skips, if it is in.
   - Wall, phases and ms per test are reported as indicative only (a shared server).
7. **The binary:** every daemon's exe is the pinned edge binary.

## Order after the run
`compare-c5.py c5` (rc 0 OK, 1 BLOCK), then `restarts.py c5/events.ndjson`, side by side with `restarts-c4.txt`. A BLOCK is a
finding for the orchestrator, as in c4.

## The compare's self-test (done before this commit)
- **c4 against itself** (`selftest-c4.txt`):
  - 0 moves; claim 5 holds (237 names, the headline line with 9949 and 237);
  - claim 2 blocks: c4 has both mutants `killed`;
  - claim 3 blocks with exactly c4's 24 closes on PR-411's texts, the positive control for the close count.
- **One planted verdict move with no texts** (`selftest-plant.txt`, M0268): exactly 1 `UNEXPLAINED` move, listed, and a
  BLOCK.
- `restarts.py` on c4 reproduces PR-409's figures (`restarts-c4.txt`).

## What it becomes
- If 1-7 hold, c5 is the verdict reference on edge-e5176a9fd with these rows, and its cost figures are the next comparison
  point.
- Otherwise the BLOCKs are the finding, and the orchestrator decides.
