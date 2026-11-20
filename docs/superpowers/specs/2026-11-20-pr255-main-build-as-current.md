# PR-255 pre-commitment: gate a locally built upstream MAIN commit as `current`

Lane lethal-bugs, coord PR-255, 2026-11-20. Owner's ruling (q-20261120T084258-a6351212): "gate a recent upstream main build as
current yourself; no upstream request for an edge cut. Use your gate with its known-loss rules (O1 / #8239 and the by-value
SetFilter set-aside, both rule-3-correct on main), and take stop-after-first-failure (#8484, field stopAfterFirstFailure) with it."
Committed before any code. Part 2 (the expected leg changes) is an amendment written from the private gate's receipts, before the
real gate runs.

## Why
Upstream's `edge` tag has not moved since 4ebfe7913 (2026-11-15). Main is 660 commits ahead, and #8484 (f7b156fb4, the
second-largest DO speed lever, R1146) reaches `current` only through a main build.

## The build
- **Upstream main commit:** 9835579c66843ef7442d449b18f395087ed106f6, the merge of train-261120k (#8559), 2026-11-20 08:51Z.
  - Upstream's push checks passed (corpus, merge push check). Tests run on each train's pull request.
  - It contains f7b156fb4 (#8484), f9116dc96 (the O1 partner-login refusal, #8239), b805a9561 (#8244) and d0155ce2e (#8166).
- **Built here** with upstream's own recipe, `cargo build --release --locked -p alrunner-cli`, plus
  `ALRUNNER_VERSION_SUFFIX=+main.20261120`.
  - It is a glibc build, as perf-combined was. Edge is musl, and the container has no musl target.
  - The version reads `al-runner 3.0.0-alpha.14+main.20261120 (9835579c6)`.
  - The clone and build are at /coord/handoff/PR-255/.

## The code path (part 1), the smallest one
`bun scripts/al-runner-v3-update.ts --main <binary>` gates ONE local binary of an upstream main commit through `gateOne`, as an
edge candidate is gated, with these differences:
1. **No download.** The binary is the local file, and its sha256 is taken once and checked at the gate (as `--edge-rejudge`'s
   custody check does).
2. **The version must read `+main.YYYYMMDD (<hex>)`.** Anything else (an edge, a release, a fork, no commit) is refused by name
   before any gate, and nothing is written.
3. **It moves `current` only FORWARD,** by the same `commitOrder` check as edge: behind or diverged means no move, "a person decides".
   It is deferred when `current` is in use (`inUse`), as edge is.
4. **Folder:** `<root>/main-<commit>/` (al-runner, sidecar, .gated, gate.log, receipt). **Ledger row:** id `main-<commit>`,
   `track: "main"`, a new track. It is the record of what `current` was, as `edge` is, never the manifest. `GatedBuildEntry`'s
   strict parse accepts "main" and nothing else new.
5. **Failure handling:** `failed/`, `held/` and infra counting work as for edge.
6. **Unchanged:** the daily run (no flag) and `--edge`, `--regate`, `--edge-rejudge`, `--root --local-candidate`. The daily run
   never builds or gates a main commit.
7. **After `current` is a main build,** the edge track sees edge 4ebfe7913 as behind and does nothing: `current` never moves
   back to edge.

## PR-235's run is safe
The move writes `<root>/main-<commit>/` and swaps the `current` link atomically. It never writes edge-4ebfe7913's folder or its
`.gated`. code's PR-235 runs that binary by its versioned path. A test asserts the old build's folder is byte-identical after a move.

## Tests (red first)
- **Daily and edge unchanged:** the existing al-runner-v3-update tests pass unchanged, and a run with no flag never gates a main
  build.
- **`--main` refusals:** an `+edge` version, a release version, and a version with no commit are each refused by name, with
  nothing written.
- **A pass:** it writes `main-<commit>/`, a ledger row `main-<commit>` with track `main`, and moves `current` forward. A
  behind/diverged commit is not moved. The old build's folder is unchanged.
- **The strict parse:** it accepts `track: "main"` and still refuses any other track.

## Order
1. Build.
2. Private gate (`--root /coord/handoff/PR-255/root --local-candidate`, receipts only) to measure every leg.
3. Amendment: every expected leg change and the hand pin this exact binary needs (O1's partnerLoginRefusal, PR-233's rule, and any
   other moved reading, each named). An unexpected one means stop and report.
4. The code above.
5. Review, VERIFY, CI, merge.
6. `--main` with the real root.
7. Report.

Any difference the amendment did not pre-commit is a BLOCK, and `current` does not move.

## Amendment 1 (2026-11-20 ~10:05Z): the expected leg changes, from the private gate; before the real gate
- **The private gate:** `--root /coord/handoff/PR-255/root --local-candidate`, binary sha256
  b91d49d7b6af8ea9ed7bd429f14312cde19025c0676a1278822f37dfaca03d24, judged at master 4eca73661. Receipts:
  /coord/handoff/PR-255/root/private/local-b91d49d7b6af@4eca73661...-bf82e0a9-.../.
- **The outcome was HELD on O1 alone. Every other leg passed:** C, S1, S1E, DB, DBI, DBM, S3, N1, N1E, N1S, ISO, X, L1, Y-A, Y-B,
  MO, WR, MOE, WRE, RC, K, D1, D1c, T.
- **O1:** "held for PR-233's O1 pin: 16 row-insert tests refused after the partner login (al-runner f9116dc96, a known coverage
  loss on #8239)". This is exactly PR-233's predicted shape, as with perf-combined.
- **Leg C (passed), one note:** `al-runner-v3-serve-keep-reason-moved: serve-keep-reasons: diverged (measured
  setfilter-boolean-language-words: MOVED pass)`. The probe that a keep-list entry stood for now PASSES: upstream runs it, so the
  entry matches nothing. That is a move toward running, not a verdict. It is recorded, and leg C still passes.
- **The hand pin this exact binary gets:** `main-9835579c6`, version `al-runner 3.0.0-alpha.14+main.20261120 (9835579c6)`, that
  sha256.
  - Its readings are the live root edge-d72d3197d's (`READINGS_8078BCF49`, `O1_8078BCF49` with `cdoApps: 18`), plus ONLY
    `o1.partnerLoginRefusal` with PR-233's text. This is the same shape as the removed perf-combined pin.
  - It is labelled "upstream main, gated as current (owner, q-20261120T084258-a6351212)". Unlike perf-combined, it is meant to
    become `current`.
- **Prediction for the real `--main` gate:** a PASS with `pinApplied` `main-9835579c6`. Every leg is as in the private run, and O1
  passes on the pin. Any other difference is a BLOCK.
- **The by-value SetFilter refusal** shows in no gate leg. On DO it is handled by PR-250's cut and the PR-217 set-aside rule
  (owner: rule-3-correct on main).
- **Timing of the move:** current's `.gated` (lethalCommit c7c66255f) predates this branch's change to `al-runner-v3-pins.ts`, a
  gate-leg file. So `--main` first re-gates `current`, which WRITES `edge-4ebfe7913-4ebfe7913/.gated`, the folder code's PR-235 run
  uses. The real `--main` therefore runs only after PR-235 has ended (orchestrator's rule). Until then: review, VERIFY, CI and
  the merge.
- **After `current` moves:** the daily update's edge track sees edge 4ebfe7913 as behind and does nothing. R1146's DO re-measure
  (and R1098, R1092 and R1048, per the PR-240 sweep note) becomes due on the new `current`.

## Amendment 2 (2026-11-20 ~15:35Z): the target is upstream main ccd0f823d, not 9835579c6 (orchestrator: move `current` once)
- **Why:** upstream main now carries #8365, kept sources (the takeover merged in f8a64df3b, train-261120q #8572). On 9835579c6
  each request re-read its sources and re-ran test discovery, about 1.6 s per request (PR-255's fixed-cost driver). So
  `current` moves ONCE, to the newest main with it. **9835579c6 never becomes `current`.** Its hand pin `main-9835579c6` and its
  private PASS are SUPERSEDED: the pin is replaced, not kept beside the new one.
- **The commit:** ccd0f823d918524d88f295c4822d99219430d6fe, the merge of train-261120s (#8579), 2026-11-20 13:58Z.
  - Upstream's push checks passed (check, corpus, merge push check).
  - It contains f8a64df3b (#8365), f7b156fb4 (#8484) and f9116dc96 (O1).
  - Built here with the same recipe: `al-runner 3.0.0-alpha.14+main.20261120 (ccd0f823d)`, sha256
    bc3595c4e2ff9c2ae63c7c02e1133155005414464f59ecd22dca9d4ab281ad7c.
- **Its private gate** (`--root /coord/handoff/PR-255/root --local-candidate`, judged at master f7db4a6c; receipts
  root/private/local-bc3595c4e2ff@f7db4a6c...-56b734c1-.../): HELD on O1 alone, and every other leg passed.
  - O1: the same 16 row-insert refusals after the partner login (f9116dc96, #8239).
  - Leg C: the same note as 9835579c6 (`setfilter-boolean-language-words` MOVED to pass; a keep entry now inert).
  - So it reads exactly as amendment 1 predicted for 9835579c6.
- **The hand pin:** `main-ccd0f823d`, version `al-runner 3.0.0-alpha.14+main.20261120 (ccd0f823d)`, that sha256.
  - It REPLACES `main-9835579c6`, with the same readings: the root edge-d72d3197d's plus ONLY `o1.partnerLoginRefusal`.
  - Its readings digest is therefore the same, d60c889b..., because the digest leaves out id, version and sha256.
- **Predictions:**
  - the private gate from master after the pin merges: PASS, applied pin `main-ccd0f823d`;
  - the real `--main`: re-gates current, then PASS with `pinApplied` `main-ccd0f823d`, a ledger row `main-ccd0f823d` on track
    `main`, and `current` moved FORWARD to `<root>/main-ccd0f823d/`.
  - Any other difference is a BLOCK.
- **Fixed cost:** re-measured on ccd0f823d against 9835579c6 with the raw driver (interleaved, the same cores). Reported in the
  result; it is not a gate figure.
