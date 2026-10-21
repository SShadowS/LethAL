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
    "CHUNKED_FIGURES.control.groupedCalls": 33,
    "CHUNKED_FIGURES.control.positions": { "1": 8, "2": 3, "3": 3, "4": 2, "5": 1 },
    "CHUNKED_FIGURES.chunked.warmKills": 5,
    "CHUNKED_FIGURES.chunked.groupedCalls": 57
  }
}
```

- Both legs score 17 / 7 / 2, with every verdict and every `killingTest` identical. Chunking
  changes cost only, never a result.
- The control leg has 9 warm kills and 33 group calls. Its 17 kills sit at positions 1 to 5 as
  the histogram shows.
- The chunked leg has 5 warm kills and 57 group calls. Four named kills go from warm to cold.
  Five replay exactly the two methods of their chunk.
- The control figures were measured on 2026-09-04. The chunked figures were derived from them
  before the chunked leg first ran.

## History

Red-checked: taking `groupPosition` and `chunkPrefix` from the ordered list instead of the chunk
fails only this gate (warmKills 9, groupedCalls 61), while the verdict comparison stays green.
That is the whole reason the gate exists.
