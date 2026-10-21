# Live gates: frozen figures and history

A gate is an integration test that only runs when its environment variable is set
(`bun run itest:<name>`). It runs LethAL against a live Business Central server, or against
al-runner, and compares every mutant's verdict with a committed baseline in
`packages/runner/itest/*.baseline.json`. The rules for running gates are in `CLAUDE.md`
§"Integration tests". These pages hold what CLAUDE.md used to carry inline: each gate's frozen
figures, what they mean, and how they came to be.

| Gate | Command | Page | Baselines |
|---|---|---|---|
| bcdev | `LETHAL_ITEST_BCDEV=1 bun run itest:bcdev` | [bcdev.md](bcdev.md) | `bcdev.baseline.json` |
| bcdev-names | `LETHAL_ITEST_BCDEV=1 bun run itest:bcdev-names` | [bcdev-names.md](bcdev-names.md) | `bcdev.names.baseline.json` |
| bcdev-wrapped | `LETHAL_ITEST_BCDEV=1 bun run itest:bcdev-wrapped` | [bcdev-wrapped.md](bcdev-wrapped.md) | `bcdev.wrapped.baseline.json` |
| alrunner | `LETHAL_ITEST_ALRUNNER=1 bun run itest:alrunner` | [alrunner.md](alrunner.md) | the `al-runner.*` baselines |
| envtool | `LETHAL_ITEST_ENVTOOL=1 bun run itest:envtool` | [envtool.md](envtool.md) | `envtool.baseline.json` |
| tables | `LETHAL_ITEST_TABLES=1 bun run itest:tables` | [tables.md](tables.md) | `tables.baseline.json` |
| chunked | `LETHAL_ITEST_CHUNKED=1 bun run itest:chunked` | [chunked.md](chunked.md) | none |
| hang | `LETHAL_ITEST_HANG=1 bun run itest:hang` | [hang.md](hang.md) | `hang.single.baseline.json` |
| harden | `LETHAL_ITEST_HARDEN=1 bun run itest:harden` | [harden.md](harden.md) | `harden.baseline.json` |

The BC gates run on the BC on Linux servers `bc1`, `bc2` and `bc3`: see [servers.md](servers.md).
That page carries no figure block, because it describes no single gate.

## The figure block

Each page has exactly one fenced block whose info string is `json gate-figures`. It sits in the
page's "## Frozen figures" section, and its `gate` is the page's `# itest:<name>` heading. Its
fields are:

- `baselines`: for each baseline file, the count of each verdict (`killed`, `survived`,
  `no-coverage`, `timeout-killed`). A verdict with count 0 is left out. A gate with no baseline
  file has `{}` here and must say why in `noBaseline`.
- `constants`: figures that an exported constant in `packages/runner/itest/` holds, named by a
  dotted path into it. Most are in `gate-expected.ts`, which the itests read their figures from.
  An itest cannot be imported, because importing it runs its gate (R186); `gate-expected.ts` has
  no side effects, so it can.
- `notPinned`: the few figures an itest still writes as a literal inside an assertion. The gate
  checks them on every live run, but the offline test cannot.

`packages/runner/tests/gate-pages.test.ts` (the pin test) fails when any of these is true:

- A page has no block, or two. The block's `gate` differs from the heading. The block names no
  baseline and gives no `noBaseline` reason.
- A `baselines` figure differs from the committed file. Both on-disk formats are read: the R556
  `{identityScheme, entries}` object and the older plain list.
- An exported pre-committed table exists for that baseline, and its verdict counts differ.
- A `constants` figure differs from the exported constant.
- A registered gate baseline (`GATE_BASELINES`, `SYMBOL_BASELINES`) is on no page, or on two.
- The "## Frozen figures" prose states a count the block does not hold: a
  `killed / survived / no-coverage` triple, an "over N" total, a count in words ("16 killed",
  "5 timeout-killed"), or a named figure ("`groupedCalls` is 399"). On a page with several
  baselines, each bullet that states counts must name its baseline file, and is checked against
  that file alone. History sections are not checked, because they quote old figures on purpose.
- A count in `gate-expected.ts` (killed, survived, no-coverage and their total) differs from the
  gate's baseline file.
- A figure in `gate-expected.ts` is named on no page.
- One of the six itests it serves does not read its figures from it, or restates one as a literal.
- CLAUDE.md names a `docs/...md` path that does not exist.

So a re-recorded baseline, or a changed itest figure, cannot leave its page stale. The commit that
changes one must change the other.

## Control app versions

The grouped path (`RunMutantMany`, `StopHungRunAt`, `LC Op Progress`) exists only
from LethAL Control 1.0.0.17. The session keys (`testRunsBefore`, `sessionId`), the suite built once per call
and keyed by pair, and `suite-unresolved` exist only from 1.0.0.18. `ObservedActive` (whether the
active mutant's own statement was reached, per test) exists only from 1.0.0.19. The client's
minimum is `MIN_CONTROL_VERSION` in `packages/runner/src/harness.ts`. The version to publish is the
one in `extensions/lethal-control/app.json`. R-583 (merged 2026-10-21) moved the app and every
fixture to runtime 17.0, and made its runtime-17 build the minimum. `DependentCount` (R389's
closed-world guard) exists only from 1.0.0.23. The client treats it as optional: an older control
app answers 404 and the guard falls back to open-world, so the minimum was not raised for it.
