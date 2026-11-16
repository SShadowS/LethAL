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
   60%). `timeout-killed` counts as killed. Error and no-coverage are reported apart, never in the ratio.
   - Pros: simple, familiar (Stryker's `break` threshold).
   - Cons: a change of three mutants swings the score by 33 points. Small pull requests become noisy, so the threshold needs
     a minimum count. The number also invites gaming (add asserts until green).
3. **No new survivor on the changed lines.** Fail if any mutant on a line the pull request changed survives. An "accept"
   file lists survivors the team accepts, one per line, with a reason (an equivalent mutant, or logging only).
   - Pros: points at a concrete line; no arbitrary number; the accept list is reviewable and shrinks over time.
   - Cons: needs the accept-list format and a mutant identity that holds across runs. LethAL's identity key (astHash,
     object, procedure, operator, operator major, and an ordinal for twins) is what equivalence marks use (R193). It is NOT
     stable under exactly this use: an edit changes the mutated code's astHash, and twins are told apart by a run-wide
     ordinal, so an edit anywhere, or a `--lines`/`--changed-since` filter, can hand a key to another twin. Marks are
     matched only under R443's proof rules. So an accept list needs that proof or another anchor, and an entry on an
     edited line goes stale by design (it must be re-accepted).
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
- The cost of option 3 is the accept list's anchoring (see its cons). Part 2 (below) builds it with its own anchor, not R443's
  proof rules.

## Ruling and first step (PR-77, 2026-11-16)
The owner chose option 3, advisory first: "Decide on gating from the DO pilot's measured numbers."
- Built: after a run narrowed by `--lines` or `--changed-since`, the console ends with SURVIVORS ON THE CHANGED LINES. On
  al-runner-v3, survivors with a positive caveat (a flagged baseline, coverage off, the restrictive-default list) are listed
  apart. Unknown flags (serve rows carry none, #7954) and unrecorded ones count, and a summary line says how many survivors
  that covers. A quarantined or time-budget run marks the section partial.
- Built: `lethal run --fail-on-survivors` exits 9 when a counted survivor remains. Off by default; the templates carry it
  commented out.
- Not built in PR-77: the accept list and its anchoring (the cons of option 3). Part 2 below builds it.
- Spec: `docs/superpowers/specs/2026-11-16-pr77-changed-line-survivors.md`.

## Part 2: the accept list (PR-79, 2026-11-16)
Part 2 of the ruling. Spec: `docs/superpowers/specs/2026-11-16-pr79-accept-list.md`.

**A deviation from the ruling's wording, for the owner to object to.** The task said to anchor the list by extending R443's
proof rules (the equivalence marks). This design does not. It leaves R443 and `lethal.equivalent.json` unchanged and gives the
accept list its own file and its own anchor, for two measured reasons:
- On a `--changed-since` run the report withholds every mark whose coarse tuple (astHash, operator, major) is shared with a site on
  another line. A probe counted those: 73.8% of the deployed sites in a large private project, 26% in gift-card. About three in
  four reviewed survivors would never be accepted, and `--fail-on-survivors` would exit 9 on them forever.
- R443's key does not change when a line is rewritten in place (`x > 0` becomes `y > 0`), so a mark would keep a rewritten
  survivor accepted. The ruling says a changed site re-opens.

**What was built.**
- `lethal.accepted.json` in the `--project` folder. An entry is anchored to the site's text, the whole member that holds it
  (attributes included, and for a trigger every enclosing declaration header), the site's place in that member, and the build's
  preprocessor symbols. Any change to one of those re-opens the survivor.
- `lethal run` prints a ready entry under each counted survivor, computed from the source the run measured.
- Accepted survivors are listed with their reasons and never count toward `--fail-on-survivors` (exit 9). Equivalence marks do
  not exempt a survivor. The default stays advisory until the DO pilot's numbers decide.
- The workflow, what keeps an entry and what re-opens it, and the stated limits: [README.md](README.md), "Accepting a survivor".

## Asked
Filed to the owner through kraken, naming this file.
