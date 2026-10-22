# R-586 pre-commitment r8 (R-637): a contract fact pins v3's "not trusted" row after a timeout

The R-637 builder drafted this on 2026-10-22, before any code for the fact and before any live run. Lane bugs
committed it to master before the fact was coded and before any `--regate`.

It is a delta on `2026-10-22-r586-alrunner-v3-precommitment-r7-none-selected.md` (16681485). Everything in r7 and
the earlier deltas stands, except what is below. A differing fact verdict in leg C is still a BLOCK.

## Why

R637 feared a false kill: a mutant makes test A hang, v3 stops A, and then a later test B of the same codeunit fails
only because A was cut off half-way.

R-637's measurement (`/coord/handoff/R-637/measure.md`) showed that alpha.2 does not report B as a plain `fail`.
- It reports B as `notRun: true`, `status: "error"`, with a message that ends
  "this failure is not trusted: <B's own message>".
- LethAL scores that row `error`, never a kill.
- 19 state channels were probed, with 0 escapes.

So today the guard against R637's false kill is v3's own rule, not LethAL's. The orchestrator ruled option (b) plus a
pin: LethAL builds no fail-closed scoring rule, and leg C pins v3's rule instead. A build that drops the rule then
cannot become `current`.

## The new fact

**`dependent-fail-after-timeout-is-notrun`**, kind `contract`.

**The probe.** A new test codeunit in the contract probe's test app, **50652 "Probe Cut"**.
- It is built like the rest of the probe: `writeProject`, invented AL, no alc step.
- It uses the probe target's existing planted hang, `Probe Logic.Spin()` (a `while true` loop), so the target needs
  no change.

```al
codeunit 50652 "Probe Cut"
{
    Subtype = Test;

    var
        Logic: Codeunit "Probe Logic";
        Dirty: Boolean;

    [Test]
    procedure HangsDirty()
    begin
        Dirty := true;
        Logic.Spin();
        Dirty := false;
    end;

    [Test]
    procedure ChecksClean()
    begin
        if Dirty then
            Error('dirty');
    end;
}
```

