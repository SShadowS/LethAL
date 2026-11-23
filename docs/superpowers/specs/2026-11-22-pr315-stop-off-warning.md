# PR-315 pre-commitment: warn before every bcdev run without `--stop-hung-sessions`, and a doctor check (R1171, GitHub #52)

Status: pre-commitment (coord PR-315, lethal-preproc, 2026-11-22), after the build, before review and gates. Branch
`lethal/pr-315`. Ruling: option (c) of R1171 (owner question q-20261122T001447-398e02e9, answered by kraken from the
mantra; the owner may overrule). The default stays OFF (R1064).

## The change
- **The warning.** A new warning code `stop-hung-sessions-off`, once per run, before the first mutant is dispatched, when
  the backend is bcdev and the stop is not on.
  - The text says what a hang does without the stop (it quarantines the tier instead of scoring `timeout-killed`), what it
    cost on #52 (12 of 17 mutants; `lethal clear-quarantine` and `lethal force-reset-lease` to recover), the one-line fix
    (`--stop-hung-sessions`, or `"stopHungSessions": true` in the `bcdev` section, which an `envTool` config ignores), and
    why it is off (it ends a hung session on the server: the server owner's call).
- **Where it fires.**
  - `runSession`, next to `hang-capable-sites-deployed`, when `isBcdev(backendName)` and `cfg.stopHungSessions !== true`.
  - `runNamedMutantsBody`, after the lease scope opens, when the backend is bcdev and `backend.stopsHungSessions?.()`
    is not `true`. `BcDevMcpBackend.stopsHungSessions()` reads its construction config. A backend without the method
    reads as off.
  - `lethal verify` reaches it through its one `runNamedMutants` call, so it warns once. `runSession` never calls
    `runNamedMutants`, so no run warns twice.
  - Never for al-runner-v3, and never with the stop on.
- **The doctor check `stop-hung-sessions`.** Doctor has no advisory level, so the check is `ok: true` in every case and
  never fails `lethal doctor`.
  - With the stop off, its detail starts `OFF (advisory, not a failure):` and gives the same text.
  - With it on: `on: a hung mutant's session is ended on the server.`
  - Under an `envTool` config it adds that only the flag works.

## Predictions: the gate warning sets that move (`GATE_WARNINGS`, codes only)
Traced from the itest source. A leg gains `stop-hung-sessions-off` when its bcdev backend is built in the itest without the
stop and its session reaches the emission point.
- **Gain it (30 keys):**
  - bcdev/first, bcdev/second; bcdev-names/fenced; bcdev-wrapped/fenced, bcdev-wrapped/hub;
  - tables/first, tables/second; chunked/control, chunked/chunked; harden/a, harden/b;
  - lend/L0, L1, N0, R1, R2, RP, RL, R3, N1, N5;
  - verify/run; testapp/run, testapp/step6, testapp/step7; agreement/a, agreement/b, agreement/named;
  - hang/off, hang/baseline. `hang/baseline` also moves `HANG_BASELINE_WARNING_CODES`.
- **Unchanged:**
  - verify/step3, step4, step4b and agreement/verify: `verifyFromCli` reads the setup-written config, which sets the stop
    on bc1-bc4 (PR-42, `scripts/bc-linux-setup.ts`);
  - hang/on, hang/single: the stop is on;
  - every al-runner-v3 key.
- **Lend's early-refusal legs** (RN1d, RN2, RN3, RN4) refuse before the generate phase and have no key: nothing moves.
- **envtool** has no `GATE_WARNINGS` key (an existing gap). Its backend runs bcdev with the stop off, so its first
  recording must include the code.
- **No verdict, figure, frozen baseline or report field moves.** Only warning events are added, so the characterization
  snapshots (`orchestrator.test.ts.snap`, `resume.test.ts.snap`) gain the event and shift `seq` numbers, and nothing else.
- Any other difference in a gate is a BLOCK.

## Tests (each red when its named condition is reverted)
- `orchestrator.test.ts` (PR-315 describe):
  - `runSession` warns once on bcdev with the stop off;
  - not with it on;
  - not on al-runner-v3;
  - the text names the switch, the config field, #52 and both recovery commands;
  - `runNamedMutants` warns once with the backend's stop off, once when the backend cannot say, and not with it on.
- `pr315-doctor-stop-hung-sessions.test.ts`: advisory when off, ok when on, the envTool wording. `doctor-cli.test.ts`:
  the check list ends with it.
- `hang-baseline-leg.test.ts` and `gate-warnings.test.ts`: the sets above, sorted and unique.
