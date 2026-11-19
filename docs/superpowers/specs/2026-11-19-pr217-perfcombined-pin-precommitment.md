# PR-217 pre-commitment: a hand pin for perf-combined 2bb4b686, a fork test build for PERF-10, never `current`

Lane lethal-bugs, coord PR-217, 2026-11-19. The orchestrator's conditions (2026-11-19): this commit is specs-only and names
the exact binary; the pin carries ONLY `o1.partnerLoginRefusal` on top of `current`'s readings; the private gate must then pass
every other leg unchanged (any other difference is a finding for alrunner, never a pin edit); the pin is removed after PERF-10
by its own commit.

## The binary
- version line: `al-runner 3.0.0-alpha.14 (2bb4b6861)`
- binarySha256: `f824dee326e1f9dc3e63045214297353d8e32299ca2677f4bfc3184411b2fc9b`
- built from origin `perf-combined` at 2bb4b686178025aea274dc787d073ecb9e5d522f (base upstream/main 0e6397742; contents
  `/coord/handoff/PERF-10/contents.md`), in `/coord/handoff/PR-217/combined`.
- **A fork test build for PERF-10. Never `current`, never in the gate manifest, never used by LethAL's own work.**

## The pin (`V3_BUILD_PINS`, id `perfcombined-2bb4b6861`)
- Readings: exactly the LIVE root edge-d72d3197d's **as on master after PR-209** (orchestrator, 2026-11-19: ONE regate of
  `current`, after PR-209, PR-236 and this pin are all on master). The pin is written with the same constants as that root
  (`...READINGS_8078BCF49`, `o1: { ...O1_8078BCF49, cdoApps: 18 }`), so it carries PR-209's moved readings (leg T 450 rows:
  346 killed, 77 survived, 27 no-coverage) and never the frozen `-frozen-pre-pr209` pins. The digest test compares against
  `handV3Pin("edge-d72d3197d")` at the merged head.
- **Plus one field and nothing else:** `o1.partnerLoginRefusal = { text: O1_PARTNER_LOGIN_TEXT, issue: #8239, evidence }`
  (PR-233). It is a known coverage loss, not BC's behaviour (BC measured on bc4 runs the inserts).
- A unit test checks the pin equals edge-d72d3197d's readings with only that field added (by structure and by
  `v3ReadingsDigest` of the pin minus the field).

## The measurements it rests on
- perf-combined's gate itest under edge-d72d3197d's readings (2026-11-19 14:49-15:04Z, `/coord/handoff/PR-217/gate/`):
  23 of 24 legs PASS, and O1 gate-failed ONLY on the corpus set's row inserts with that text. The same happens on plain
  0e6397742 (`/coord/handoff/PR-217/gate-o1-base/`).
- With PR-233, that O1 answer is exactly the pinned pattern (16 rows; PR-233's prediction "held" without the field, reproduced
  at `/coord/handoff/PR-233/o1-base-built/`).
- **Not yet measured on perf-combined:** leg T's 32 rows PR-209 adds (the new default-on operators). The private gate is that
  measurement; a difference there is a finding for alrunner, never a pin edit.

## Predictions for the private gate (PR-226 with PR-236's acceptance of this pin, at `current` regated ONCE at master after
## PR-209, PR-236 and this pin)
- Outcome PASS, applying pin `perfcombined-2bb4b6861`. Every leg passes; O1's corpus set passes with the 16 row inserts refused
  by exactly the pinned text.
- The `.gated` the gate writes beside the copy names this pin as `readingsFrom`.
- Any leg that differs from the 14:49Z run (other than O1 now passing under the pin) stops PERF-10: a finding for alrunner.

## Removal
After PERF-10's run and control, the pin is removed by its own commit, and the copy's `.gated` under
`/coord/handoff/PR-217/root/builds/` is deleted with the private root.
