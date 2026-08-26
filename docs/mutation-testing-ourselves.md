# Mutation testing LethAL's own TypeScript

`bun run mutate` runs [StrykerJS](https://stryker-mutator.io/) over selected LethAL source files and
reports how many mutants our own unit tests kill.

It was added the day R175 was found, and the first thing to understand is that **it would not have
caught R175.** Reading a score here as a safety guarantee is the mistake this page exists to prevent.

## What it cannot catch, stated first on purpose

R175 was a wrong belief about Business Central, encoded in `coverageFilter` and encoded again in the
test that pinned it:

```ts
test("a PUBLIC procedure mutant is NOT widened by unnamed-member observations — it did not execute", ...)
```

Mutate that gate and the test goes red, so the mutant is KILLED and the line scores as
well-covered. Mutation testing answers *"would my tests notice if this code changed?"* It cannot
answer *"is what this code believes about an external system true?"* Where our code and our tests
share one wrong assumption, a perfect mutation score is exactly what you get.

For that class the control is a differential against ground truth, not test sensitivity: see
`coverageMode: "none"` and the `coverage-differential` skill.

## What it does catch, measured on the first run

The recurring hazard CLAUDE.md names, a test that asserts the right thing but would pass either
way. The first run found one in code less than an hour old:

**`line-map.isNamingGap` was entirely unkilled**, including a mutant that emptied the whole method
body. `selection.test.ts` exercised its CONSEQUENCE with a hand-built `namingGaps` array, which
proved nothing about whether the function computes one from real AL. Five direct tests took
`line-map.ts` from **57.41% to 73.46%** and the pair from 68.31% to 75.06%.

That is the shape to expect: not "this code is wrong" but "nothing here would notice if it were".

## Running it

```bash
bun run mutate                      # the configured scope
bunx stryker run --mutate 'packages/schemata/src/dedup.ts'   # something else, ad hoc
```

Reports land in `reports/mutation/` (gitignored): `index.html` to browse, `mutation.json` to script.
A run over the configured scope takes about 20 seconds.

## Why the `command` runner, and the supply-chain note

Stryker ships **no official Bun runner** ([#4439](https://github.com/stryker-mutator/stryker-js/issues/4439),
[#5424](https://github.com/stryker-mutator/stryker-js/issues/5424)). Two community plugins exist and
one supports per-test coverage, which would let Stryker run only the tests touching each mutant.

We use the built-in `command` runner instead, and that is a decision rather than an oversight: a test
runner plugin executes inside our test process, this repository is public, and adding one should be
a deliberate act. The cost is no per-test coverage analysis, so every mutant runs the whole command.
That is why the configured command is narrowed to the suites covering the mutated files rather than
the full 2,561-test run, and why the scope is a short list of files rather than `packages/**`.

If the scope grows enough that this hurts, evaluate a plugin on its merits then. Do not add one to
make a broad scope tolerable.

## Choosing what to mutate

Scope it where a wrong-reason test actually costs something. In rough order:

- `packages/runner/src/selection.ts` and `line-map.ts` — coverage attribution, where a silent error
  becomes a wrong verdict (R29, R63, R175 all live here).
- `packages/schemata/src/dedup.ts` — §3.2 precedence, where a silent error deletes mutants.
- `packages/builtin-tier1` and `-tier2` operators — but note these already have conformance suites
  and live gates, so the marginal value is lower.

Not worth mutating: report rendering and message text. Roughly a third of the first run's survivors
were string literals inside `console.warn` and error messages, which is noise. `ignoreStatic` is on
for the same reason.

## Reading a score

The number is not a target. A mutant that survives is a question: *would anything have noticed?* Some
have the honest answer "no, and that is fine" — a log line, a defensive branch that cannot be reached
from a unit test. Kill the ones that matter and leave the rest, the same judgement this tool asks a
user to make about their own AL.

There is no `break` threshold configured, so a run never fails CI. That is deliberate while the
scope is small: a score that gates merges invites raising it by writing tests that assert nothing,
which is the very failure the tool is meant to expose.