`HangsDirty` is declared first, so v3 runs it first. `ChecksClean` fails only because `HangsDirty` was stopped
before it cleared `Dirty`. Codeunit globals survive between tests under `--isolation test` (#5611).

**The call.** One one-shot call, like every other probe call:
`<v3> test --output-json --isolation test --package-cache ... --bc-version ... --no-download --test-timeout-secs 3 --codeunit 50652 <app> <tests>`.

**The rule.** The fact reads `matches` only when all of these hold:
- the exit code is 7;
- the `HangsDirty` row has `notRun: true` and the message is exactly `Test exceeded 3s timeout.`;
- the `ChecksClean` row has `notRun: true` and `status: "error"`;
- its message starts with `NotRun: out-of-scope: an earlier test of this codeunit was refused while it ran (HangsDirty: `;
- its message ends with `this failure is not trusted: dirty`.

It reads `diverged` in every other case, including:
- `ChecksClean` comes back as a plain `fail`, meaning the guard was dropped;
- the `ChecksClean` row is missing;
- the `HangsDirty` row is not the timeout row;
- the exit code is something else;
- there is no document that can be decoded.

A `diverged` contract fact refuses a session (r6) and is `gate-fail` in leg C. The fact has no `unmeasurable`
reading: anything that is not the measured shape fails closed.

**Sessions.** The fact is NOT gate-only.
- Unlike `timeout-is-cpu`, it does not depend on the machine's speed. `Spin` never ends, so any CPU stop cuts it off.
- A session's contract probe therefore measures it too, and a `diverged` reading refuses the session.
- That is the right direction, because such a build may score R637's false kill.

## Figures that move

- Leg C goes from 23 facts to **24**. Defect facts stay at 8, and contract facts go from 15 to **16**.
  `V3_DEFECT_FACTS` does not change.
- **Collision with R-612.** R-612's plan r3 (fc61d221, adopted, built on `lethal/r612` at c74c14de, not merged) also
  moves leg C from 23 to 24, by adding one warn fact (`serve-keep-reasons`).
  - With both merged, leg C has **25** facts: 8 defect, 16 contract and 1 warn.
  - Whichever of R-612 and R-637 merges second sets the count to 25, both in `legC`
    (`classifyLegC(..., 25, ...)`) and on the gate page.
  - This delta pre-commits both counts: 24 if R-637 merges alone, and 25 if R-612's warn fact is already in.
  - Any other count is `gate-fail`.

## Cost

- **The timeout is 3 s** (`--test-timeout-secs 3`), the same as `timeout-classified`.
- **The fact adds about 3.0 s to each leg C,** and the same to each v3 session, since a session runs the contract
  probe once.
- **Measured on alpha.2:** one call took 3041 ms wall (exit 7). Of that, 3007 ms was `HangsDirty`'s stop, and the
  rest was compile and run.

## Prediction on alpha.2 (91253f2d6)

**`matches`, measured.** On 2026-10-22 the exact AL above was run alone, with the exact call above.
- The only differences were the object ids: 50760 for the target and 50780 for the tests, to fit the R-637 probe's
  app.json ranges.
- The evidence is in `/coord/handoff/R-637/r8-measure/` (`out/cut.stdout`, `out/cut.exit`).

The call gave exit 7 and two rows:
- `HangsDirty`: `notRun: true`, `status: "error"`, "Test exceeded 3s timeout.", 3007 ms;
- `ChecksClean`: `notRun: true`, `status: "error"`, "NotRun: out-of-scope: an earlier test of this codeunit was
  refused while it ran (HangsDirty: did not run (the test used more than the time limit of 3 s of CPU time and was
  stopped (--test-timeout-secs)): it can change the global variable Probe Cut.Dirty that this test reads, so the
  state it would have left is not BC's; this failure is not trusted: dirty".

The same shape was measured on the R-637 probe's codeunit 50792 (`AChecksClean`, one-shot and serve).

**Inferred, not measured:** that the fact reads the same inside the full contract probe app, next to the other probe
codeunits. Each call selects one codeunit, and v3's reach analysis is per codeunit run. The first leg C on the built
head measures it.

The leg-C outcome on alpha.2 stays `pass`. If R-612 merged first, it is `pass` plus R-612's warn line, if there is one.

## What a future build would show

- **It drops the guard** (R637's original fear).
  - `ChecksClean` comes back as a plain `status: "fail"`, with no `notRun` and the message `dirty`, probably with
    exit 1.
  - The fact reads `diverged`, leg C is `gate-fail`, and the build goes to `failed/<tag>@<commit>`. It never becomes
    `current`, and a session on it is refused.
  - Admitting such a build needs a LethAL-side rule first (the fail-closed rule that this ruling did not build) and a
    new delta.
- **It rewords the cascade message, or the timeout message.**
  - The fact reads `diverged`, so `gate-fail`.
  - That is a cost, not a danger. It needs a delta, as r7 did.
- **It resets codeunit state after a stop** (so `ChecksClean` passes), or **it starts trusting the failure** because
  its reach analysis changed.
  - The fact reads `diverged`, so `gate-fail`.
  - A pass is the safe direction, but this delta keeps the orchestrator's rule ("anything else is diverged").
  - If it happens, the reading is reported as a possible wrong-reason `gate-fail` (the r7 mistake), and it needs its
    own delta. It is not reclassified on the spot. R-639's measured-BC-reading rule (r9) is where such a case belongs.

## Interaction with R-612's keep/close rule

R-612's v3 serve rule (`serveDaemonReusable`) keeps a daemon only when EVERY row of an answer is one of these:
- `pass` or `fail`, without `notRun`;
- a `notRun` error whose message is one of `V3_SERVE_SAFE_REFUSALS`.

A timeout row is neither, so an answer with a timeout row closes the daemon.

- **This fact is robust to that rule, because it never uses serve.**
  - It is a one-shot call, like the rest of the contract probe except R-612's own `serve-keep-reasons`.
  - No daemon state can carry into it, and its call cannot close or keep a daemon that another fact uses.
  - Its order among the facts does not matter.
- **A point for R-612, not a change here.**
  - R-612's `cascade` entry also matches `ChecksClean`'s row, which is a cascade CAUSED by a timeout. The entry is
    `^NotRun: out-of-scope: an earlier test of this codeunit was refused while it ran \(`, followed by the no-panic
    lookahead and `.*$`.
  - Today that is harmless: the timeout row is in the same answer, and `every` closes on it.
  - It would keep a daemon only if an answer carried the cascade row without its timeout row, for example if serve's
    `excludeTests` hid that row. Whether an excluded test is not run, or only not reported, is UNMEASURED (R-637 §1d).
  - Two ways to close it: R-635's serve transport adds a T3 case for a timeout-caused cascade row alone, or "the time
    limit" is excluded from the `cascade` entry.
  - This is filed with the orchestrator here, not coded by R-637.

## Tests (pre-committed, coded after this delta is committed)

A unit test of the fact's classification, through a stubbed spawn:
- (a) the measured alpha.2 rows: `matches`;
- (b) `ChecksClean` as a plain `fail` with the message `dirty` and exit 1: `diverged`;
- (c) the `ChecksClean` row missing, with only the timeout row: `diverged`.

Each direction is red-checked by one revert:
- R1: make `ChecksClean`'s check accept a plain `fail` row, and (b) goes red;
- R2: make a missing `ChecksClean` row read `matches`, and (c) goes red;
- R3: require the wrong timeout text, and (a) goes red.

The red logs go in `/coord/handoff/R-637/red-unit/`. The leg-C count test (`r586-gate.test.ts`) moves to the new
count.
