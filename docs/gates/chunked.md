# itest:chunked

`LETHAL_ITEST_CHUNKED=1 bun run itest:chunked` is R208's gate. It tests the chunked group path:
a mutant's covering tests split over several calls. Every other gate runs a mutant's covering
tests in one call, so none of them can see this path.

It runs two legs over `fixtures/sandbox-data --only src/DataMain.Table.al`, the only file whose
kills reach ordered position 5. The control leg has no limit. The chunked leg runs with
`--max-methods-per-call 2`. It takes about 95 s and uses `itest:tables`' connection
(the config in `fixtures/sandbox-data/` that `LETHAL_ITEST_CONFIG` names; see
[servers.md](servers.md)). On 2026-10-21 it passed on `bc2`, both legs equal to the figures below
(R-583).

## Frozen figures

```json gate-figures
{
  "gate": "itest:chunked",
  "baselines": {},
  "noBaseline": "The gate compares its two legs with each other and with the figures below; it records no per-mutant baseline file.",
  "constants": {
    "CHUNKED_FIGURES.control.killed": 17,
    "CHUNKED_FIGURES.control.survived": 7,
    "CHUNKED_FIGURES.control.noCoverage": 2,
    "CHUNKED_FIGURES.control.warmKills": 9,
    "CHUNKED_FIGURES.control.groupedCalls": 42,
    "CHUNKED_FIGURES.control.positions": { "1": 8, "2": 3, "3": 3, "4": 2, "5": 1 },
    "CHUNKED_FIGURES.chunked.warmKills": 5,
    "CHUNKED_FIGURES.chunked.groupedCalls": 62
  }
}
```

- Both legs score 17 / 7 / 2, with every verdict and every `killingTest` identical. Chunking
  changes cost only, never a result.
- The control leg has 9 warm kills and 42 group calls: 17 + 7 scored, 9 replays and 9 re-runs.
  Its 17 kills sit at positions 1 to 5 as the histogram shows.
- The chunked leg has 5 warm kills and 62 group calls: 52 covering chunk calls, 5 replays and
  5 re-runs. Four named kills go from warm to cold. Five replay exactly the two methods of their
  chunk.
- Since R582 every kill is re-run once under the mutant after its confirm passed (R577's rule).
  A warm kill's re-run is one more group call over the same chunk prefix as its replay. The gate
  keeps those rows apart from the covering calls (`itest/chunked-rows.ts`), so they never count
  toward the cap check, and it asserts that each of the five warm kills' re-run lists EQUALS its
  replay list. A cold kill's re-run is a single call and writes no group rows.
- The control figures were measured on 2026-09-04. The chunked figures were derived from them
  before the chunked leg first ran.

## History

Red-checked: taking `groupPosition` and `chunkPrefix` from the ordered list instead of the chunk
fails only this gate (warmKills 9, groupedCalls 61), while the verdict comparison stays green.
That is the whole reason the gate exists. Those were the figures before R582, when the control
leg made 33 group calls and the chunked leg 57.

R582 added the re-runs: control 33 to 42, chunked 57 to 62, no verdict moved
(`docs/superpowers/specs/2026-10-22-r582-bcdev-kill-reproduction-precommitment.md`).
