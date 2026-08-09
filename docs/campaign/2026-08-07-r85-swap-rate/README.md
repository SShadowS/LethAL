# 2026-08-07 — R85 swap rate, rung 1

**This campaign's RESULTS stand exactly as committed. No verdict, count or conclusion has been
edited.** This README is a forward note, which is the only way a correction is recorded against a
committed campaign record.

**ONE EXCEPTION, 2026-08-09: `rung1.report.json` was REDACTED.** Every mutant's `originalText` and
`mutatedText` held verbatim AL statements from Continia Document Output, a commercial product, in a
PUBLIC repository. Both fields are now the literal string
`[redacted: third-party source, see this directory's README]` — 1,504 fields across 752 mutants.
Nothing else changed: mutant ids, verdicts, operators, file paths, procedure names, covering test
names, ast hashes, timings and failure text are byte-identical to the committed run, so every
number this campaign reports is still checkable against the artifact that produced it.

Redaction was chosen over deletion so the record stays re-analysable. It does NOT remove the source
from git history — the file was public from 2026-08-07. A history rewrite was CONSIDERED and
DECLINED on 2026-08-09 after the blast radius was measured (0 forks, 0 open PRs, one remote branch,
and 48 commit SHAs cited across the roadmap that it would have disturbed). The reasoning, and what
would reopen it, are recorded once in this campaign's rung-2 successor README.

`killingTestFailure` is RETAINED, ruled 2026-08-09: its callstack frames are names and line numbers,
which the ruling covers, and its message text is the corpus R121's classifier evaluation scores
against. See this campaign's rung-2 successor README for the full composition and reasoning.

## What it produced

Not a rate. It scored **3** swap mutants out of 894 deployed, all three killed, and all three
measured to be FALSE kills of the arm-E shape (a description overflowing the shorter field a name is
assigned to, BC rejecting the data before any assertion ran). `rung1.result.md` declines to apply
the pre-committed bar at n = 3 and says so.

Its own conclusion: *"A second run under the same rule is not worth it. A tighter rate needs a NEW
pre-commitment with a coverage-aware selection rule, written openly as its own campaign, with this
result left standing."*

## The successor exists

**`docs/campaign/2026-08-08-r85-swap-population/`.** Read that one for the rate.

It became possible because **R127** shipped `--operator <name>` on 2026-08-08, which this campaign
did not have. With it the WHOLE swap population is cheaper than this run's truncated slice — 523
mutants against 894 — so there is no sampling rule, no seed, and nothing to select on. The
coverage-aware requirement this campaign's result asked for turned out to be unsatisfiable from this
run (11 files touched, 3 with any coverage, holding 10 of the 437 sites) and became unnecessary
rather than being satisfied.

Result there: 523 deployed, 177 scored, first-party rate **63/154 = 40.9%** raw and **37.0%**
false-kill-adjusted, with **6 of 63** kills the same arm-E shape this campaign found at 3 of 3.

## Two figures in this campaign that a later reader should not misquote

Both are correct as written and both are narrower than they look:

- **"437 sites across 91 files."** Correct, and it is the FIRST-PARTY population, measured by a
  census script that skipped `Cloud/.dependencies/`. Measured again through the real pipeline, the
  first-party figure is exactly 437 across exactly 91 files — the census was right — and the whole
  project holds **523 across 111 files**, because LethAL also mutates the 137 vendored `.al` files
  the census excluded.
- **"80% of the chosen scope had no covering test."** A property of this campaign's seeded
  file-budget rule, not of the project. Over the whole population the split is **66%**.
