# R586 / R705: pre-commitment r17 (a delta to r15 and r16): leg C's `refusal-row-shape` oracle is the test runner hub

Delta to `docs/superpowers/specs/2026-10-24-r586-alrunner-v3-precommitment-r15-alpha5.md` and
`...-r16-serve-keep.md`. Everything in r15 and r16 stands except what is named here. Commit this file alone, as
`docs/superpowers/specs/2026-10-24-r586-alrunner-v3-precommitment-r17-hub-oracle.md`, `[skip ci]`, from a scratch
origin/master worktree, before the next gate run.

## What changes

| | Before (r15 §Leg C) | After (r17) |
|---|---|---|
| Oracle for `refusal-row-shape` | `BC_HTTP_INTERNAL_TEXT`, bc1's web-service-path text ("...blocked by the runtime...") | `BC_HTTP_HUB_TEXT`, the test runner hub's text ("...the connecting endpoint violates security requirements...", `HttpRequest:Security`) |
| alpha.5's `HttpGet` row (the security text, plain fail, exit 1) | `unlike-bc`: leg C `gate-fail` | the matching reading (code: verdict `gone`, the defect vocabulary for "v3 behaves as BC"): leg C `held`, like the other `gone` defect facts |
| A build that writes the web-service text | `gone` (r15 "the other exit") | `unlike-bc`, as any text but the hub's |
| alpha.2's refusal row (exit 7, notRun, the prefix) | `defect-present` | `defect-present` (unchanged) |

Reason: the owner ruling of 2026-10-24 ([[R712]]): the oracle for HTTP-in-test behaviour is the test runner hub path,
which is what a developer and their CI see. Evidence: R706, `docs/measurements/r706/` (bc1, BC 28.4.53241.56590,
driver 766d93b6, 2026-10-24 08:37Z). The hub reads the security text on both probe tests in both runs; the
web-service path (runner 130450, how bcdev runs tests) reads the "blocked by the runtime" text on both, in both runs.
That is outcome A of the R706 pre-commitment. r15's condition (a) is met and its condition (c) is ruled. r15's
requirement that the bcdev harness question be decided is filed as [[R713]] (bcdev documents, warns or uses the hub:
open); it does not gate this delta, because the ruling names the hub as the oracle.

r17 supersedes in r15 §"Leg C: `refusal-row-shape = unlike-bc` (#5700)": the "default ruling" paragraph and its three
reasons, "What would change the ruling" (a) and (c), and "The other exit". Its rule 1 ("the pinned text is the
oracle") now reads: the pinned text is the HUB text. Also superseded: r15 "C. If the #5700 ruling is lifted later (not
predicted to happen)" and the statement "Until one of these, the update gate reads `gate-fail` on alpha.5 from leg C".
The statement in r15 that "the update gate reads gate-fail on alpha.5" is replaced by the `held` prediction below.

Outcome A of the R706 pre-commitment is read by substance: the committed classifier said "Unsettled" (row 1), because
92911's own `MEASURED [<text>] [<code>]` wrapper made its first line read OTHER. The substance (hub SECURITY,
web-service BLOCKED, every run) is outcome A, and the owner ruling (R712) ratifies that reading.

**Departure from r15's lift path (a) and from test R-a4.** r15 (a) said the pin "would add the security text as a
second `gone` text". r17 REPLACES instead of adding: `BC_HTTP_HUB_TEXT` is the one `gone` text. R-a4 now reads: the hub
text reads `gone`; the web-service text and any other text read `unlike-bc`.

Code (commit 9c19550b on lethal/r705): `BC_HTTP_HUB_TEXT` added; `refusalRowShape` compares `h.message` to it;
`BC_HTTP_INTERNAL_TEXT` is kept (r639, `r639-bc-readings.test.ts` still binds it to `bc1-probe.json`). Tests also bind
`BC_HTTP_HUB_TEXT` to `docs/measurements/r706/readings.json` (run 1, test 92910, hub `raw`, first line) and to the
SECURITY constant of `scripts/r706-client-probe/classify.ts`. No other fact's meaning changes. The same commit also
carries r16's `serve-keep-reasons` no-message change (a plain fail with no message now reads `diverged`): a warn
fact, no outcome change.

