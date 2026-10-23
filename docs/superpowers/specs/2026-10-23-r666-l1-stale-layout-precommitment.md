# R-666 pre-commitment: leg L1 proves v3's stale-layout check (both coverageIndex guards), shown live by L-R3

Source: plan r1 (`/coord/handoff/R-666/plan.r1.md`) and the measurement (`/coord/handoff/R-666/measure.md`). It is
SMALL by the orchestrator's ruling of 2026-10-23: tests and docs only, plus one live red check. Committed to master
by lethal-code BEFORE L-R3 runs.

## 1. What changes

**No figure, baseline or leg code changes.** Leg L1's STATED PURPOSE is corrected:
- R666 said R349's stale-layout check was LOST with v2, because L1 stayed green under two reverts. That was wrong.
- v3 labels batch-1 coverage with the deployed flat file and the INSTRUMENTED line numbers (`TwiceOfThree`: 71, 73
  and 79 of 83). So a stale batch-0 index does misread batch 1, just as R353 predicted.
- `coverageIndex` has TWO guards, and either one is enough: `resetLayoutState` clears it, and `deploy()` assigns the
  new index every time.
- **L1 proves the two guards together.**

## 2. Single-guard controls (already measured, green; not re-run)

- **L-R1** (R-654 S2, `/coord/handoff/R-654/s2-live-LR1.log`): `resetLayoutState()` was deleted from `deploy`. L1
  stayed green, because `deploy()` still assigns the new index.
- **L-R2** (`s2-live-LR2.log`): `this.coverageIndex ??= index`. L1 stayed green, because the reset had just cleared
  the field, so `??=` assigned anyway.

## 3. L-R3, the live red check of both guards (a prediction)

Run in a SCRATCH copy of the R-666 head, never in a gate worktree, on alpha.2 (`current`), with no BC:
1. Edit `packages/runner/src/al-runner-v3-backend.ts`:
   - delete `this.coverageIndex = undefined;` in `resetLayoutState`;
   - change `this.coverageIndex = index;` to `this.coverageIndex ??= index;` in `deploy`.
2. Run `LETHAL_ITEST_ALRUNNER_V3=1 LETHAL_ITEST_V3_LEGS=L1 bun run itest:alrunner-v3`.
3. **Predicted RED, exit 1:**
   - `leg L1: GATE-FAIL`, with L1 at **5 / 5 / 0** against the pre-committed 7 / 3 / 0 over 10;
   - **1/M0006 and 1/M0007 `survived`**, covering `[Layout Tests.GrowAboveTen]`, attribution `exact`;
   - six `position wins (R383)` warnings for `LayoutBeta.Codeunit.al` lines 10, 16, 22, 28, 36 and 37;
   - every other row as pre-committed.
   - No refusal by name before a verdict is predicted, because batch 0's index knows the file. If one fires, it is
     recorded by name.
4. Restore the file and re-run step 2. **Predicted PASS, 7 / 3 / 0.**

Logs: `/coord/handoff/R-666/live-LR3.log` and `live-LR3-restored.log`.

**Stop:** an L-R3 result other than the predicted red, or a restored run that is not PASS 7 / 3 / 0.
