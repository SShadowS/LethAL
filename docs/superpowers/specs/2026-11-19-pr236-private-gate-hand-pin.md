# PR-236 pre-commitment: a private gate may pass on a hand pin for the candidate's exact binary

Coord PR-236, lethal-code, 2026-11-19.
- **Ruling:** the orchestrator, option (1) of lethal-bugs' P6 report; bugs' exact rules were relayed the same day.
- **Follow-up to:** PR-226 (the update gate's private mode, `--root` and `--local-candidate`).
- **Needed by:** PERF-10.

## The problem
`gateOne`'s refresh/private pass branch (`scripts/al-runner-v3-update.ts`) requires `pinApplied === pinRootOf(gated)`.
After PR-233, leg O1 reads HELD on perf-combined's binary unless the gate judges by a hand pin that carries
`o1.partnerLoginRefusal`. Such a pin is a hand pin for perf-combined's own binary. Its id is not `pinRootOf(gated)`, so
today a PASS under it turns into infra-fail.

## The rule (private gates only)
In that branch, when `priv` is true and `pinApplied !== pinRootOf(gated)`, the pass is ALSO accepted if all of these
hold. A new exported pure function, `privatePinRefusal(applied, root, version, sha)`, decides them, returning why not or
`undefined`:
1. `handV3Pin(applied)` exists, and its `version` and `binarySha256` equal the candidate's: the receipt's `version` and
   the gated bytes' sha256 (`sha`).
2. `applied`'s pin carries `o1.partnerLoginRefusal`.
3. `handV3Pin(root)` exists, and the two pins' readings are equal once:
   - `id`, `version` and `binarySha256` are left out of both, as `v3ReadingsDigest` leaves them out;
   - `o1.partnerLoginRefusal` is left out of `applied`'s.
   - Readings are compared as canonical JSON with keys sorted at every level, RegExp and functions as their text, and
     arrays in order. Sorting only removes key order as a source of difference; any value difference still refuses.

**Anything else stays infra-fail, with the reason in the log line:** no pin applied, an unknown pin, another binary, no
`partnerLoginRefusal`, or any other reading that differs, including a missing field.

**Unchanged:**
- the default path (no `--root`), and a refresh that is not private (`refreshRow`): both still require
  `pinApplied === pinRootOf(gated)`;
- held and infra outcomes;
- the copy and `.gated` writing. The `.gated` keeps `readingsFrom = pinApplied`, now the candidate's own pin.

## Tests (red-checked both ways)
- The applied pin equals the root plus `o1.partnerLoginRefusal`, with the candidate's version and sha256: accepted, and
  `gateOne` writes `.gated` with `readingsFrom` = that pin.
- The same, with one other reading changed (a `legC` value): refused, and the pass becomes infra-fail.
- The same, with a field missing compared with the root: refused.
- The same pin, but its `binarySha256` is another binary's: refused.
- No `partnerLoginRefusal` but otherwise equal and a different id: refused.
- The root pin itself: still passes, as today.
- A NON-private refresh with the same candidate pin: still infra-fail (the old rule).

Red checks:
- drop the `priv` condition, so the non-private test goes red;
- drop the strip, or rule 2, so the accept test or the no-field test goes red;
- drop the sha check, so the other-binary test goes red.
