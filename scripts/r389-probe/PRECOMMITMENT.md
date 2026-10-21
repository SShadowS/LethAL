# R389 probe: pre-commitment (written 2026-10-04, BEFORE any live run)

Roadmap item: `docs/roadmap/R389.md`. Plan: `/coord/handoff/R-389/2026-10-04-R-389-variant-interface-reach.md`,
open question 2.

## The question

Can code in ANOTHER app (here called "external code") run a test-app codeunit that it receives in
a Variant? External code cannot name any test-app object, so the question is which routes BC
leaves open for it.

If no route that avoids test-app code can run the codeunit, R389 can close as a ruling with no
code. If any such route runs it, the plan's safe build (fold the codeunit, or fall back) is needed
and goes to review.

## Setup

- `external/` = "LethAL R389 Probe External" (ids 91500-91529, no tables). It declares interface
  `R389 Probe Iface` (one procedure, `Ping`), an UNRELATED codeunit `R389 Probe Helper` (91501),
  and `R389 Probe Routes` (91502), one procedure per route, each taking the Variant. No loops.
- `tests/` = "LethAL R389 Probe Tests" (ids 91530-91559, depends on the external app).
  `R389 Probe Mock` (91530) implements the external interface. Its `Ping` and its `OnRun` both
  raise `MARK R389 ran the TEST-APP mock ...`. No other object says MARK.
  `R389 Probe Subscriber` (91531) is R3's event subscriber. `R389 Probe Tests` (91532) has one
  `[Test]` per route.
- Every test is EXPECTED TO FAIL. The failure text is the measurement:
  - `MARK R389 ran ...`: the test-app mock ran. The route CAN run test-app code.
  - `MEASURED ...`: the route returned or reported without running the mock.
  - any other text: a platform error. The route is refused at run time. Recorded verbatim.
- The Variant is built two ways: from the mock codeunit variable (`V := Mock`, "FromCodeunit"),
  and through an interface variable (`I := Mock; V := I`, "FromIface"). These are the two shapes
  the R-389 walk would have to trace.

## Compile results (MEASURED now, offline)

alc 18.0.41.45789 (AL extension 18.0.2732683, Linux), runtime 16.0, System symbols 28.0.47067.0
(`fixtures/sandbox-hang-tests/.alpackages`). Both apps compile with 0 errors and 0 warnings as
they now stand. The routes that did not compile were moved to `refused/R1-implicit.al.txt` with
their diagnostics:

| Route | Shape (in the external app) | Compiles? | Diagnostic |
|---|---|---|---|
| R1a | `I := V` (Variant to own interface, implicit) | **no** | AL0122: Cannot implicitly convert type 'Variant' to 'Interface ..."R389 Probe Iface"'. Use an explicit conversion or change the type. |
| R1b | `C0_CallIface(V)` (Variant into an interface parameter) | **no** | AL0133: Argument 1: cannot convert from 'Variant' to 'Interface ..."R389 Probe Iface"' |
| R1c | `I := V as "R389 Probe Iface"` | **YES** | (none) |
| R1d | `if V is "R389 Probe Iface" then I := V as ...` | **YES** | (none) |
| R2a | `Codeunit.Run(V)` (Variant where the id goes) | yes | (none; Variant converts to Integer at compile time) |
| R2b | `if V.IsCodeunit() then Codeunit.Run(V)` | yes | (none) |
| R2c | `if Codeunit.Run(V) then ...` (catching form) | yes | (none) |
| R2d | `Codeunit.Run(Codeunit::"R389 Probe Helper", V)` (Variant in the record slot) | yes | (none) |
| R3 | event `OnR389HandBack(V)`; a TEST-APP subscriber does `Mock := V; Mock.Ping(...)` | yes | (none) |
| R4a | `C := V` with `C: Codeunit "R389 Probe Helper"` (unrelated type), then `C.Echo(...)` | yes | (none) |
| R4b | same, then `C.Run()` | yes | (none) |
| R4c | `Format(V)` | yes | (none) |
| R4d | `Evaluate(Id, Format(V)); Codeunit.Run(Id)` | yes | (none) |
| R4e | `RecRef.GetTable(V)` | yes | (none) |
| R4f | `W := V`, then R1c on `W` | yes | (none) |
| R4g | `V.IsInterface()` | **no** | AL0132: 'Variant' does not contain a definition for 'IsInterface' |
| R4h | `C := V; I := C as "R389 Probe Iface"` (cast a Codeunit variable) | **no** | AL0851: The type 'Codeunit' doesn't support casting. |
| R4i | `C := V; I := C` (Helper does not implement the interface) | **no** | AL0122 (Codeunit to Interface). Expected; listed for completeness. |
| S1 | `Codeunit.Run(Id: Integer)` (side observation, no Variant) | yes | (none) |

Test-app side, also measured: `V := I` (an Interface variable assigned into a Variant) compiles.
So the plan's class "bi" is a real, compilable shape.

**The compile step already answers part of the question, and not in the closing direction.** The
implicit interface routes are refused, but the explicit cast `V as <interface>` (and the type test
`V is <interface>`) compile in external code. Whether they work at run time is phase 2.

## Expected run-time outcomes (each with its reason)

