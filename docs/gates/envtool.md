# itest:envtool

`LETHAL_ITEST_ENVTOOL=1 bun run itest:envtool` runs `itest:bcdev`'s fixture through an external
environment tool that the config declares (Layer 6C; see `fixtures/README.md` §"Running against an
external environment tool"), instead of a container configured directly. It needs a gitignored
`fixtures/sandbox-app/lethal.config.envtool.json` that names a reachable environment. The
environment tool (`continia.exe`) runs only on the host.

## Frozen figures

```json gate-figures
{
  "gate": "itest:envtool",
  "baselines": {
    "envtool.baseline.json": { "killed": 3, "survived": 12, "no-coverage": 4 }
  },
  "constants": {
    "ENVTOOL_FIGURES.totalMutantSites": 19,
    "ENVTOOL_FIGURES.killed": 3,
    "ENVTOOL_FIGURES.survived": 12,
    "ENVTOOL_FIGURES.noCoverage": 4
  }
}
```

The counts are not the point. What matters is that the table, mutant by mutant, is identical to
`itest:bcdev`'s from the same day, compared by a script. That is what shows the indirection
changes no verdict. A matching 3 / 12 / 4 would look the same even if the indirection had changed
which mutants those were. This baseline is still in the old plain-list format (recorded before
R556).

## History

- The figures were measured on 2026-08-28, on a restored environment. For the two days before,
  they had been inferred from `itest:bcdev` and quoted as if measured; that was wrong (R177). The
  restoration was pre-committed by identity key before it ran
  (`docs/superpowers/specs/2026-08-28-r177-envtool-restoration.md`). It returned exactly the two
  predicted additions, with none removed and none changed. `UNVERIFIED_MOVES` was cleared in the
  same commit that re-recorded the baseline.
- Since R197 (2026-09-02), this table and `itest:bcdev`'s can differ in `killingTest` only.
  Covering tests now run killer-first. The order is: tests that killed in the same procedure this
  session, then the test covering the fewest members, then the qualified name. (Baseline duration
  was a key for one day. It was removed because it made `killingTest` differ between two runs of
  the same session.) So when several tests kill one mutant, which one is recorded depends on the
  order earlier mutants were scored in. `--only`, `--resume` and a different per-mutant history
  can change that order.
- The baseline was not re-recorded on 2026-09-02, because the environment had been deleted on
  2026-09-01. The next live run should expect differences in `killingTest` only, against the
  2026-08-28 baseline. CLAUDE.md gives the procedure.
- Both hard requirements for a replacement environment were found by hitting them. An environment
  too old for the control app's runtime refuses the publish. A W1 or BASE environment lacks the
  fixture's company, `CRONUS Danmark A/S`, so the harness returns 404 after the control app has
  published without error. A brand-new environment without the fixture published once by hand
  fails the tests app with `AL0185: Codeunit 'Sandbox Logic' is missing`.
