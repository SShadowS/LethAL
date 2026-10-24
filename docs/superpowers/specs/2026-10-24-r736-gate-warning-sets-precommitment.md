# R736 pre-commitment: each gate's warning-code set

Coord task R-736, lane lethal-code. Branch `lethal/r736` (head a3645a14). Committed to master BEFORE the sets are
added to `GATE_WARNINGS` and before the proving run.

## How these were measured
Observe mode (`LETHAL_ITEST_OBSERVE_WARNINGS=1`): one run per gate on a3645a14. Each gate ended with exit 3 (an
observe run is never a pass). Logs are in `/coord/handoff/R-736/observe/`. BC gates ran on bc1, except hang on
bc3. al-runner-v3 needs no server. A key is `<gate>/<leg>`. "threw" marks a run whose own error is the expected
outcome; its codes are printed and never asserted.

## The sets (every code traced to its emitter and to why the gate triggers it)

| key | set | why |
|---|---|---|
| bcdev/first, bcdev/second | [] | clean fixture |
| bcdev-names/fenced | [] | |
| bcdev-wrapped/fenced, bcdev-wrapped/hub | [compiled-out-sites] | orchestrator `compiled-out-sites` (R214): the wrapped fixture's `#if` arms the build compiles out, by design |
| tables/first, tables/second | [non-executable-sites-dropped, not-instrumentable-files-skipped] | the tables fixture holds 1 declarative page/report property site and 1 file of a kind that cannot carry the selector (5 sites); both by design |
| chunked/control, chunked/chunked | [only-narrowed-run] | the gate runs with `--only src/DataMain.Table.al` (its slice) |
| harden/a, harden/b | [installed-dependents] | R727: Sandbox Harden has 2 published dependents (harden-tests, harden-answers) vs 1 accounted for; a true positive |
| lend/L0, L1, N0 | [] | |
| lend/R1, R2, RP | [resume-baseline-reused, resume-reusing-run] | `--resume` legs; equal to lend's own `assertCodes` |
| lend/R3 | [resume-reusing-run, snapshot-backend-build-changed] | equal to lend's own `assertCodes` |
| lend/N1 | [history-backend-build-changed] | equal to lend's own `assertCodes` |
| lend/N5 | [history-test-app-changed] | equal to lend's own `assertCodes` |
| lend/RN3, RN1d, RN2, RN4 | threw (refusal legs) | their codes are never asserted |
| verify/run | [] | |
| testapp/run | [] | |
| agreement/a, agreement/b | [installed-dependents] | agreement runs on `sandbox-harden`: the same R727 true positive as harden |
| hang/on, hang/single | [] | |
| hang/baseline | [operator-narrowed-run, tests-only-narrowed-baseline] | equal to check 11's allow-list (already pinned) |
| hang/off | [lost-ack-unreadable] | the OFF leg disables the stop, so its hanging mutant runs into LethAL's own budget; the grouped fenced path emits `lost-ack-unreadable`. The leg already asserts `deadline-exceeded` and a quarantined tier |
| al-runner-v3/S1, N1, x-s1, L1, MO, K | [] | |
| al-runner-v3/N1E | threw (expected, #5798) | never asserted |
| al-runner-v3/xd-d, xd-e, xd-f1, xd-f2, xd-f3 | [only-narrowed-run, tests-only-narrowed-baseline] | leg X's Sleep runs narrow with `--only` (1 of 4 files) and `--tests-only` (5 tests) |
| al-runner-v3/Y-A, Y-B, WR | [compiled-out-sites] | the symbol fixtures (LETHALA, LETHALB) and the wrapped fixture compile `#if` arms out, by design |

## Not pinned
- **envtool:** host-only (continia.exe). Its key stays unrecorded, so `itest:envtool` refuses by name until the
  owner runs it once in observe mode on the host, folded into R683's owner step.
- **verify-scale:** a measurement script (R270), not a gate; selectLegs never picks it. It is exempted from the rule
  by name rather than pinned.

## Prediction for the proving run (every leg, on the final head)
- Every gate passes, with exactly the sets above.
- Every frozen per-mutant figure is unchanged, since the change is gate-harness only.
- envtool is not run (host-only).
- Any extra or missing code is a BLOCK to explain before submit.
