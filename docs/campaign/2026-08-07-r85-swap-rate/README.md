# 2026-08-07 — R85, the swap kill rate on Continia Document Output

Instrument **(b)** of R85: a LethAL run at scale against a real project, yielding the
`lethal.swap-call-arguments` kill rate as a by-product.

`rung0.precommit.md` is the pre-commitment and is **immutable** — it was committed (`7ad63c1`)
before the environment was started and before any verdict existed. Corrections and decisions taken
afterwards go here as forward notes, never as edits to that file. That rule is why the campaign
gates exist.

## Files

| file | what it is |
| --- | --- |
| `rung0.precommit.md` | the bar, the seeded scope rule, the false-kill rule. Fixed before the run. |
| `rung1.scope.md` | the 12 files the rule chose, with per-file swap and deployed counts |
| `select-scope.py` | the selector, so the scope is reproducible from the seed alone |
| `swap-sites-437.txt` | the sampling frame: every claimed swap site, file and span |

---

## Forward note 1 — the baseline is NOT narrowed, and that is a deliberate cost

`rung0.precommit.md` fixes the file scope and is silent on test scope. Settling it here, before the
run rather than after: **no `--tests-only`. The full suite runs.**

The previous campaign (`2026-08-03-do`) used `--tests-only "Src/AutomaticDocuments/**"`, which
narrowed the baseline from 1,246 tests to 56 and made a 148-mutant run affordable. That narrowing is
correct for a determinism gate and **wrong for this question**. CLAUDE.md states the reason plainly:
`--tests-only` narrows the baseline and CAN change a verdict, because an excluded killing test
manufactures a survivor. A rate computed against a narrowed suite is the rate at which *that subset*
notices a swap, which is not what R85 asks.

Measured for the record: the suite holds **1,314 `[Test]` procedures across 105 files**, and the
`AutomaticDocuments` subset the previous campaign used is 5 of those files.

The cost is accepted knowingly and is expected to dominate the run: the baseline executes every test
once with coverage collection, and a fuller baseline also raises per-mutant cost, because better
coverage attribution means each mutant is run against more covering tests. The previous campaign's
~19.5 s/mutant figure was measured under the 56-test baseline and is therefore a FLOOR here, not an
estimate. Any wall-clock projection in `rung0.precommit.md` that was derived from it understates
this run.

## Forward note 2 — the target tree

`rung0.precommit.md` measured the 437-site frame against `U:/Git/do-rel2/Cloud`; the run targets
`U:/Git/do-lethal/Cloud`, which is what the previous campaign used and what the envtool config
points at. **Verified before the run: the AL source is identical.** `diff -rq` reports differences
only under `.alpackages` (symbol package versions), editor/tooling directories, and
`lethal.sqlite` — **no `.al` file differs**. The frame carries across unchanged.
