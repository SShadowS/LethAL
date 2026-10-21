# itest:bcdev-names

`LETHAL_ITEST_BCDEV=1 bun run itest:bcdev-names` runs `fixtures/sandbox-names` with
`fixtures/sandbox-names-tests` on `itest:bcdev`'s connection (the same config files). It runs one
fenced leg. It is kept out of `itest:bcdev` so that gate's figures cannot move with it.

The suite has 12 tests. Each is the only test that kills its procedure. al-runner renames 10 of
the test names: they contain a space, `-`, `()`, `.`, `/`, `&`, a leading digit, the unquoted
keyword `Default`, or Danish letters. The other 2 are controls that are not renamed. This leg is
the first live evidence for non-ASCII and special-character test names in BC's
`Test Method Line`. The same table runs on al-runner; see [alrunner.md](alrunner.md), "Names legs".

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

All 36 mutants are killed (3 operators on each of 12 procedures). Each must match
`docs/superpowers/specs/2026-10-09-r557-names-precommitment.md` in verdict and killing test.

## History

R557 (from the owner-approved CLAUDE.md proposal in `/coord/handoff/R-557/`): recorded on
2026-10-20 per pre-commitment r4, on Cronus28 (record run exit 3, confirm run PASS). The bcdev and
al-runner names baselines are byte-identical. The al-runner side was red-checked: with the name
builder from before R557, it reads 6 killed and 30 survived under coverage `none`, and 6 killed
and 30 no-coverage under coverage `al-runner`.
