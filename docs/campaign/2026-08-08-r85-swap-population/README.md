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
from git history — the file was public from 2026-08-08 — and rewriting history is a separate
decision that has not been taken.

## What is still published here, deliberately

File paths (including `.dependencies\CDO\...`), procedure names, codeunit names and 398 fully
qualified test names. These were ruled acceptable by the repository owner on 2026-08-09; the ruling
was specifically that **filenames and paths are fine, source code is not**.

## What is still open

`killingTestFailure` retains each kill's first-line message, ~8.5 KB across 73 kills. Measured
composition: 50 are Microsoft Library Assert output whose message text was written by Continia's test
authors, 15 are target-authored `Error(...)` literals, 8 are Business Central platform messages. The
first two categories are string literals lifted out of the product's source, so under a strict
reading of the ruling above they are source code too. They are retained because they are the corpus
R121's classifier evaluation scores against, and removing them would make the shipped screen's
measured precision uncheckable by anyone outside this machine. The remaining ~90 KB of that field is
callstack frames — procedure names, line numbers, app names and versions — which the ruling covers.

## What this campaign measured

See `rung2.result.md` for the result and `rung2.precommit.md` for what was predicted before the run.
`rung2.r121-eval.txt` is the committed output of scoring six candidate false-kill rules against the
73-kill corpus; R121's own row carries the table and the conclusion (nothing is shippable as a
classifier; the `Assert.`-prefix rule ships as a 100%-recall SCREEN instead).
