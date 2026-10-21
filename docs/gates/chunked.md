# itest:chunked

`LETHAL_ITEST_CHUNKED=1 bun run itest:chunked` is R208's gate for the CHUNKED group path, which every
other gate is blind to because they all run a mutant's covering tests in ONE call. Two legs over
`fixtures/sandbox-data --only src/DataMain.Table.al` (the only file whose kills reach ordered
position 5), one unbounded (the control) and one at `--max-methods-per-call 2`, about 95 s. It uses
`itest:tables`' connection. It has no baseline file: its figures live only in `chunked.itest.ts`.

## Frozen figures

```json gate-figures
{
  "gate": "itest:chunked",
  "baselines": {},
  "notPinned": {
    "control": { "killed": 17, "survived": 7, "no-coverage": 2, "warmKills": 9, "groupedCalls": 33,
      "killPositionHistogram": { "1": 8, "2": 3, "3": 3, "4": 2, "5": 1 } },
    "chunked": { "killed": 17, "survived": 7, "no-coverage": 2, "warmKills": 5, "groupedCalls": 57 }
  }
}
```

- Both legs have every verdict AND `killingTest` identical: chunking is a cost knob, never a
  semantic one.
- Four named kills go warm to cold, and five replay exactly their chunk's two methods.
- RED-CHECKED: taking `groupPosition` + `chunkPrefix` from `ordered` instead of the chunk fails
  ONLY here (warmKills 9, groupedCalls 61) with the verdict differential still green, which is the
  whole reason the gate exists.
- The control was MEASURED 2026-09-04; the chunked figures were DERIVED from it before the chunked
  leg ran.
