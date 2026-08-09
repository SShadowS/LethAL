# 2026-08-08 — R85 swap population, rung 2

**This campaign's RESULTS stand exactly as committed. No verdict, count or conclusion has been
edited.** This README is a forward note, which is the only way a correction is recorded against a
committed campaign record.

## ONE EXCEPTION, 2026-08-09: `rung2.report.json` was REDACTED

Every mutant's `originalText` and `mutatedText` held verbatim AL statements from **Continia Document
Output**, a commercial product, in a PUBLIC repository. Both fields are now the literal string
`[redacted: third-party source, see this directory's README]` — 1,046 fields across 523 mutants.

**Nothing else changed.** Mutant ids, verdicts, operators, file paths, procedure names, covering test
names, ast hashes, timings and `killingTestFailure` are byte-identical to the committed run. Every
number this campaign reports is still checkable against the artifact that produced it, and
`scripts/r121-classify-eval.ts` still reproduces R121's table off this file exactly (73 kills, 6
false, B2 at 23 flagged / 26.1% precision / 100% recall).

Redaction was chosen over deletion so the record stays re-analysable. It does NOT remove the source
from git history — the file was public from 2026-08-08.

## A history rewrite was CONSIDERED and DECLINED, 2026-08-09

Not an oversight. The blast radius was measured first:

| fact | value |
| --- | --- |
| forks / network | 0 |
| watchers / stars | 0 / 1 |
| open pull requests | 0 |
| remote refs | `refs/heads/master` only |
| `refs/pull/1,2/head` contain either report | no, both checked |
| contributors ever | 2, and the second's commit predates both campaigns |

Mechanically the rewrite is easy — one branch, one author, `git-filter-repo` installed, ~50 commits
touched. **It was declined because it would not have bought what it appears to buy.** A force push
leaves the old objects fetchable by SHA on GitHub until GitHub's own garbage collection runs, which
only a Support ticket triggers; any clone anyone made keeps everything regardless; and mirrors and
code-search indexes had two days. The realistic ceiling was "publicly browsable" becoming "needs a
specific SHA and beating GC", not deletion.

Against that: this repository closes roadmap rows with `done (<commit>)`. **48 commit SHAs are cited
across `docs/roadmap/` and `CLAUDE.md`**, 4 of which the rewrite would invalidate, plus every SHA in
the 49 rewritten commit messages. Paying that in record integrity for a mostly symbolic gain was
judged the worse trade, on the owner's assessment that nobody fetched it.

**What would reopen this:** evidence that someone did fetch it, or Continia treating the exposure as
reportable. In that case the rewrite is the prerequisite and the GitHub Support GC request is the
actual operation — doing the first without the second accomplishes little.

## What is still published here, deliberately

File paths (including `.dependencies\CDO\...`), procedure names, codeunit names and 398 fully
qualified test names. These were ruled acceptable by the repository owner on 2026-08-09; the ruling
was specifically that **filenames and paths are fine, source code is not**.

## Failure text is RETAINED, and that was a decision, not an oversight

`killingTestFailure` keeps each kill's first-line message — ~8.5 KB across 73 kills. Measured
composition:

| n | what it is |
| --- | --- |
| 50 | Microsoft Library Assert output, whose message text was written by Continia's test authors |
| 15 | target-authored `Error(...)` literals |
| 8 | Business Central platform messages |

The first two categories are string literals lifted out of the product's source, so under the
strictest reading of the ruling above they are source code too. **The repository owner ruled on
2026-08-09 that they stay.** The reasoning recorded at the time: assert and error message text is
documentation-grade rather than implementation, and it is the corpus R121's classifier evaluation
scores against — redacting it would leave the shipped screen's measured precision (26.1%, 100%
recall) uncheckable by anyone outside this machine, and would also destroy the corpus's ability to
score any FUTURE candidate rule, which is the property R121 exists for after two rules were written
from examples and refuted only by this data.

The remaining ~90 KB of that field is callstack frames — procedure names, line numbers, app names and
versions — which the filenames-and-paths half of the ruling already covers.

A future campaign committing a report here inherits this ruling: strip `originalText`/`mutatedText`,
keep everything else.

## What this campaign measured

See `rung2.result.md` for the result and `rung2.precommit.md` for what was predicted before the run.
`rung2.r121-eval.txt` is the committed output of scoring six candidate false-kill rules against the
73-kill corpus; R121's own row carries the table and the conclusion (nothing is shippable as a
classifier; the `Assert.`-prefix rule ships as a 100%-recall SCREEN instead).
