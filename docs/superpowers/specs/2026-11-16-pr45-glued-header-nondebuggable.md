# PR-45 pre-commitment: a glued object header is discovered (R1054); bcdev's no-coverage inside [NonDebuggable] is named (R1049)

Status: pre-commitment (coord PR-45, lethal-code, 2026-11-16), before the build. Neither part changes the emitted AL of any
fixture or DO's mutation set: no fixture holds `[NonDebuggable]` or a glued header (searched).

## 1. R1054: `codeunit 50100"Name"`

alc compiles a header with no whitespace between the object id and a quoted name, and the native parser parses it, but
`discovery.ts`'s header regex needs whitespace there. Discovery accepts the glued shape: by the parse where discovery already has
a tree path, else by allowing no whitespace before a quoted name (a bare name still needs whitespace: `50100Bare` is not a
header LethAL must accept). The same holds for every header reader that lists object ids.

## 2. R1049: a mutant in a `[NonDebuggable]` procedure reads no-coverage on bcdev

BC records no Code Coverage line inside a `[NonDebuggable]` procedure (PR-34, measured), so under a coverage mode other than
`none` such a mutant reads `no-coverage` though its code ran. A new caveat, `nondebuggable-no-coverage`, is raised when a run's
coverage mode is not `none` and at least one `no-coverage` mutant sits inside a procedure (or trigger) that carries
`[NonDebuggable]` (read from the parse, `attributeRun`). Its interpretation says that BC records no coverage there, so these
mutants are not shown to be untested, and that a run with `coverageMode: "none"` scores them. The console line names the count.
The ripple rules for a new `Caveat` are followed (`CAVEAT_INTERPRETATIONS`, the counts in `interpretation.test.ts` and
`report.test.ts`, the schemas). No `SessionReport` field is added.

## Predictions

1. Unit tests, red both ways:
   - a test file and a target file with a glued header are discovered (their tests found, their objects listed);
   - a bare glued name (`50100Bare`) is still not a header;
   - the caveat is raised for a no-coverage mutant inside `[NonDebuggable]` under procedure coverage;
   - it is not raised under `coverageMode: "none"`, nor for a no-coverage mutant outside such a procedure.
2. The emitted AL of a target with a glued header compiles with alc (an offline compile in the build's evidence, not a fixture).
3. The schemas gain the caveat value; every committed sample report still validates; no frozen baseline or golden moves;
   `itest:alrunner-v3` passes every leg.

## Addendum 1 (2026-11-16, after the build and its Opus review, before any gate)

- **bcdev only.** The caveat is raised only on a bcdev run. al-runner v3 covers `[NonDebuggable]` code (PR-34: all 68 Secrets
  mutants), so on v3 a `no-coverage` mutant there really is untested. A text saying otherwise would hide a real test gap.
- **No count on the console.** `renderConsole` sees only the `SessionReport`, and naming a count would need a new report field,
  with every committed sample report regenerated live. The caveat name appears in the console's `SCOPE: ... [caveats]` list and in
  `validity.caveats`; `lethal explain` gives its interpretation. The flag lives on the manifest entry (`nonDebuggable`, in the
  stream schema), not on the report's mutant rows.
- **Discovery's header regex is anchored** to the start of a line, and a quoted name stops at a line break. Unanchored, the glued
  form matched a quoted identifier ending in `codeunit <digits>` (for example `procedure "Calls Codeunit 1"()`) and refused a
  test file that loads today (R79's guard).
- **Explain schema v29.** A new caveat value bumps the explain schema version, as PR-36's did (R233).

**Predictions, added to 1:** no caveat on an al-runner v3 run with the same mutant; the quoted-identifier shape still discovers
both tests. Each is red both ways.
