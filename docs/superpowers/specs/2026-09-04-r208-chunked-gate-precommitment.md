# Pre-commitment: the chunked-path gate (R208), written before the chunked leg runs

R208 says the chunked group path (`--max-methods-per-call`) has no live gate, and that under R206
a chunked replay is the one place where `chunkPrefix` versus `ordered` is verdict-bearing. This
file fixes every number the new gate will pin, BEFORE that leg has ever run, so a number that comes
out wrong is a finding and not an edit.

## The slice, and why this one

`fixtures/sandbox-data`, narrowed to `--only src/DataMain.Table.al`: 26 mutants, 24 scored, and
covering sets up to 7 tests, which is the only file in the fixture whose kills reach ordered
position 5. Everything else is one or two covering tests, where chunking at 2 changes nothing.
Measured cost: **46 s** per leg, so a two-leg gate is about 95 s.

## The unchunked control, MEASURED 2026-09-04 (not predicted)

`lethal run --only src/DataMain.Table.al` with default (unbounded) chunking:

- 26 mutants: **17 killed, 7 survived, 2 no-coverage, 0 errors**.
- `groupedCalls` **33** = 24 scored mutants, one covering call each, plus **9** warm-kill replays.
- `warmKills` **9**. Kill positions: 8 at 1, 3 at 2, 3 at 3, 2 at 4, 1 at 5.

## The chunked leg, PREDICTED (`--max-methods-per-call 2`)

Derived mechanically from the control: chunking splits the SAME `ordered` list (the kill ledger
and the baseline member counts are unchanged, so the order per mutant is unchanged) into calls of
at most two, so a killer at ordered position `p` lands in chunk `ceil(p/2)` at chunk position
`((p-1) mod 2) + 1`, and `killPosition` is that chunk position because it is CALL-relative.

- **Every verdict and every `killingTest` identical to the control.** 17 killed, 7 survived,
  2 no-coverage, **0 errors**. A moved verdict is the finding this gate exists to catch.
- **`warmKills` 5**, down from 9: chunking makes four of the control's warm kills COLD.
- **`groupedCalls` 57** = 52 covering calls + 5 replays.

### The five that stay warm, and the replay each must run

The replay is the CHUNK's prefix. For all five that is exactly two methods; `ordered`'s prefix
would be two or four, and for the last two it would be FOUR — a different session state than the
mutated call had, which is the disagreement R208 names.

| mutant | line | operator | killer | ordered pos | `killPosition` | replay (exactly) |
|---|---|---|---|---|---|---|
| M0007 | 31 | `empty-block` | `CategoryGuardNeedsCalcFields` | 2 | 2 | `BlankNoValidateFails`, `CategoryGuardNeedsCalcFields` |
| M0008 | 47 | `remove-calcfields` | `CategoryGuardNeedsCalcFields` | 2 | 2 | `BlankNoValidateFails`, `CategoryGuardNeedsCalcFields` |
| M0010 | 49 | `void-method-call` | `CategoryGuardNeedsCalcFields` | 2 | 2 | `BlankNoValidateFails`, `CategoryGuardNeedsCalcFields` |
| **M0015** | 69 | `empty-block` | `FlaggedFiresModifyTrigger` | **4** | **2** | **`ProcessedRequiresCategory`, `FlaggedFiresModifyTrigger`** |
| **M0016** | 75 | `swap-modify-flag` | `FlaggedFiresModifyTrigger` | **4** | **2** | **`ProcessedRequiresCategory`, `FlaggedFiresModifyTrigger`** |

M0015 and M0016 are the load-bearing rows: unchunked their replay is four methods, chunked it must
be two, and the two lists start at a different test. An implementation that replayed `ordered`'s
prefix passes every existing gate and fails only here.

### The four that go from WARM to COLD

Chunking moves these killers to the head of their chunk, so they are confirmed by today's cold
single-test rerun and write NO replay rows.

| mutant | line | operator | ordered pos | chunk | `killPosition` |
|---|---|---|---|---|---|
| M0011 | 55 | `empty-block` | 5 | 3 | 1 |
| M0012 | 62 | `remove-testfield` | 3 | 2 | 1 |
| M0017 | 75 | `void-method-call` | 3 | 2 | 1 |
| M0020 | 104 | `empty-block` | 3 | 2 | 1 |

## What the gate asserts

1. Both legs score the same 26 mutants with the same verdict AND the same `killingTest`
   (the differential R198 §7 wanted and never got).
2. Unchunked: `warmKills` 9, `groupedCalls` 33, the position histogram above.
3. Chunked: `warmKills` 5, `groupedCalls` 57, every `killPosition` as tabled.
4. **For each of the five warm mutants, the replay rows recorded for it (`mutant_code IS NULL`,
   `op_kind = 'many'`) are exactly the two methods named above, in order.** This is the assertion
   that fails if a replay is built from `ordered` instead of the chunk.
5. Chunked: no call ran more than two methods.
6. Zero `session-reused`, zero `warm-*` causes, in both legs.

## What refuses this

Any verdict or `killingTest` differing between the legs; any `killPosition` differing from the
table; any replay list that is not exactly its chunk's prefix; `warmKills` or `groupedCalls` off.
