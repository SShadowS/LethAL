# R1188 probe: what BC answers where al-runner refuses (coord PR-366)

Invented names only. **This probe is not published to BC yet.** Its bc4 run is a separate task, under its own lease.

## The shapes
Each mirrors one BaseApp field that al-runner refuses on DO. The comments in `src/Probe.al` name the condition of upstream
`1bea5bc7a`'s gate (`no_field_measured`) that each one fails.

| test | shape | like |
|---|---|---|
| `ControlMeasuredShape` | Code[20] to a one-field Code[20] key, the field outside its own key (a measured shape) | the gate's pinned case |
| `ShapeA_FieldInsideItsOwnKey` | the related field is inside its own table's primary key | `Dimension Code` of `Dimension Set Entry` |
| `ShapeB_CodeToCodeTextKey` | Code[20] to a (Code, Text) key | `Ship-to Post Code` of `Sales Invoice Header` |
| `ShapeC_IntegerToIntegerCodeKey` | Integer to an (Integer, Code) key | `Dimension Set ID` of `Sales Invoice Header` |
| `IntegerToDateThrough*` | four ways to put an Integer into a Date | DO's "conversion of Integer N to Date" |

Every test ends in `Error('MEASURED ...')`, so its value travels out on both runtimes. A red test here is the data, not a fault.

## Measured on al-runner (2026-11-23, one-shot, `--bc-version 28`, no package cache)

| test | main-bf3a3e863 (current) | edge-4ebfe7913 (y3's build) |
|---|---|---|
| ControlMeasuredShape | RelationFieldNo = **0** | RelationFieldNo = **1** |
| ShapeA | REFUSED: "... RelationFieldNo ... not known ... a TableRelation without a field of a shape not measured" | RelationFieldNo = 1 |
| ShapeB | REFUSED (the same text) | RelationFieldNo = 1 |
| ShapeC | REFUSED (the same text) | RelationFieldNo = 1 |
| IntegerToDateThroughVariant | fail: "...NavIndirectValue cannot be type-converted to a ...NavDate value." | the same |
| IntegerToDateThroughFieldRefValue | fail: "The format of the Date '20240101' does not match your device's date settings. ..." | the same |
| **IntegerToDateThroughSetRange** | **REFUSED: "conversion of Integer 20240101 to Date"** (DO's text) | the same refusal |
| IntegerToDateThroughValidateVariant | fail: the date-format text | the same |

## What it shows
- **The three shapes reproduce DO's `RelationFieldNo` refusal exactly, with invented names.**
  - y3's build answered 1 everywhere, the control included. Upstream's issue #8249 found BC gives 0 for the control's shape.
    `1bea5bc7a` then answers 0 there and refuses the unmeasured shapes.
  - **The BC question:** what `RelationFieldNo` BC gives for shapes A, B and C (0 as in the control, or another value).
    If BC also gives 0, DO's tests passed in y3 on a wrong value (1).
- **`FieldRef.SetRange` with an Integer on a Date field reproduces DO's "conversion of Integer N to Date" refusal.**
  y3's build refused it too, so the refusal is not new upstream. DO only reached it newly in c3.
  - **The BC question:** does BC raise an error (which text), or filter.
- **Not covered here: the SaveAs-as-Pdf "data items = another tree" refusal.** It needs a report layout to render, and the
  upstream corpus that has one is not checked out in this container. It is left to the bc4 task, with a layout built there.

## Running it on BC (the next task)
Per the `al-probe` skill: ids 91500-91520 (clear of LethAL Control's 91000-91099); publish over the dev endpoint under a
bc4 lease; run codeunit 91510; read each `MEASURED` line; unpublish after. The compile is already checked offline (`alc`,
clean against `fixtures/sandbox-tests/.alpackages`).
