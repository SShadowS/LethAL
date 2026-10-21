# itest:bcdev-names

`LETHAL_ITEST_BCDEV=1 bun run itest:bcdev-names` runs `fixtures/sandbox-names` +
`fixtures/sandbox-names-tests` on `itest:bcdev`'s container (same config files), fenced, one leg.
It is kept out of `itest:bcdev` so that gate's 3 / 12 / 4 cannot move with it.

The suite has 12 tests, each the ONLY killer of its procedure. al-runner renames 10 of their AL
names (space, `-`, `()`, `.`, `/`, `&`, a leading digit, the unquoted keyword `Default`, Danish
letters); 2 are unrenamed controls. This leg is the first live evidence for non-ASCII and
special-character test names in BC's `Test Method Line`. The same table runs on al-runner; see
[alrunner.md](alrunner.md) §"names legs".

## Frozen figures

```json gate-figures
{
  "gate": "itest:bcdev-names",
  "baselines": {
    "bcdev.names.baseline.json": { "killed": 36 }
  },
  "constants": {
    "NAMES_TABLE.length": 12
  }
}
```

Per mutant against `docs/superpowers/specs/2026-10-09-r557-names-precommitment.md` (verdict and
killing test).

## History

R557 (from the owner-approved CLAUDE.md proposal, `/coord/handoff/R-557/claude-md-proposal.md`):
recorded 2026-10-20 per pre-commitment r4 on Cronus28 (record exit 3, confirm PASS). The bcdev and
al-runner names baselines are byte-identical. RED-CHECKED on the al-runner side: on the pre-R557 name
builder it reads 6 / 30 / 0 (coverage none) and 6 / 0 / 30 (coverage al-runner).