## r15 table B, as amended by r17

r17 supersedes these rows of r15 table B ("The next daily run at the new `.gated` commit"), and only these:
- the heading "Predicted overall: `gate-fail`, from leg C alone (`refusal-row-shape = unlike-bc`)" becomes
  "Predicted overall: `held`";
- the leg C row becomes: "`held`: 6 `gone` held lines (none-selected-exit, quoted-name-unselectable, refusal-cascade,
  sleep-is-noop, upstream-compile-errors, refusal-row-shape) and 1 `refused` held line (duplicate-key-insert-raises),
  no `gate-fail` line";
- the S1 and N1 rows lose "with the `unlike-bc` warning line";
- new: no leg's receipt lines carry an `al-runner-v3-defect-unlike-bc` line.
Every other row of table B stands. The BLOCK rule ("any difference in any leg, Measured or Inferred, is a BLOCK on
R-586c") applies to table B as amended, and is otherwise unchanged.

## alpha.5 stays `held`

Not admitted, for these reasons, which r17 does not touch:
- leg C's gone facts (none-selected-exit, quoted-name-unselectable, refusal-cascade, sleep-is-noop,
  upstream-compile-errors; `refusal-row-shape` now joins them, a sixth) and the duplicate-key refusal (`refused`,
  `held`);
- leg T's 7 rows;
- X (b).
This holds until R-586c's per-build pins re-pre-commit the held facts.

## Predictions

1. The full v3 gate on the final head (lethal/r705 merged), with alpha.2: all 14 legs pass. Leg C reads 9 defect facts
   `defect-present` (refusal-row-shape on alpha.2's refusal row included), 18 contract facts `matches`, the warn fact
   `matches`.
2. The `--regate` at the final master passes; `current` stays alpha.2.
3. The first daily update run whose `.gated.lethalCommit` contains 9c19550b (the one the prediction-2 regate writes)
   gates alpha.5 and reads `held` (leg C has `held` lines and no `gate-fail` line: the `unlike-bc` line is gone); it is
   not `gate-fail`. `current` stays alpha.2. A daily run at befe8024 (or any `.gated` commit before 9c19550b) before
   that still reads r15 table B's `gate-fail`: that is NOT a BLOCK.
   `held` rests on the INFERRED readings of table B: `message-has-no-type-prefix`, `dependency-skip-line`,
   `timeout-is-cpu`, and the per-mutant figures of L1, Y-A, Y-B, MO and WR. A `diverged` reading on any of them, or an
   `AlRunnerCoverageFrameError`, gives `gate-fail`. That is a BLOCK to report, not a falsified ruling.
4. Offline leg C on alpha.5, the contract probe against the kept binary:
   `LETHAL_ITEST_ALRUNNER_V3=1 LETHAL_ALRUNNER_V3_CANDIDATE=1 LETHAL_ITEST_V3_LEGS=C
   LETHAL_ALRUNNER_V3_PATH="$(ls -d /work/tools/al-runner-v3/failed/v3.0.0-alpha.5@6eddda0b*/al-runner)"
   bun run itest:alrunner-v3`. It reads `refusal-row-shape = gone` (the security text, exit 1); `serve-keep-reasons`
   and the other facts read as r16 predicts.

`held` is never blacklisted, so alpha.5 is re-gated on every daily run (about 25 minutes of a heavy slot) until
R-586c's per-build pins land.

Anything else is a BLOCK: report it, do not tune it.

## Judgement call to confirm

"matches" for a DEFECT fact is spelled `gone` in the code (`defect-present` / `gone` / `refused` / `unlike-bc`).
The word `matches` belongs to contract facts. r17 uses `gone` for the verdict and calls the effect "reads as BC".
