# R-300b probe: how BC and al-runner number a `#if`-wrapped object's lines

Status: **designed and compiled offline, 2026-10-06. Not run.** The pre-commitment is
`/coord/handoff/R-300b/precommitment.md` (written before any run; add results here, never edit it).

- `target/`: "LethAL R300b Probe Target" 1.0.0.0, ids 91900-91929, `preprocessorSymbols: ["PROBESYM"]`.
  W1 (wrapped, one arm, namespace inside), C1 (its unwrapped control, same file lines),
  E1 (two arms, the `#else` arm compiled, an inner `#if` block), M1 (P bare, Q wrapped with an
  inactive `#else` arm, R bare after the wrapper).
- `tests/`: "LethAL R300b Probe Tests" 1.0.0.0, ids 91930-91949. `R300b Reach` (91930) passes;
  `R300b Fence` (91931) reads BC's `Code Coverage` table itself and FAILS BY DESIGN (the failure text
  is the measurement).
- `hyp.ts predict` prints each hypothesis's lines from the source; `hyp.ts classify` reads `out/`.
- `run-alrunner.ts dry|oneshot|server <round>`: the al-runner legs, no BC needed.
- `out/`: compiled apps and raw outputs (`*.app` is gitignored; do not commit outputs).

## Build (offline, kraken container)

```bash
cd scripts/r300b-probe
PC=/work/lethal/extensions/lethal-control/.alpackages
$LETHAL_ALC_DIR/alc /project:target /packagecachepath:$PC /out:out/target.app
$LETHAL_ALC_DIR/alc /project:tests "/packagecachepath:$PC;out" /out:out/tests.app
```

Both end with 0 errors and 0 warnings (measured 2026-10-06, alc 18.0.43.1464).
