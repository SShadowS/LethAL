# R747 pre-commitment: per-object judging of `fenced-coverage-no-procedure-lines` moves no gate

Coord task R-747, lane lethal-code, branch `lethal/r747`. Committed to master BEFORE any observe run on the branch.

## The change
- `fenced-coverage-no-procedure-lines` is judged per declared, non-refused object. It fires for an object that has a
  naming gap in a test and no member row in that test.
- LethAL's selector codeunit, whose `Active` row names a member in nearly every test, no longer masks a shifted
  target object.
- Warning-only: attribution (`entries`, `namingGaps`) is unchanged.
- The other branches (no-object-rows, all-refused) are unchanged.

## Prediction: no pinned warning set moves
Observed in observe mode on the branch head, then proven in normal mode. These are every leg that reads fenced
coverage (fenced is the default; baseline runs read it). The legs of each gate are as R736/R739/R746 pinned them.
- bc1:
  - `bcdev/first`, `bcdev/second`;
  - `bcdev-names/fenced`;
  - `bcdev-wrapped/fenced`, plus `bcdev-wrapped/hub` (procedure mode, also unchanged);
  - `tables/first`, `tables/second`;
  - `chunked/control`, `chunked/chunked`;
  - `harden/a`, `harden/b`;
  - `lend/L0`, `L1`, `N0`, `N1`, `N5` (plus the legs that reuse a baseline, unchanged);
  - `verify/run`, `verify/step3`, `verify/step4`, `verify/step4b`;
  - `testapp/run`, `testapp/step6`, `testapp/step7`;
  - `agreement/a`, `agreement/b`, `agreement/verify`, `agreement/named`.
- bc3: `hang/on`, `hang/single`, `hang/baseline`, `hang/off`.
- al-runner-v3: unaffected (no fenced bcdev coverage); every set unchanged.

**Why no move is expected.**
- R175 records that no gated fixture reproduces a naming gap.
- The wrapped fixture's page, report and pageextension frames were measured (R536, R545, R550).
- R746's measurement shows chunked's only firing was trigger-only coverage.

**Any emission of `fenced-coverage-no-procedure-lines` on these legs is reported to the orchestrator BEFORE it is
explained or pinned.** One that is a real frame fault is a BLOCK. Every frozen per-mutant figure is unchanged.

## Blind spots (in R747)
- An object with member rows plus gap rows stays quiet. That is the likeliest real 1-2 line shift; it has its own
  item.
- An R318 renamed split member with no coverage name could warn with a false frame blame (the symbols fixture is
  run by v3 only).
- Rows on report/page expression lines are unmeasured on real projects.
