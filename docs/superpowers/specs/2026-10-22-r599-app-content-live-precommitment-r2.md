# R-599 live-check pre-commitment, amendment r2 (run 2 on bc3)

Amends `docs/superpowers/specs/2026-10-22-r599-app-content-live-precommitment.md` (c2b493a2), which stays as
written and governs everything this file does not change. Server: **bc3** only. Lane: bugs. Committed to master
by lane bugs before any run-2 step. The expected values below are fixed now; every difference is reported,
and none is re-read as "close enough".

## Why there is a run 2

**Run 1 (history, recorded as passing by lane bugs and acknowledged by the orchestrator, 2026-10-22).** Build
42c7dc7b, logs `/coord/handoff/R-599/live/{precondition,1-predict,2-refusal,3-skip,4-in-place,5-back,6-gate,7-final}.log`:
- §1: 14 of 15 apps as predicted; Sandbox Probes `publish in place`, changed only in `navigation.xml` (no `src/`): a
  reported finding, not a BLOCK. `--predict` filled the empty shared symbol cache
  `/coord/cache/bc-symbols/bc3/28.0.54946.56477-6725e7bb` (System 28.0.54946.56477, 1 file, marker verifies).
- §2 refused (`--mint sandbox-names`); §3 skipped; §4 published in place, P4 = `a8458d97-6efd-46d4-a13d-9b08d9ad8e9f`;
  §5 back, P5 = `50438019-71dc-49b2-a28b-d5ed3882609c`, second run skip; §6 `itest:bcdev-names` PASS 36 / 0 / 0;
  §7 as required. The chain of custody held.

**What changed after it.** (1) Measured offline: `navigation.xml` is not reproducible either (random `ControlGUID`
values; the order of sibling `<ActionChange/>` and of sibling `<Actions xsi:type="ActionDefinition"/>` elements).
Rulings (b) and (b'): inside `navigation.xml` only, the `ControlGUID` values are blanked and runs of those two
sibling kinds are put in a canonical order. (2) The build review's fixes I1 and M1 to M8, which touch the act path
§4 and §5 exercised. So the live proof runs again, in full, on the FINAL head.

**The offline scope check behind the rule** (`/coord/handoff/R-599/nondeterminism-5x-all.log`, no server call):
every one of the 26 apps (21 fixtures, 4 examples, LethAL Control) compiled 5 times gives ONE digest each under the
new rule. `scripts/testdata/nt-local.app`, `nt-comment.app` and `nt-resident1.app` have NO `navigation.xml`; their
digests are unchanged: `99f9d28afe4d…` (nt-local, nt-resident1) and `a56ae76c2b18…` (nt-comment). No pinned digest
moves.

## 0. Preconditions (as r3 §0, with these changes)

- The build under test is the `lethal/r599` commit named in the log's first line: the final head, containing
  7d67c45f's code and any later commit, with `bun run typecheck`, `bun scripts/verify.ts`, the three
  `bun build --target=bun` link checks and BOTH CI jobs green on that exact commit.
- The configs are r599's own, written by `bc-linux-setup.ts --write-config-only --server bc3` (no copy; the
  orchestrator's hold on other lanes' setup/republish against bc3 stays in place until §7 ends). They name the
  shared cache above; `--write-config-only` must report it filled and verified. Logged in
  `/coord/handoff/R-599/live/run2/precondition.log`.
- Everything else in r3 §0 holds (holder bc3 null and >= 10 GB before each step, own lease per tool, alc
  18.0.43.1464, `git diff --exit-code fixtures/` 0). Logs go to `/coord/handoff/R-599/live/run2/<step>.log`.

## 0b. The offline step (new; no server call, before §1)

`bun /coord/handoff/R-599/nondeterminism.ts <scratch> 5 sandbox-data,sandbox-wrapped`, then
`bun /coord/handoff/R-599/decide-offline.ts <scratch>`. It runs `decideApp` on each of the five compiles of
sandbox-data and of sandbox-wrapped against a FAKE resident set to the first build (one installed row at its
version, a target with an installed dependent, setup mode). Expected: all 10 decisions `skip`, none
`same-version-target` (row 6); `offline step: PASS (10 of 10 skip)`. Any other result STOPS the check.

## Chain of custody (replaces r3's chain values)

