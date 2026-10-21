# itest:bcdev

`LETHAL_ITEST_BCDEV=1 bun run itest:bcdev` runs `fixtures/sandbox-app` + `fixtures/sandbox-tests`
on a BC container through the bcdev backend, the **authoritative** backend: its verdicts are the
reference the other backends are compared with. Connection: the gitignored
`fixtures/sandbox-app/lethal.config.local.json` and `.vscode/launch.local.json`.

## Frozen figures

```json gate-figures
{
  "gate": "itest:bcdev",
  "baselines": {
    "bcdev.baseline.json": { "killed": 3, "survived": 12, "no-coverage": 4 }
  },
  "notPinned": {
    "totalMutantSites": 19,
    "groupedCalls": 15,
    "warmKills": 0,
    "killPositionOfEveryKill": 1,
    "sessionReusedRows": 0,
    "assertionScreenDiscrimination": "vacuous"
  }
}
```

What each means:

- **3 / 12 / 4** over 19: killed / survived / no-coverage.
- **`groupedCalls` 15** (since R198): one `RunMutantMany` call per scored mutant (3 + 12). A counter
  that stopped being wired reads 0 and fails the gate.
- **`warmKills` 0** (since R206): every kill is at `killPosition` 1, there are zero
  `session-reused` rows, and the gate runs a store-level session-id liveness check (distinct session
  ids among grouped rows equal the group calls that answered).
- **`assertionScreen.discrimination` `vacuous`** (since R132): this suite raises only through bare
  `Error(...)`, so R121's assertion screen flags every kill and separates nothing. This is the half
  that `itest:tables` gave up when its fixture gained an assertion arm (see [tables.md](tables.md)).

## History

- R161 (2026-08-19) re-ran this gate after adding guard-clause mutants elsewhere: unchanged at the
  time's 3/10/3; `sandbox-app` gains no sites from that operator, measured.
- R193/R197 (2026-09-02) re-recorded the baseline (identity ordinals for twins; covering tests tried
  killer-first).
- R220 and later moves of the al-runner gate are compared PER MUTANT with this gate's table; see
  [alrunner.md](alrunner.md).
- R589 (2026-10-21): the BC on Linux servers `bc1`-`bc3` may carry this gate once its figures
  reproduce per mutant there; see CLAUDE.md §"Environment".