| Test | Expected failure text | Why |
|---|---|---|
| C0_IfaceDirect | `MARK ... via C0` | Positive control. An interface call into the mock must run it, or the MARK is not what the other routes would show. If C0 does not MARK, the whole run is void. |
| R1c_As_FromIface | `MARK ... via R1c` | `as` on a Variant that holds an interface value is the documented use of the cast. BC checks at run time that the held object implements the interface; the mock does. |
| R1c_As_FromCodeunit | `MARK ... via R1c` (less sure) | The Variant holds a codeunit instance, not an interface value. I expect BC to check "does the held codeunit implement it" and accept. The alternative is a run-time conversion error. |
| R1d_IsThenAs_FromIface / _FromCodeunit | `MARK ... via R1d` | As R1c; `is` should say true. If `is` says false for FromCodeunit, that is recorded as `MEASURED R1d ... = false`. |
| R1d_Control_Integer | `MEASURED R1d (V is ...) = false` | Negative control: an Integer implements nothing. |
| R1d_Control_NonImplementer | `MEASURED R1d (V is ...) = false` | Negative control: a codeunit that does not implement the interface. If this says true, `is` is not a type test and R1d's result is void. |
| R2a_RunVariantAsId | a platform conversion error (Variant holding a codeunit to Integer), no MARK | `Codeunit.Run` takes an id; the Variant does not hold an Integer. |
| R2b_..._FromCodeunit | `IsCodeunit` true, then the R2a error | Same conversion. |
| R2b_..._FromIface | unknown: either `MEASURED R2b V.IsCodeunit = false` or the R2a error | Whether a Variant holding an interface value reports IsCodeunit is not known. Recorded either way; it does not decide the question. |
| R2c_RunVariantTry | the R2a error, uncaught (no MEASURED) | The conversion happens while the argument is evaluated, before `Codeunit.Run` can catch anything. If it IS caught, text starts `MEASURED R2c ... returned false:`. |
| R2d_RunWithVariantAsRecord | a platform error about the record argument, or `MEASURED ran the EXTERNAL helper OnRun`; no MARK | The id names the external helper, so even if BC accepts the Variant, only the helper can run. |
| R3_HandBackByEvent | `MARK ... via R3 (test-app subscriber)` | Control: test-app code can name the mock's type. The walk already folds every subscriber. |
| R4a_UnrelatedCodeunitVar | a platform type-mismatch error at `C := V`, no MARK | A Codeunit variable has a fixed type. If BC accepts the assignment, the text tells which object `Echo` reached; a MARK there would be a surprise. |
| R4b_UnrelatedCodeunitVarRun | the R4a error at `C := V`, no MARK | **The risky one.** If BC accepts the assignment without a type check, `C.Run()` could run the MOCK's `OnRun` and print MARK. |
| R4c_Format_* | `MEASURED R4c Format(V) = [...]` with some text (a name, an id, or empty) | Format runs nothing. The text matters only for R4d. |
| R4d_FormatEvaluateRun | `MEASURED R4d ... does not evaluate to an Integer` | Expected: Format gives a name or empty, not a number. If it gives the id, `Codeunit.Run(id)` runs the mock (MARK), which is S1's route reached from a Variant. |
| R4e_RecordRefGetTable | a platform error (not a record), no MARK | `GetTable` needs a record. |
| R4f_VariantChainToIface | same as R1c_As_FromCodeunit | A second Variant should change nothing. |
| S1_RunById | `MARK ... OnRun` | Side observation: `Codeunit.Run(<integer>)` in external code runs any codeunit by id, with no Variant. Expected yes. |

## What decides R389

- **Closes as a ruling** (no code): every route that does not pass back through test-app code
  (all except R3 and the C0 control) is refused at compile time or at run time, or cannot run the
  test-app codeunit (no MARK). In particular R1c, R1d, R4b and R4f must all show no MARK.
- **Sends the plan to review** (build the safe version): ANY of R1c, R1d, R2*, R4a-R4f shows a MARK.
  Given the compile result above, R1c is the most likely, and my expectation is that this is
  the outcome: R1c and R1d MARK.
- **Void, re-run before deciding**: C0 or R3 does not MARK; or R1d's NonImplementer or Integer
  control says `is` = true.

S1 decides nothing about the Variant question. It is recorded because it is a separate way
external code reaches test-app code (an Integer id handed out), and the reviewer should know
whether the walk sees that.

## Where and what is left behind

- Container: **Cronus28**, dev endpoint, from the kraken container. BC build unknown until the
  run; phase 2 records it (from `bcdev_status`, or the altool publish output).
- The probe apps have no tables, so no schema ghost. They still cannot be unpublished from the
  kraken container (unpublish is host-only). After phase 2 they stay on Cronus28 and are listed
  for the owner's cleanup:
  - `LethAL R389 Probe Tests`, publisher `LethAL R389 Probe`, app id
    `5e7a3c91-0b42-4d6e-a8f1-389e0a1b2c02`, version 1.0.0.0. Unpublish this FIRST.
  - `LethAL R389 Probe External`, publisher `LethAL R389 Probe`, app id
    `5e7a3c91-0b42-4d6e-a8f1-389e0a1b2c01`, version 1.0.0.0.
  - Object ids used: 91500-91502 and 91530-91532. No other app on the container may use them
    (91000-91099 is LethAL Control's; nothing known uses 915xx).
