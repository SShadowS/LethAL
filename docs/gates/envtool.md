# itest:envtool

`LETHAL_ITEST_ENVTOOL=1 bun run itest:envtool` runs `itest:bcdev`'s fixture on bcdev reached
through a config-declared external environment tool (Layer 6C; see `fixtures/README.md`
§"Running against an external environment tool") instead of a directly configured container. It
needs a gitignored `fixtures/sandbox-app/lethal.config.envtool.json` naming a reachable
environment. The envtool (`continia.exe`) is host-only.

## Frozen figures

```json gate-figures
{
  "gate": "itest:envtool",
  "baselines": {
    "envtool.baseline.json": { "killed": 3, "survived": 12, "no-coverage": 4 }
  },
  "notPinned": {
    "totalMutantSites": 19
  }
}
```

The number is not the point: the per-mutant table is IDENTICAL to `itest:bcdev`'s on the same day,
diffed mechanically, which is what says the indirection changes no verdict. A matching 3/12/4 would
look the same even if the indirection had changed WHICH mutants those were. This baseline is still
in the old plain-array format (recorded before R556).

## History

- **MEASURED 2026-08-28** on a restored environment, after two days in which these figures were
  INFERRED from `itest:bcdev` and must not have been quoted beside the others (R177). The
  restoration was pre-committed by identity key before it ran
  (`docs/superpowers/specs/2026-08-28-r177-envtool-restoration.md`) and returned exactly the two
  predicted additions, zero removed, zero changed. `UNVERIFIED_MOVES` was cleared in the same commit
  that re-recorded the baseline.
- **Since R197 (2026-09-02) this table and `itest:bcdev`'s can differ in `killingTest` alone.**
  Covering tests now run killer-first (kills in the same procedure this session, then fewest
  members covered, then the qualified NAME; baseline duration was a key for one day and was removed
  because it made `killingTest` differ between two runs of the same session). So where several
  tests kill one mutant, the killer depends on the order earlier mutants were scored in, which
  `--only`/`--resume` and a differing per-mutant history can change.
- The envtool baseline was NOT re-recorded on 2026-09-02 (the environment was deleted 2026-09-01).
  The next live envtool run should expect `killingTest`-only differences against its 2026-08-28
  baseline; the procedure is in CLAUDE.md.
- Both hard requirements for a replacement environment were found by hitting them: an environment
  too old to accept the control app's runtime refuses the publish, and a W1/BASE environment lacks
  the fixture's company `CRONUS Danmark A/S`, so the harness 404s AFTER the control app publishes
  fine. A brand-new environment without the bootstrapped fixture fails the tests app with
  `AL0185: Codeunit 'Sandbox Logic' is missing`.
