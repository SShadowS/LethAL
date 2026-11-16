# A pass/fail threshold for LethAL in CI: options for an owner ruling (PR-70, 2026-11-16)

LethAL gates on nothing today. `lethal run` exits 0 whenever the run completes, and `lethal export --thresholds` only colours
the rendered report. A pilot user (DO) will ask "when should the pipeline go red?". These are the options. Nothing is built
until the owner rules.

## What any threshold must respect
- **A verdict is not always a measurement.** `error`, `no-coverage`, quarantine (exit 3) and a partial run (exit 7) are not
  survivors. A threshold that counts them as survivors, or leaves them out silently, misleads (principles 1, 5, 6).
- **al-runner-v3 is not authoritative.** A threshold that fails a pipeline on a v3 survivor can fail it on a v3 difference
  from BC. The report caveats those, but a single number hides the caveat.
- **Scope changes the number.** `--changed-since` measures only the changed lines. A whole-app score and a changed-lines score
  are different quantities and must not share one threshold.
- **Order dependence is mostly gone** (R1057, PR-51): the killed vs timeout-killed class no longer moves between runs. The
  killing test can still move (R197), and so can error vs killed (R1066). So a threshold should read the verdict class, never
  the killing test.

## Options
1. **None (today).** The pipeline fails only on exit 1/3/4/7; survivors are information, shown in the rendered report.
   - Pros: no false red; nothing new to maintain.
   - Cons: nobody acts on survivors unless they read the report.
2. **Absolute score on the changed lines.** Fail if killed / (killed + survived) on the changed lines is below X (for example
   60%). Error and no-coverage are reported apart, never in the ratio.
   - Pros: simple, familiar (Stryker's `break` threshold).
   - Cons: a change of three mutants swings the score by 33 points. Small pull requests become noisy, so the threshold needs
     a minimum count. The number also invites gaming (add asserts until green).
3. **No new survivor on the changed lines.** Fail if any mutant on a line the pull request changed survives. An "accept"
   file lists survivors the team accepts, one per line, with a reason (an equivalent mutant, or logging only).
   - Pros: points at a concrete line; no arbitrary number; the accept list is reviewable and shrinks over time.
   - Cons: needs the accept-list format and a stable mutant identity across runs. LethAL has one: astHash, object,
     procedure, operator, ordinal, which equivalence marks already use (R193).
4. **Ratchet against the target branch.** Fail if the changed lines' score is lower than the same lines scored on the
   target branch.
   - Pros: never worse than before.
   - Cons: needs a stored run of the target branch per pull request: twice the cost, or a cache that must be kept fresh.
5. **Advisory comment only.** Never fail; post the survivors on the changed lines as a pull-request comment.
   - Pros: visible without blocking.
   - Cons: posting needs a token and outward-facing writes the pipeline owner must allow.

## Recommendation
**Option 3, advisory first.**
- A first release prints the "new survivors on changed lines" list and exits 0, with a flag to make it fail.
- Make it fail only after the DO pilot shows how many survivors a typical pull request has and how many are equivalent.
- Measure, then gate: principle 4.
- On al-runner-v3, a survivor whose site carries a v3 caveat is listed apart and never fails the pipeline.
- Option 2 is the cheapest to build, but the most likely to be noisy on small pull requests.

## Asked
Filed to the owner through kraken, naming this file.
