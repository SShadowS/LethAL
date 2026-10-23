# itest:bcdev-names

`LETHAL_ITEST_BCDEV=1 bun run itest:bcdev-names` runs `fixtures/sandbox-names` with
`fixtures/sandbox-names-tests` on `itest:bcdev`'s connection: the config in `fixtures/sandbox-app/`
that `LETHAL_ITEST_CONFIG` names (`CONNECTION_DIR` in the itest; see [servers.md](servers.md)). It
runs one fenced leg. It is kept out of `itest:bcdev` so that gate's figures cannot move with it. On
2026-10-21 it passed on `bc1` under R-583's runtime-17 fixtures (R-583).

The suite has 12 tests. Each is the only test that kills its procedure. The .NET al-runner renamed
10 of the test names: they contain a space, `-`, `()`, `.`, `/`, `&`, a leading digit, the unquoted
keyword `Default`, or Danish letters. The other 2 are controls that are not renamed. This leg is
the first live evidence for non-ASCII and special-character test names in BC's
`Test Method Line`. The same table ran on the .NET al-runner until R654 retired it; see
[alrunner.md](alrunner.md), "Names legs" (history). On the Rust al-runner the quoted names cannot
be selected (upstream #5572), so its gate checks this fixture only as leg N1
([alrunner-v3.md](alrunner-v3.md)).
Since R582 each of the 36 kills is re-run once under the mutant (R577's rule), with the same
`RunMutant` request shape as its cold confirm, and must carry `killReproduced` and exactly 2
mutated rows for its killing test.

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

R557 (from the owner-approved CLAUDE.md proposal in `/coord/handoff/R-557/`): recorded per
pre-commitment r4 (2026-10-20), committed in b7aa3f1e, on Cronus28 (record run exit 3, confirm run PASS). The bcdev and
al-runner names baselines are byte-identical. The al-runner side was red-checked: with the name
builder from before R557, it reads 6 killed and 30 survived under coverage `none`, and 6 killed
and 30 no-coverage under coverage `al-runner`. (`al-runner.names.baseline.json` was deleted with the
.NET al-runner in R654 S3, 2026-10-22.)
