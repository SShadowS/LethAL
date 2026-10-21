# Live gates: frozen figures and history

A **gate** is an env-gated integration test (`bun run itest:<name>`) that runs LethAL against a live
Business Central server or against al-runner and compares every mutant's verdict with a committed
**baseline** (`packages/runner/itest/*.baseline.json`). The rules for running gates live in
`CLAUDE.md` §"Integration tests". These pages hold what CLAUDE.md used to carry inline: each gate's
frozen figures, what they mean, and how they came to be.

| Gate | Command | Page | Baselines |
|---|---|---|---|
| bcdev | `LETHAL_ITEST_BCDEV=1 bun run itest:bcdev` | [bcdev.md](bcdev.md) | `bcdev.baseline.json` |
| bcdev-names | `LETHAL_ITEST_BCDEV=1 bun run itest:bcdev-names` | [bcdev-names.md](bcdev-names.md) | `bcdev.names.baseline.json` |
| bcdev-wrapped | `LETHAL_ITEST_BCDEV=1 bun run itest:bcdev-wrapped` | [bcdev-wrapped.md](bcdev-wrapped.md) | `bcdev.wrapped.baseline.json` |
| alrunner | `LETHAL_ITEST_ALRUNNER=1 bun run itest:alrunner` | [alrunner.md](alrunner.md) | `al-runner.*.baseline.json` (eight files) |
| envtool | `LETHAL_ITEST_ENVTOOL=1 bun run itest:envtool` | [envtool.md](envtool.md) | `envtool.baseline.json` |
| tables | `LETHAL_ITEST_TABLES=1 bun run itest:tables` | [tables.md](tables.md) | `tables.baseline.json` |
| chunked | `LETHAL_ITEST_CHUNKED=1 bun run itest:chunked` | [chunked.md](chunked.md) | none |
| hang | `LETHAL_ITEST_HANG=1 bun run itest:hang` | [hang.md](hang.md) | `hang.single.baseline.json` |
| harden | `LETHAL_ITEST_HARDEN=1 bun run itest:harden` | [harden.md](harden.md) | `harden.baseline.json` |

## The figure block

Each page has exactly one fenced block whose info string is `json gate-figures`:

- `baselines`: for each baseline file, the count of each verdict (`killed`, `survived`,
  `no-coverage`, `timeout-killed`, ...). A verdict with count 0 is left out.
- `constants`: figures that an exported constant in `packages/runner/itest/` also holds, by a dotted
  path into that constant.
- `notPinned`: figures that live only inside an itest's own unexported `EXPECTED` object. The gate
  asserts them on every live run; the offline pin test cannot read them, because importing an itest
  runs its gate (R186). Update them by hand when the itest changes.

`packages/runner/tests/gate-pages.test.ts` (the **pin test**) reads every block and fails when:

- a `baselines` figure differs from the committed baseline file, in either on-disk format (the R556
  `{identityScheme, entries}` object or the older plain array);
- where the itest has an exported pre-committed table for that baseline, the table's verdict counts
  differ too;
- a `constants` figure differs from the exported constant;
- a registered gate baseline (`GATE_BASELINES`, `SYMBOL_BASELINES`) appears on no page, or on two.

So a re-recorded baseline cannot leave its page stale: the commit that re-records it must also
update the page.

## Control app versions (moved from CLAUDE.md)

The grouped path (`RunMutantMany`, `StopHungRunAt`, `LC Op Progress`) exists only from LethAL Control
1.0.0.17; the session keys (`testRunsBefore`, `sessionId`), the pair-keyed suite built once per call
and `suite-unresolved` only from 1.0.0.18; and `ObservedActive` (the active mutant's own statement
reached, per test) only from 1.0.0.19. The client's minimum is `MIN_CONTROL_VERSION` in
`packages/runner/src/harness.ts`; the version to publish is the one in
`extensions/lethal-control/app.json`. R-583 (branch `lethal/r583`, not yet on master on 2026-10-21)
moves the app to runtime 17.0 as version 1.0.0.22 and makes that the minimum.
