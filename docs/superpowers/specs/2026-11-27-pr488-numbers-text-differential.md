# PR-488: numbers and text builtins as a generated BC differential — pre-commitment r1

lethal-code, 2026-11-27. Written before code. Method: PR-487's (`scripts/refusal-family.ts`).

## Family `numbers-text`
- **Where:** appended after `errors-temp` (BC-check number 30). Cell i is codeunit 51001+i.
- **Each cell:** reports one value through `Error('V:[%1]', ...)`, or fails with the runtime's own error.
- **Numbers:** always read through `Format(x, 0, 9)`. Format and Evaluate are used only with format 9 (R1210).
- **Groups:**
  - **Round:** precision; the `=`, `<` and `>` directions; negative halves; a precision of 0 or an invalid direction.
  - **Decimal:** precision (1/3*3, 0.1+0.2); `Power` (fractional, a negative base, 0^0); `Abs`.
  - **Integer arithmetic:** `div`/`mod` with negative operands; divide by zero (Integer and Decimal); Integer and
    BigInteger overflow; Integer `/` giving a Decimal.
  - **Duration:** arithmetic (`*`, `/`, a negative value) read with format 9.
  - **IncStr:** empty; no digit; all 9s; leading zeros; a digit inside; the Increment overload with a negative step.
  - **Text edges in ASCII:**
    - `CopyStr`, `PadStr`, `DelStr` and `InsStr` at 0, negative and past-the-end positions or lengths;
    - `SelectStr` out of range, empty fields and a trailing comma;
    - `ConvertStr` with unequal lengths;
    - `DelChr`'s where-forms;
    - the text-length overflow on assignment;
    - Code's trimming and upper-casing;
    - a surrogate pair in StrLen and CopyStr.
  - **StrSubstNo:** a missing argument, extra arguments, `%%`, `%10`, `#1####` fields, a repeated `%1`. Text arguments
    only, so no answer depends on culture.
  - **Case on non-ASCII beyond Danish** (json-text has the Danish cells): ß, Turkish İ and ı, ǆ, ﬁ, Σ. These are
    marked `depends: "locale"`: a difference is Linux-BC culture data, not filed unless Windows BC agrees (R1210).
  - **R1236's cheap follow-ups:**
    - the nested-asserterror text (is the NavNCLAssertErrorException prefix visible to AL);
    - ErrorType and Verbosity through `.AsInteger()`;
    - one collected error counted before the scope ends;
    - whether a successful `Codeunit.Run` clears the last error.

## Runs, compare and filing
- al-runner `current` (edge-e5176a9fd), then a leased bc1-bc3. Clean up after; doctor before and after; release only
  when healthy.
- `--join` per cell.
- One upstream issue per class where al-runner differs (a wrong answer or a refusal), under the standing yes. Not filed:
  locale cells, and text-only differences no AL test can observe.
- An R item records the tally.

## Tests
- Place and id; the cell count; distinct names.
- Every Format in a cell is `Format(x, 0, 9)`.
- Exactly the case cells are `depends: "locale"`.
- The pinned app hash.
- A red check for each guard.
