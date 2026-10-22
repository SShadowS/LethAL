# R-612 live pre-commitment, addendum 1

Committed on 2026-10-22 by lethal-code, before anything below ran. It amends the R-612 live pre-commitment
(`docs/superpowers/specs/2026-10-22-r612-live-precommitment.md`, master 8d9ae54b). Everything not restated stands, including the
fixture, the binary (alpha.2, sha256 `b23f8315…5d45`) and the read-outs.

## Why

1. **Leg C stopped on infrastructure, not on a fact:** `ENOENT scandir /work/lethal-wt/r612/fixtures/sandbox-tests/.alpackages`.
   The fresh worktree had no gitignored fixture symbols. `itest:alrunner-v3` does not prepare them; the update
   script does (`gatePreparation` in `scripts/al-runner-v3-update.ts`), and a manual leg C must do the same.
2. **Code changed after L-keep ran:** 592ec593 adds "time limit" (case-insensitive) to the tail words both tailed
   entries reject, so a timeout-caused cascade row closes the daemon (bugs' finding; red check R25 in `build.md`).
3. **The replay was impossible:** the first tap kept no raw daemon rows (`live/replay-time-limit.txt`), so "no row
   of L-keep is affected" cannot be shown mechanically. L-keep therefore re-runs.

## What is under test now

- **Product head:** `lethal/r612` at **592ec593**.
- **Tap 2:** `lethal/r612-tap2` at **ed485caa**, one commit on 592ec593, never merged, worktree
  `/work/lethal-wt/r612-tap2`. It carries the same one-line `run-fixture.ts` switch (`R612_SERVE_RULE=v3`) and
  the same `cached` tap, plus a capture of every daemon answer line to `<tag>.answers.ndjson`. Summary lines are
  kept as one-line markers `{"type":"summary-marker","daemon":<pid>}` (a summary carries the whole coverage
  document); every test row, the ready line and any `{"error":...}` line is kept verbatim. Smoke-tested with a fake
  `serve` script only: every line passed through to LethAL unchanged, the files were written as described, and
  with no `R586_SHIM_LOG` the plain `exec` path runs.

## L-keep2 (replaces L-keep)

Before it (in `/work/lethal-wt/r612-tap2`): `bun install --frozen-lockfile`, then `bun scripts/build-native-parser.ts`.

```
cd /work/lethal-wt/r612-tap2
R612_SERVE_RULE=v3 ALRUNNER_CACHE=/work/tools/al-runtime-rs/cache bun scripts/r586-probe/run-fixture.ts \
  --alrunner /work/tools/al-runner-v3/current/al-runner --out /coord/handoff/R-612/live \
  --leg server --tag keep2 --coverage al-runner \
  --project fixtures/sandbox-data --tests fixtures/sandbox-data-tests \
  --oracle /coord/handoff/R-612/live/close.report.json \
  > /coord/handoff/R-612/live/keep2.log 2>&1
```

- **Against L-close's existing report.** L-close is NOT re-run: it used the v2 rule, which neither 592ec593 nor
  any R-612 commit changes (pinned by T1, T6 (v2) and the untouched R517 tests).
- **Pre-committed figures (unchanged):**
  1. per mutant, L-keep2 equals L-close on all 406: verdict, killing test and coverage filter, all 406 texts
     verified (`keep2.log`: `differences=0 textVerified=406`);
  2. L-keep2 starts **EXACTLY 1** daemon (`grep -c '^serve' keep2.shim.tsv` = 1);
  3. `keep2.answers.ndjson` exists and holds one `summary-marker` per line of `keep2.cached.txt`;
  4. recorded, not predicted: requests answered (`wc -l < keep2.cached.txt`) and the `cached:true` count.
- The claim stays limited to what the fixture exercises: the Commit refusal (#5607) and the #5610 cascade
  wording after it.

## Leg C (replaces the earlier leg C run), on 592ec593

```
cd /work/lethal-wt/r612        # at 592ec593, clean
sha256sum /work/lethal/.kraken-local/fixture-symbols.tar
#   must print bdf460e292f005f1c02cc7b45e83ede1d5c5df280070dc97231f9b314d4f175e (FIXTURE_SYMBOLS_TAR_SHA256);
#   anything else is a STOP before any leg.
tar -xf /work/lethal/.kraken-local/fixture-symbols.tar -C /work/lethal-wt/r612
LETHAL_ITEST_ALRUNNER_V3=1 LETHAL_ITEST_V3_LEGS=C bun run itest:alrunner-v3 \
  > /coord/handoff/R-612/live/legC2.log 2>&1
```

- The tar writes only gitignored `.alpackages` folders, so the worktree stays clean.
- **Pass conditions, both required (unchanged):**
  1. `leg C: PASS` with 24 facts (15 contract `matches`, 8 defect `defect-present`, 1 warn);
  2. the line `C: serve-keep-reasons = matches`, explicitly. Any other reading is a STOP for this proof, although
     the gate itself would pass with a warning.
- The overall outcome of a C-only run is `infra-fail` (other legs not run) and is not read; no receipt, no `.gated`
  change.

## STOP rules (unchanged, now for L-keep2 and the new leg C)

- any per-mutant difference between L-keep2 and L-close, or fewer than 406 verified texts;
- L-keep2 starting more than 1 daemon (each extra start named from `keep2.answers.ndjson`: the answer before it and
  the row that closed it), or 0;
- `keep2.answers.ndjson` missing or not matching the summary count;
- the symbol tar's sha256 differing; leg C not `PASS`; a fact count other than 24; `serve-keep-reasons` anything
  but `matches`;
- a binary sha256 other than alpha.2's, or a dirty worktree other than the tap's own commit.

Each STOP is reported as found and never reinterpreted or retried into a pass. No leg is signal-stopped.

## Heavy jobs (unchanged)

L-keep2 and leg C are each a local al-runner job: at most 2 heavy jobs container-wide, counting this one. Before
each: `ps` shows at most 1 other al-runner / itest / corpus job, and `free -g` shows at least 10 GB available. One at
a time, L-keep2 then leg C, each in its own background job, logging as it runs. No BC server, no lease.