Run 2 starts from run 1's end state. Every step prints the Names Tests row before and after it acts:
§1 `50438019-71dc-49b2-a28b-d5ed3882609c` (P5 of run 1) → §2 → §3 → §4 before → §4 after (`Q4`) → §5 before → §5
after (`Q5`) → §5's second run → the row read before §6. Sandbox Names keeps
`392927b0-4416-440a-9d81-c93aefebec80` (1.0.20748.6262, minted by run 1's gate) from §1 to the row read before §6;
only §6's own deploy may change it. Any break STOPS the check.

## 1. Setup's prediction, read-only

`bun scripts/bc-linux-setup.ts --server bc3 --lane bugs --predict`. Expected:
- `symbols ... 28.0.54946.56477-6725e7bb (already complete, verified; 1 download)`: the cache is reused, not
  written;
- LethAL Control `already-pinned` (1.0.0.23, packageId `be7f9cf0-…`);
- **Sandbox Probes `skip`** (1.0.12.1) — the change from run 1;
- `kept` minted targets, at the versions run 1's §7 read: Sandbox App 1.0.20748.2314, Data 1.0.20748.2221, Hang
  1.0.20747.36740, Harden 1.0.20747.37990, Wrapped 1.0.20747.36977, **Sandbox Names 1.0.20748.6262** (`392927b0-…`);
- `skip` with the same digests as run 1: Sandbox Tests 1.0.0.4 `a2285781099a`, Data Tests 1.0.0.21 `3eba37763914`,
  Hang Tests 1.0.0.3 `f500a98b3b06`, Harden Tests 1.0.0.1 `cd2aeac4467e`, Harden Answers 1.0.0.1 `ac5f53aa55e4`,
  Wrapped Tests 1.0.0.5 `0e5255660a1f`, Names Tests 1.0.0.0 `99f9d28afe4d` (P5 `50438019-…`);
- every app exactly one row, installed; `predicted: nothing published, no config or launch file written, no
  doctor`; exit 0.

A difference on Control, Probes, Sandbox Names or Names Tests STOPS the check; a difference on another app is
reported (r3 §1's reading rules otherwise apply). A minted target whose version moved since run 1 (another gate
deployed it) is reported, not a STOP, if it is still `kept`.

## 2. A refusal, live, that changes nothing

As r3 §2. Expected: exit 1, `refuse above-build LethAL Sandbox Names: resident 1.0.20748.6262 above 1.0.0.0;
publish it at a minted version: --mint sandbox-names`; no publish line; Names `392927b0-…`; the Names Tests row
(read as Names' installed dependent) `50438019-…`.

## 3. Same content: skipped

As r3 §3, with the chain value: `skip`, digest `99f9d28afe4d…`, one installed row 1.0.0.0, packageId
`50438019-…` before and after; exit 0.

## 4. Same version, changed content: published in place

As r3 §4 (the same Edit-tool append of `\n// R-599 probe comment\n`). Expected: the compile line prints the local
header id `Q4`; `publish in place`, content changed in exactly `src/src/NamesTests.Codeunit.al`; resident digest
`99f9d28a…`, local **`a56ae76c2b18…`**, both compilers 18.0.43.1464; nothing uninstalled or unpublished; read-back
raw sha256 = local, digest `a56ae76c2b18…`; after row exactly one, installed, 1.0.0.0, packageId = `Q4`; exit 0. If
BC refuses the publish: STOP, as r3.

## 5. Back to the repo build

As r3 §5. Expected: `Q5` printed; `publish in place`, changed in exactly `src/src/NamesTests.Codeunit.al`,
`a56ae76c2b18…` → `99f9d28afe4d…`; read-back raw sha256 = local; one installed row, packageId `Q5`. Then the second
run: `skip`, `99f9d28afe4d…`, `Q5` before and after.

## 6. Re-prove the gate

As r3 §6: rows first (`republish --predict sandbox-names-tests`: Names Tests `Q5`, Names `392927b0-…`), then
`itest:bcdev-names` with `LETHAL_ITEST_CONFIG=lethal.config.bc3.json` under lane bugs' lease
(`/coord/handoff/R-599/run-gate.sh`), in the foreground, never signal-stopped. Expected: the target line names
`lethal.config.bc3.json` and `…:7249`; `names leg (bcdev): fenced killed=36 survived=0 noCoverage=0`, every kill
with 2 killer rows; `bcdev names itest: PASS`. Any differing verdict is a BLOCK.

## 7. The final state, read back

As r3 §7, with run 2's values: Sandbox Names Tests at its original content, digest `99f9d28afe4d…`, 1.0.0.0, one
installed row, packageId `Q5`, decided `skip`; Sandbox Names a minted instrumented build, `kept` (§6 may have minted a
new one); every other app the same decision as run 2's §1, **Sandbox Probes `skip` included**; the cache still
`already complete, verified`; `git diff --exit-code fixtures/` 0.

## What run 2 does not prove (in addition to r3's list)

- That no OTHER nondeterministic entry exists in an app outside the 26 measured, or in a later alc. The digest
  refuses no new kind by itself: such an app would show as `publish in place` naming the entry, every run.
- Setup's act pass on bc3 (still `--predict` only there).
