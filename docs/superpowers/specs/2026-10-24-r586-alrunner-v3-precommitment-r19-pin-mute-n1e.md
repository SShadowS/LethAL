# R-586 pre-commitment r19 (R-719, R-722): pin-covered session warnings and the N1E leg, judged in advance

DRAFT for review. Not committed. Master path when committed:
`docs/superpowers/specs/2026-10-24-r586-alrunner-v3-precommitment-r19-pin-warnings-n1e.md` (re-check r19 is still the next free number against origin/master).
Commit it alone, `[skip ci]`, from a scratch origin/master worktree, before any live run of the new code.

Written by lane bugs on 2026-10-24 from the built code and READING ONLY. No gate, probe or al-runner call was run.

Delta to r18 (`docs/superpowers/specs/2026-10-24-r586-alrunner-v3-precommitment-r18-build-pins.md`). Everything there stands except what is named here. A differing reading is still a BLOCK.
This delta supersedes one sentence of r18: "The pin is used by the gate only; a user session is unchanged." A session now reads the pin, for what it PRINTS only (R719).

## R719: pin-covered session warnings

Code: `pinnedDefectCoverage` in `packages/runner/src/al-runner-v3-pins.ts` (the pin table moved there from `itest/`; `findV3Pin` and every pin value are unchanged), read by `AlRunnerV3Backend.status()`.

A session skips an `al-runner-v3-defect-gone` or `al-runner-v3-defect-refused` line only when ALL hold:
1. the binary's `--version` line AND sha256 equal a pin (`findV3Pin`);
2. that pin names the fact in `legC`;
3. the pin's verdict for it equals the verdict just read (`gone` for the six, `refused` for `duplicate-key-insert-raises`);
4. the fact's `measured` text matches the pin's pattern (and its `extra` check, for `sleep-is-noop`).

Conditions 2 to 4 are one function, `pinnedFactMatches`, which the update gate's leg C (`classifyLegC`) uses as well: the mute is never wider than the gate's own pin match.

Anything else still warns, as before: an unpinned fact, another outcome of a pinned fact, a pinned fact with another measured text, the same fact on another sha, any fact with no pin. Unmeasurable and unlike-bc lines are never muted.
The pinned build prints ONE line instead, so it is never silent: `[lethal] al-runner-v3 pin alpha.5-07342060e covers 7 facts (#5700, #5788, R586c)`.

Predicted on alpha.5 (`al-runner 3.0.0-alpha.5 (07342060e)`, sha256 `fd4d6d40...51db2`) at the final head:
- a session prints that one line and none of the 7 `al-runner-v3-defect-*` warnings;
- no verdict, report field, gate figure, receipt or `.gated` content changes. R719 changes console text only.
- an alpha.2, alpha.3 or alpha.4 session prints its warnings exactly as before (no pin).

## R722: leg N1E

New leg `N1E`: the names fixture (`sandbox-names`, `sandbox-names-tests`), the same project as N1, run with `transport: serve-entries` whatever the run's own transport is. It is a default itest leg after N1 (so also an agentflow sub-leg) AND a leg of `V3_GATE_LEGS` (14 legs now): the update gate reads it, so a build that fixes #5798 reads `held`, never silence. alpha.2 has no serve-entries path, so `judgeN1Serve(r, version)` knows it by name: `V3_NO_SERVE_ENTRIES = ["alrunner 3.0.0-alpha.2 (91253f2d6)"]` (the exact line of its `.gated`). On that version, the refusal `the request was refused: "unknown field \`entries\` for runTests"` reads `pass` with "not applicable: this build has no serve-entries path". Any other build refusing `entries` is `gate-fail`.

Reading on alpha.5 (measured before, `/coord/handoff/R-586c/measure/N1-serve-alpha5.log`, upstream #5798): the session throws, and the error text carries
`the entries answer is invalid: a test line without v3's row shape: {"durationMs":0,"entry":"NONE|78850","name":"Codeunit78850.Dot.Step","status":"pass","type":"test"}`:
the line has no `codeunit` and no `method`.

| Reading | Outcome |
|---|---|
| that refusal, the line is `Codeunit<n>.Dot.Step`, no `"codeunit"` and no `"method"` key | `pass` (as pre-committed) |
| the session completes | `held`: "re-pre-commit: upstream may have fixed #5798" |
| the same refusal, but the line now has `"codeunit"` or `"method"` | `held`, same text |
| the shape refusal for another test | `gate-fail` |
| the same refusal, row with only `"codeunit"` / only `"method"` | `held` (each tested alone) |
| alpha.2 (exact version line) and the `unknown field entries` refusal | `pass`, "not applicable: this build has no serve-entries path" |
| any other version with that refusal | `gate-fail` |
| any other error (a batch refusal, a timeout, anything) | `gate-fail` |

Never a silent pass: apart from the alpha.2 not-applicable row, no reading other than the first is `pass`.
Judge: `judgeN1Serve(r, version)` in `packages/runner/itest/alrunner-v3-legs.ts`; tests `packages/runner/tests/r722-n1-serve.test.ts` (offline, fakes: refusal pass, completed held, codeunit-only and method-only rows held, alpha.2 plus unknown-field pass, other version plus unknown-field gate-fail, other error gate-fail, and `gateOutcome` with N1E held and the rest passing = held).

## The full v3 gate at the final head, on alpha.5 under its pin

Predicted: every leg passes, N1E included. Leg list: C, S1, S3, N1, N1E, X, L1, Y-A, Y-B, MO, WR, K (K as r18 L2 on a candidate; a gated run passes it), plus D1, D1c with the corpus and T with tables.
- The 13 other legs of `V3_GATE_LEGS` (14 with N1E): figures exactly as r18 (the pinned reading in C, X (b) and T). Nothing in this change touches them. Leg C's pin match now goes through `pinnedFactMatches`, with the same condition as before.
- N1E: `pass` with the line above.
- Update-gate outcome: `pass` (the gate now reads N1E).
- **alpha.2 `--regate`** (version line `alrunner 3.0.0-alpha.2 (91253f2d6)`): N1E reads `pass`, "not applicable: this build has no serve-entries path"; every other alpha.2 figure is as before, so its outcome is unchanged.
- Any other candidate build that cannot take `entries` reads N1E `gate-fail`.
- Under `LETHAL_ITEST_V3_TRANSPORT=serve-entries` the other legs are as r18/L3 (N1 itself still fails, #5798, as already measured); N1E does not depend on that variable.

Any other reading of any leg is a BLOCK. A `held` N1E on alpha.5 means upstream changed: stop and re-pre-commit.
