# Run-cost benchmarks

`runs.jsonl` is an append-only ledger of what LethAL runs actually cost. It exists because a
mutation run's wall clock is meaningless on its own: the two questions worth asking are "what
would the full mutant set cost" and "did this get slower", and neither can be answered from a
single number taken once.

Written by `scripts/bench-record.ts`:

```sh
bun scripts/bench-record.ts add --report out.json --label do-one-codeunit \
    --phase env-create --phase-ms 191000 --phase-ms ...
bun scripts/bench-record.ts list --label do-one-codeunit
bun scripts/bench-record.ts compare --label do-one-codeunit   # newest two
```

## Why the phases are separate

`SessionReport.timings` splits a run into `generate`, `deploy`, `baseline` and `mutants` because
those scale on **different axes**:

- `deploy` scales with PROJECT size — every file compiles and the whole app publishes, whether or
  not it was mutated. A `--only` run over 163 mutants pays very nearly the same deploy as a run
  over 11,777.
- `mutants` scales with MUTANT count.
- `baseline` is a fixed per-batch toll, set by the test count.
- Whatever is left of `totalMs` is orchestration overhead — activation, lease renewals, coverage
  filtering, store writes. A rise there with the other three flat is the signature of a fencing or
  lease regression, and no verdict count would show it.

Extrapolating a bigger run means holding the first three fixed and multiplying only the
per-mutant term. A recorded total alone cannot be extrapolated at all.

`externalPhasesMs` holds costs measured OUTSIDE the runner — environment provisioning,
prerequisite publishing. Deliberately apart from `timings`: folding a 191 s environment create
into a mutation-run total would make the run look slow and poison every later comparison.

## Measured setup costs (2026-07-27, hosted Continia BC 28 DK environment)

Not run costs — the price of getting a real product app onto a fresh hosted environment. Recorded
because they dominated a first trial and are the numbers to plan against.

| phase | measured |
|---|---|
| `env create` → `Running` | **191 s** (the Layer-6C spec recorded 390 s for the same shape) |
| install 11 prerequisite apps (`deps install`) | **218 s** |
| download symbol closure (21 packages) | ~2 s |
| instrument 551 `.al` files (parse + spec generation) | **2.7 s** |
| write 162 instrumented files | **1.5 s** |
| `alc` compile, 11,777 guards, 8.9 MB artifact | **~12 s** |
| publish 8.9 MB app to the hosted environment | **failed at a ~300 s gateway cap** — see R44 |

The instrumentation itself is not the cost. Deploy is, and on a hosted environment it is the part
that decides whether a real project is runnable at all.

## Reading a row

`scope.onlyPatterns` records the `--only` narrowing. A narrowed run's score describes the slice it
covered, never the project — the same reason `SessionReport.only` exists. Comparing a narrowed run
against an unnarrowed one is comparing different questions; `compare` prints the mutant counts
side by side so that mismatch is visible rather than implied.

`compare` flags `VERDICTS DIFFER` when killed/survived move between runs. On the same target and
commit that is a correctness regression, not a performance one, and it outranks any timing change
in the same output.
