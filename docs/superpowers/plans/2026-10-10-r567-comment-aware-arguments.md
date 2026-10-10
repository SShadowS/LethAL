# R-567 plan r2: one comment-aware argument reader for every consumer (lethal-preproc, 2026-10-10)

**r2 changes** (opus plan review r1, `review-opus-plan-r1.md`; these override r1 where they differ):
- **Uncertain (unreadable) call at the HOP / FILTER HOP sites:**
  - every R passed is paired with EVERY parameter index of EVERY same-name candidate, whatever its parameter
    count; `refuse: true` is kept, and `r562FilterHop`'s other-object branch never returns `none` for it (I1);
  - its `.args[i]` field readers (the SetRange field, FILTER HOP `depends`, the Validate field) read `"*"`;
  - the bare-consumer gate and `bareRec` take any arity;
  - R564 narrowing is skipped (I2).
- **`attributesOf`:** the backward walk skips comment and pragma siblings between an attribute and its procedure
  (I3), measured by a parse census of that shape.
- **`subscriberKey` unreadable:** over-reach, never a lost edge. `subscribesToTable` unreadable means true (I4).
- **Attribute arguments** are counted from the `attribute_argument_list` node (M1).
- **The flipped R564 pins** assert which overload is refused (M2). There is one red test per unreadable path (M3).
- **Measurement:** the prod500 keys by key AND ordinal (M5), plus a diff of the `run-trigger-skipped-insert` tags
  (M4).

---


Branch `lethal/r567` from master fb13b03c. Measurement and site inventory: `measure.md`.

## The shared helper (engine `ast/arguments.ts`, where `countArguments` and `exactArguments` already live)
- **`argumentList(node)`:** the argument expressions of a call or of an attribute's argument list, with
  `comment` and `multiline_comment` removed. It is the existing private `argumentNodes`, made public and widened
  to take the list node, so attributes use it too.
- **`argumentsReadable(node)`:** true when `argumentList(node).length === countArguments(node)`, that is, no
  OTHER trivia (pragma, preproc) sits among the arguments. Measured: 1 such list in all corpora.

## Consumers switched to it
1. **loop-hazard `r531Call`:** `args` = `argumentList`. When `!argumentsReadable`, the call is marked `uncertain`.
   At every HOP / FILTER HOP site an uncertain call follows EVERY procedure of that name, whatever its parameter
   count, and maps no argument to a parameter. Every candidate is refused (over-refusal, the safe direction).
   `r531ProcsIn`'s R564 narrowing is skipped for an uncertain call.
2. **loop-hazard `directWrite` and the open-item write scan:** positions from `argumentList`. When unreadable,
   each site takes its own documented "unknown" direction: `directWrite` counts the identifier arguments as
   writing (refuse more), and the open-item scan treats them as written by none, which keeps the name preset.
   That is the direction the scan already uses for an unknown callee.
3. **loop-hazard `.args[0]` / `.args[1]` consumers:** they read from `argumentList`, through `r531Call`.
4. **loop-hazard `subscriberKey`:** the attribute arguments through `argumentList`. An unreadable list gives
   null, as today for a malformed attribute.
5. **loop-hazard SetRange/SetFilter read scan and literal bounds:** through `argumentList`, so they are correct
   rather than over.
6. **engine insert-key-assignment Validate scan, and trigger-skip `subscribesToTable`:** through `argumentList`.

## Identity and scheme
The change refuses MORE where a comment hid a callee or a write (keys leave), and may refuse LESS where it made a
read or bound over-broad, or a WRONG overload was followed (keys return).

Measure on the built branch with the prod500 identity dumps, master vs built:
- every DO, CDO and DC project with a hit;
- the BaseApp projects with hits (from `census567.ts`'s list; at most 2 corpus jobs).

If any EXISTING key's tuple or ordinal moves, I ask the orchestrator for scheme 40 before submitting. If only
keys appear or disappear, the scheme stays 39.

## Tests (each red-checked: revert that consumer's switch, and its test goes red)
- **The R564 four pins** "a comment among the arguments keeps today's behaviour" flip to "the callee's sites ARE
  refused", at the recv-proc, same-object, table/codeunit and HOP sites.
- **A comment before the receiver argument**, through the HOP loop to a by-value vs `var` parameter: the `var` one
  is followed.
- **`F(/*c*/ Rec)` with a `.args[0]` consumer:** `SetRange(/*c*/ "No.", X)` is read with field `No.`.
- **`directWrite` with `F(/*c*/ Name)`** to a `var` parameter: the preset write is seen, and the site refused.
- **The open-item write scan:** the same shape.
- **`subscriberKey`** with a comment in `[EventSubscriber(ObjectType::Table, /*c*/ Database::X, ...)]`: the edge is
  found.
- **An inflated count with a sibling overload:** `F(xRec /*c*/)` with `F(a)` and `F(a, b)`. The 1-parameter one is
  followed, not the 2-parameter one.
- **Unreadable** (a `#pragma` inside the arguments): every same-name procedure is refused.
- **insert-key-assignment** with a comment before the Validate field: the key-field Validate is seen.
- **Engine unit tests** for `argumentList` and `argumentsReadable` (comment, multiline comment, pragma, none).

## Out of scope
swap-call-arguments and testpage-scan already filter comments. The parameter side is clean.
