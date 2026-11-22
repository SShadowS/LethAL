# PR-327 (a) pre-commitment: label al-runner-v3 survivors that a cross-codeunit SingleInstance carry-over could kill (R1173, GitHub #53)

Coord PR-327 (lethal-code, 2026-11-22). The orchestrator's order:
1. (a) this label;
2. (c) R1174, the R197 ledger fix on bcdev;
3. (b) the v3 `strictOrder` lane fix.

**Evidence:** `/coord/handoff/PR-327/findings.md` (the invented probe reproduced on v3 and bcdev; c2 sized).

## The rule: label, never hide (principle 6)
- **Which survivors:** on the **al-runner-v3 backend only**, a mutant whose verdict is `survived` gets the tag
  `[singleinstance-carry-unobservable]` when BOTH hold:
  1. its site lies inside a codeunit object whose `SingleInstance` property is `true`, read by the parser from the
     target's source (the object's property, not a text search);
  2. its covering tests (the FULL covering set the report records) come from **2 or more distinct test codeunits**.
- **The note text:** "survived; touches SingleInstance state; cross-codeunit carry-over not observable on al-runner-v3
  (each test codeunit runs in a fresh entry, R1173)". It is added to the survivor's `failureNote` the way
  `[v3-refused-test-nearby]` is: appended, never replacing another note.
- **Never on:** a kill, an error, no-coverage, a bcdev run, or a survivor covered by ONE test codeunit (there, no
  carry-over between codeunits can exist).
- **No verdict moves.** It is a note only: no new report field, no caveat, and no warning event.

## Size (c2, DO; numbers only)
- 8,536 survivors.
- 157 have their site in a SingleInstance codeunit.
- **90** of those are also covered by 2 or more test codeunits, so **90 would carry the tag.** That is predicted from the
  committed c2 report; the build re-reads it offline and reports the exact count.

## Gates (checked in the build, before anything else: a STOP condition)
- **Fixtures with a SingleInstance codeunit in a TARGET:** `sandbox-hang` (`HangLogic`), `sandbox-order` (`OrderDep`,
  which the v3 gate's O1 and order legs run), and `sandbox-reach` (no gate).
- **The census:** for each v3 gate leg, count the survivors the rule would tag. Then check whether that leg compares notes.
  - The v3 legs compare per-mutant fields through `normalizeForComparison` (key, verdict, `killingTest`, error class,
    hash), which does not include notes; the build confirms this per leg.
  - If any leg compares `failureNote`, the build STOPS and the gate change is pre-committed first.
- **bcdev gates are untouched,** since the rule is v3-only.
- **The full v3 gate runs on the final head.**

## Tests (red-going both ways)
- **Tagged:** a v3 survivor in a SingleInstance codeunit, covered by 2 test codeunits.
- **Not tagged:** the same with 1 test codeunit; a non-SingleInstance codeunit; a kill; bcdev with the same inputs.
- **Placement:** an existing `[v3-refused-test-nearby]` note is kept, and the new tag is appended.
- **The parser path:** `SingleInstance = true` in a property, case-insensitive, is detected; a comment that mentions it is
  not.
- **Red checks:** remove the 2-codeunit condition, then the SingleInstance condition, and confirm the matching tests go
  red.

## Then
- (c) R1174: the ledger never moves a killer across test codeunits. Its own pre-commitment, measured red then green on the
  probe.
- (b) the `strictOrder` lane, after that.
