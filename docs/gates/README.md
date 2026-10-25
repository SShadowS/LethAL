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
| alrunner-v3 | `LETHAL_ITEST_ALRUNNER_V3=1 bun run itest:alrunner-v3` | [alrunner-v3.md](alrunner-v3.md) | `al-runner-v3.tables.baseline.json`; the `al-runner-v3.layout` and `al-runner-v3.symbols-lethala`/`-lethalb` baselines (R654 S2) |
| envtool | `LETHAL_ITEST_ENVTOOL=1 bun run itest:envtool` | [envtool.md](envtool.md) | `envtool.baseline.json` |
| tables | `LETHAL_ITEST_TABLES=1 bun run itest:tables` | [tables.md](tables.md) | `tables.baseline.json` |
| chunked | `LETHAL_ITEST_CHUNKED=1 bun run itest:chunked` | [chunked.md](chunked.md) | none |
| lend | `LETHAL_ITEST_LEND=1 bun run itest:lend` | [lend.md](lend.md) | none (reads `bcdev.baseline.json`) |
| hang | `LETHAL_ITEST_HANG=1 bun run itest:hang` | [hang.md](hang.md) | `hang.single.baseline.json` |
| harden | `LETHAL_ITEST_HARDEN=1 bun run itest:harden` | [harden.md](harden.md) | `harden.baseline.json` |

The BC gates run on the BC on Linux servers `bc1`, `bc2` and `bc3`: see [servers.md](servers.md).
That page carries no figure block, because it describes no single gate. Nor does
[alrunner.md](alrunner.md): `itest:alrunner` (the .NET al-runner's gate) was retired by R654, and
its page is kept as history.

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
- A registered gate baseline (`GATE_BASELINES`) is on no page, or on two.
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

## A scheme bump re-records the baselines (R682)

A baseline recorded under an older identity scheme (`IDENTITY_SCHEME`, `packages/schemata/src/project.ts`) is
compared across a scheme change. There a byte-identical twin's mutated text cannot be checked, so the gate prints
"N mutant(s) text-UNVERIFIED", and a mutant changed under an unchanged key goes unseen.
- **The rule:** a change that raises `IDENTITY_SCHEME` re-records every gate baseline in the same change, by the
  R332 procedure (pre-commit, delete, record once, confirm a pass), OR lists each one it leaves behind with the
  roadmap item that will re-record it.
- **The check:** `gate-pages.test.ts`, "R682". Every committed `itest/*.baseline.json` must record the current
  scheme or appear in its `LAGGING_SCHEME` list with an item. A listed file that has caught up fails too.
- **Today's list:** R690 re-recorded ten baselines at scheme 42 (figures unchanged). Only
  `envtool.baseline.json` still lags; it waits on R683 (host only).

## Warning sets: `GATE_WARNINGS` and observe mode (R736)

Every itest that calls `runSession` collects the run's `warning` events and compares the SORTED, unique warning
CODES (never the messages) with a committed set in `GATE_WARNINGS` (`packages/runner/itest/gate-expected.ts`),
keyed `"<gate>/<leg>"`. An extra or a missing code fails the gate, naming it. A key that is absent makes the gate
refuse: a gate never records its own set (the same rule as R332's baselines).
- **Other runs (R739):** `runVerify` and `runNamedMutants` emit warning events too. The verify, testapp and agreement
  gates collect them per step, under their own keys: `verify/step3`, `verify/step4`, `verify/step4b`,
  `testapp/step6`, `testapp/step7`, `agreement/verify`, `agreement/named`. A call that throws or refuses by design
  (verify's refusals, testapp's two absence probes) has its own collector, printed and never asserted.
  `gate-warnings-wiring.test.ts` checks that every `runNamedMutants(` and `runVerify(` call in an itest passes an
  `emit` holding a collector's `subscriber`. The keys are pinned from an explained, pre-committed observe run
  (`2026-10-24-r739-warning-sets-precommitment.md`).
- **What is an event:** since R739 the backends' notices (`setNotify`) and the orchestrator's lease and coverage
  lines are warning events, not console lines. Only a few diagnostics stay on the console: the v3 contract lines,
  the v3 close stats, staged-copy removal, the R289 trace, the store's WAL notice, the cache-removal notice, the
  harness tenant line, `app-package.ts`'s unmapped-object-type line, `env-tool-session.ts` (its 6 lines), the
  lines around a session in `cli.ts`, and the no-emitter fallbacks in `generateMutationSet` and `batchByGuards`
  (orchestrator.ts), which print only when a caller passes no emitter. A notice after a session has ended
  (a late lease refusal, a backend used again) also goes to the console.
- **Observe mode:** `LETHAL_ITEST_OBSERVE_WARNINGS=1` runs the gate as usual, asserts nothing about warnings, and
  prints `[gate-warnings] <gate>/<leg>: [codes]` plus one example message per code. It always ends as a non-pass: when
  nothing else failed, exit 3, a failed receipt and a closing line `OBSERVED (exit 3, not a pass)`; a leg that
  fails ends the gate with its own error first. al-runner-v3 keys its sessions by scratch folder (`S1`, `x-s1`,
  `xd-d` … `xd-f3` for leg X's Sleep runs). Any other value refuses at the
  start. `itest:alrunner-v3` refuses observe mode when `LETHAL_V3_GATE_RECEIPT` is set (the update gate).
- **A run that throws:** its own error wins. Its codes are printed, never asserted.
- **The order:** observe, explain each code, pre-commit the set, add it to `GATE_WARNINGS` by hand, then prove it
  with one normal run. `hang/baseline` must stay equal to check 11 of `hang-baseline-leg.ts` (a unit test pins the
  two equal). A key that was never observed refuses (envtool: host-only, recorded by the owner's R683 run).
- **Server-independent sets.** The sets are proven on bc1 (plus hang on bc3) and claim to hold on every server:
  the environment codes (`package-cache-leftover`, `package-cache-dangling`, `al-runner-v3-dotnet-helper-missing`)
  are in no set. The first run of each gate on bc2 or bc3 is the check: a lane that sees a set difference there
  reports it as a BLOCK against R736/R739, and never adjusts the set.

## Control app versions

The grouped path (`RunMutantMany`, `StopHungRunAt`, `LC Op Progress`) exists only
from LethAL Control 1.0.0.17. The session keys (`testRunsBefore`, `sessionId`), the suite built once per call
and keyed by pair, and `suite-unresolved` exist only from 1.0.0.18. `ObservedActive` (whether the
active mutant's own statement was reached, per test) exists only from 1.0.0.19. The client's
minimum is `MIN_CONTROL_VERSION` in `packages/runner/src/harness.ts`. The version to publish is the
one in `extensions/lethal-control/app.json`. R-583 (merged 2026-10-21) moved the app and every
fixture to runtime 17.0, and made its runtime-17 build the minimum. `DependentCount` (R389's
closed-world guard) exists only from 1.0.0.23. `InstalledDependents` (R733: names the installed apps
that depend on the target) and the found-0 `discoveryError` / `discoveryErrorFrame` fields (R689)
exist only from 1.0.0.24, and 1.0.0.24 is the minimum: no client path falls back to an older
control app any more, so a 404 from either action is a plain failure.
