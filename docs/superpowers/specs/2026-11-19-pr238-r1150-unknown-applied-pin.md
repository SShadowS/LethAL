# PR-238 pre-commitment: a pass that applied a pin this checkout does not know is infra-fail, early (R1150)

Coord PR-238, lethal-code, 2026-11-19. Roadmap: R1150. Orchestrator: the plan as written; the merge is held until
PERF-10's regate is done, since this touches the update script.

## The change (`scripts/al-runner-v3-update.ts`, `readReceipt`)
- **Where:** `readReceipt` already looks the applied pin up (`hand`, through the PR-236 `pinOf` seam).
- **The new rule:** when the receipt's outcome is `pass`, it names a `pinApplied`, and this checkout has no hand pin by
  that id, `readReceipt` returns `infra-fail` with the reason
  `the gate applied pin <id>, which this checkout does not have: merge master, or re-gate at a commit that has it`.
- **What follows:** `gateOne` takes its existing infra branch, which returns before any copy, `.gated`, ledger row or
  `current` move. That holds on every path: default, re-gate, rejudge, refresh and private.

**Unchanged:**
- a pass with NO pin applied (the default tables), except where `pinFrom` already requires one;
- a pass whose pin this checkout knows, including the existing digest check and PR-236's private rule;
- `gate-fail` and `held` outcomes. A held or failed gate never moves anything, so its pin is only evidence.

The "no gated-builds row: this script's checkout has no pin …" branch in `gateOne` can then only be reached with no pin
applied. Its text stays; the unknown-pin half becomes dead and is left as is, so this change stays minimal.

## Tests (red-checked both ways)
- **Default path** (`edgeOnce`, a candidate): a pass whose receipt names an unknown pin is infra-fail. No `.gated` row in
  the ledger; `current` does not move; the reason is in the log.
- **The same with a known pin** (the existing passing tests): unchanged.
- **Private path:** a pass naming an unknown pin is infra-fail, and no `.gated` is written.
- **`readReceipt` alone:**
  - a known pin passes;
  - an unknown pin on `pass` is infra-fail;
  - an unknown pin on `held` stays `held`.
- **Red checks:**
  - remove the rule, so the default and private tests go red;
  - apply it to every outcome, so the `held` test goes red.
