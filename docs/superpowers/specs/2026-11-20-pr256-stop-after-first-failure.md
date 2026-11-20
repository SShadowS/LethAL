# PR-256 (R1146): use al-runner's stopAfterFirstFailure on single-mutant requests — pre-commitment

lethal-preproc, 2026-11-20 (coord PR-256). Owner ruling (via the orchestrator): `current` moves to a gated upstream main
build (lethal-bugs, PR-255: 9835579c66, which contains #8484); LethAL builds its side. Orchestrator's ruling on scope:
**(a) + (c)** — (a) the stop only on requests that carry ONE mutant, built now; (c) per-entry stop groups asked of upstream
(the orchestrator relays). Evidence: `/coord/handoff/PR-256/` (`model-b.py`, `model-b-reading.md`).

## 0a. Amendment 1 (2026-11-20, the spec-adversary on r1, before any code): two BLOCKs, one acceptance rule
- **BLOCK 1, §2.4 was false.** Today's killing test is the first failure in R197's KILL-LEDGER order (`orderCoveringTests`:
  tests that already killed in the procedure first), served from the codeunit's cached rows; it is not the first failure
  in RUN order. With the stop, a test that fails earlier in run order turns the ledger's preferred killer into a stop
  `notRun` row: a different killing test (and a re-ordered ledger for every later mutant of the procedure) or a lost kill;
  R577's reproduction (also a single-mutant `liveCall`) then reads the kill as not reproduced.
- **BLOCK 2, any failing test fires the stop** (upstream stops on any `Outcome::Fail`): a baseline-red test, or a
  non-covering test placed before a covering one, stops the request and turns a survivor into `error` (R198's `attempted`
  must equal the covering set) or loses a kill.
- **Pre-committed fix, one ACCEPTANCE RULE (the R907 alone-after-stop fallback's kind):** a stopped answer is accepted only
  if (i) the failed test its stop message names is one of the mutant's covering tests, AND (ii) every covering test ranked
  before that failure in the walk's order (`useCoveringBudgets(mutantId, ordered)`) has a real (not stop-`notRun`) row.
  Otherwise the answer is discarded and the request re-sent WITHOUT the stop. Plus: the stop is never sent for a codeunit
  whose baseline has a fail before its last covering test.
- **Should-fixes adopted:**
  1. upstream's stop implies `--run-selected-only` (`selected_only()` = `run_selected_only || stop_after_first_failure`),
     so the stop is sent only when the request is already `runSelectedOnly`-flagged or excludes nothing and its codeunit is
     clean; `answer.selectedOnly` is set whenever the stop is sent; a PR-94 re-send drops the stop;
  2. the stop is chosen by request KIND (`live`, including `aloneCall` and R577 reproductions), never by content (a
     one-group prefetch chunk or re-sent segment never gets it);
  3. a stop-`notRun` row is recognised by its message and gets an explicit `V3_SERVE_SAFE_REFUSALS` (R612) entry, so a kill
     never closes the daemon.
- **Tests added to §3:** a stopped test ranked BEFORE the run-order failure (BLOCK 1's sequence: re-sent, killer
  unchanged); a baseline-red trigger and a non-covering trigger (BLOCK 2: re-sent, verdict unchanged); each red-checked.
- **The acceptance rule is also what (c)'s per-mutant `stopGroup` will need**, so it is groundwork for the prefetch use,
  not (a)-only cost. (a)'s own saving stays small (live requests only; re-sends eat into it); the live check measures it.
- Follow-up when a `stopGroup` build exists (alrunner is drafting it): prefetch per mutant through the same acceptance rule,
  measured as PR-223 did.

## 0b. Amendment 2 (2026-11-20, the builder, before any code): BLOCKED — LethAL's echo always fails, so the stop fires on it
- **The premise of §2.3 and §0a ("echo pass") is false.** LethAL's echo entry fails ON PURPOSE: `emitSelectorEcho`
  (al-runner-v3-entries.ts) ends `Error('LETHAL-ECHO:%1:%2', t, r)`, and `echoMismatch` treats a passing echo as a defect.
  Every entries request opens with its echo (`assertEntriesWellFormed`).
- **Upstream 9835579c6 gives the echo no exemption:** `corpus.rs` `pass_stopped` stops at the first `Outcome::Fail` among
  earlier entries. So under `stopAfterFirstFailure` every request stops AT THE ECHO: the mutant's codeunit never runs, its
  rows read `NotRun: out-of-scope: the test Codeunit<ECHO>.Echo failed before it, and stopAfterFirstFailure ...` (the
  `NotRun: out-of-scope:` prefix, which today's code also reads as a refusal and would close the daemon on).
- **So (a) is useless as specified:** §0a's acceptance rule rejects every stopped answer (the named failure is the echo, not
  a covering test), and each is re-sent: the stop only adds cost.
- **Held** (pending the orchestrator): no build until upstream offers a stop the echo cannot trigger, which is part of the
  (c) ask relayed to alrunner — per-entry stop groups where an entry WITHOUT a group (LethAL's echo) neither triggers a stop
  nor is stopped. Then §0a's acceptance rule and the per-mutant use (prefetch included, where the saving is) build on it,
  measured as PR-223 did. Not chosen: an echo that passes and reports another way (rewrites R635's echo contract and every
  fake), or the echo in a separate request (loses same-request vouching).
- **HELD by the orchestrator (2026-11-20); PR-256 stays claimed.** The contract for the future build, from alrunner's
  `stopGroup` draft (PERF-18), replacing the opt-out ask above: (1) `stopGroup` with the stop OFF is refused, so groups are
  sent only with the stop on; (2) mixed grouped and ungrouped entries in one request are refused, so EVERY entry gets a
  group: each mutant's entries share that mutant's group, and the echo gets its OWN unique group, so its planned failure
  stops only itself. alrunner keeps both refusals (fail loudly). The build then: §0a's acceptance rule, groups per mutant
  on prefetch and live, the echo's own group, the notRun trap first, measured on PR-223's sample.
- What the builder verified for that build (kept): the capability sits beside `learnSkipAfterTimeout`'s `test --help`
  read; live single-mutant sends are `liveCall`/`aloneCall` (the NONE confirm via `lastActivated === null` needs its own
  exclusion); the walk order is `lane.plan.budgets`; stop rows must be skipped by `firstKeptRefusal`, `unkeptRowReason`,
  `serveDaemonReusable` and `batchRefusalReason`.

## 1. The contract (upstream 9835579c6, `docs/manual/tool-protocol.md`; PR #8484, f7b156fb4)
- `runTests` field `stopAfterFirstFailure` (true/false), per request; also a serve start option and a CLI flag.
- Once a test fails, the later tests of ITS codeunit are not run, and in serve neither are the LATER ENTRIES of the request:
  their tests end `notRun: true`, with a message that names the failed test and `stopAfterFirstFailure` ("so a client can
  tell them from a refusal"). Each test codeunit stops on its own; other codeunits of the same entry still run. A timeout
  or a refusal does not stop the run. Under the stop a selection runs only the tests it picks (as `--run-selected-only`).
- **Scope is the whole request**, not a group of entries (upstream: "Groups can follow as an entry field"). So in a request
  that carries several mutants (prefetch: ~20 entries of several mutants), one mutant's kill would leave the later
  mutants' entries unrun. That is why (a) limits the stop to single-mutant requests.

## 2. Design (a)
1. **Capability:** the stop is used only when the build's `test --help` (already read for capabilities) lists
   `--stop-after-first-failure`; otherwise nothing changes. A build without it is never sent the field (an unknown runTests
   field answers an error).
2. **Which requests get `stopAfterFirstFailure: true`:** ONLY a mutant request whose non-echo entries ALL carry the same
   single REAL mutant id (not NONE). Never on: prefetch requests (several mutants), kill pairs (NONE + the mutant in one
   request: a NONE failure would skip the mutant's tests), baseline, warm-up, recheck, coverage or echo-only requests.
3. **The trap, pinned FIRST (a red test before any send code):** a row with `notRun: true` is never a fail, never a killing
   test, never an `error` verdict, and never a refusal. LethAL reads `notRun`, never the row's status. A fake answer of
   [echo pass, test A pass, test B FAIL, tests C and D notRun with the stop's message] scores the mutant `killed` by B, names
   C and D as not run (skipped) with the stop's reason, and adds no error, refusal, keep-rule close, or warning.
4. **What a stopped request may not change:** the killing test is the first failing test in run order, as today (the stop
   only drops tests after it); R577's kill reproduction re-runs the mutant and must still fail by the same test; R197's kill
   ledger reads only the killing test; R612's keep rule must not treat a stop-`notRun` row as an unkept refusal; the
   R895 timeout cut and `resend` are unchanged (a timeout does not stop).
5. **Report:** no SessionReport field and no warning code (a gate figure must not move); one stderr line when the stop is
   in use (`[lethal] al-runner-v3 stop-after-first-failure on single-mutant requests (R1146)`), and a per-run count of
   requests sent with it in the serve counters' log line only.

## 3. Verification (pre-committed)
- Unit: the trap (§2.3) red first; a single-mutant request carries the field and a multi-mutant / kill-pair / prefetch /
  baseline / warm-up / recheck request never does (each red-checked); capability absent = the field never sent.
- Live (after bugs gates 9835579c6 as `current`): PR-223's 90-mutant DO sample, LethAL's own run path, before (stop off)
  and after (stop on), back to back, per mutant on the full site key: **every verdict and killing test equal**; test time
  on the requests that carried the stop recorded (no speed bound pre-committed: (a) acts on live requests only, at most
  14% of PERF-10's test time). Then it joins the combined DO run with PR-246.
- (b) is not built: worth it only on a build that keeps the engine between requests (`model-b-reading.md`); (c) is
  upstream's.
