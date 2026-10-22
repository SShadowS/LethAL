# R-612 plan r3: delta on r2 (review r2: one new hole, one pin change)

Everything in `plan.r2.md` stands except the two changes below. The duplicate-name throw stays v3-only, as the
reviewer agreed.

## 1. No `.*` entry may keep a panic

`onrun-failed` ends in `.*`, so an OnRun panic worded
"NotRun: out-of-scope: OnRun failed (runner behaviour not pinned): runtime panic (bug) ..." would keep the daemon.
That case is unmeasured. Both entries that end in a tail get a negative lookahead for both panic wordings:

| Entry | Pattern (anchored `^...$`) |
|-------|-----------------------------|
| onrun-failed | `NotRun: out-of-scope: OnRun failed \(runner behaviour not pinned\): (?!.*(?:runtime panic \(bug\)\|panicked \(a runtime bug\))).*` |
| cascade (#5610) | `NotRun: out-of-scope: an earlier test of this codeunit was refused while it ran \((?!.*(?:runtime panic \(bug\)\|panicked \(a runtime bug\))).*` |

- The cascade gets the lookahead too, for the same reason: its tail embeds an earlier row's text. That costs
  nothing and closes the same hole.
- The three other entries have no tail, so they cannot carry a panic.
- One shared `V3_PANIC_WORDING` source is used by both lookaheads, so they cannot drift apart.

T3 gains three cases, all of which must close:
- (c) an OnRun-failed row whose tail is "runtime panic (bug): ...";
- (d) an OnRun-failed row whose tail contains "panicked (a runtime bug)";
- (e) a cascade row whose tail contains "runtime panic (bug)".

New red check R10: drop the lookahead from `onrun-failed`. T3 (c) and (d) must go red, then restore green. R11 does
the same for the cascade lookahead and T3 (e).

## 2. The contract pin reads SERVE rows, and it warns instead of blocking

- The rule reads serve rows, so `serve-keep-reasons` runs its five probe cases through `alrunner serve` (one
  daemon, `--test-timeout` as the gate sets it, `testIsolation: "test"`), not one-shot. This is the driver pattern
  of the R-612 probe (`/coord/handoff/R-612/probe/serve-rows.ts`). It needs no one-shot/serve identity claim.
  For the record, the measured overlap: HttpClient, Commit and the cascade read identically in one-shot
  (`probe/oneshot-refuse.json`) and serve (`probe/main.stdout`). OnRun-failed and no-callee were measured on serve
  only.
- **A `diverged` result costs only speed** (the rule then closes, the safe direction). So it is a WARNING
  fact:
  - It does not block a pin move and does not make the gate `gate-fail`.
  - It prints `al-runner-v3-serve-keep-reason-moved` with the moved entry and the measured text, in the gate's
    log and receipt `lines`.
  - It is counted in neither `V3_DEFECT_FACTS` nor the contract facts that refuse a session. It is a new third
    kind, `warn`, with its own list.
  - `unmeasurable` (e.g. serve does not start) also only warns.
- **Pre-commitment adjustment** (the leg-C delta named in r2 item 1):
  - Leg C goes from 23 facts to 24: 15 contract, 8 defect, 1 warn.
  - The new fact reads `matches` on alpha.2 for all five entries.
  - Any value of it is never a `gate-fail` or a `held`.
  - The gate page `docs/gates/alrunner-v3.md` states the third kind.
- Test: the gate's leg-outcome function maps a `diverged` warn fact to `pass` plus the warning line. Red check
  R12: map it like a contract fact, so the test goes red.
