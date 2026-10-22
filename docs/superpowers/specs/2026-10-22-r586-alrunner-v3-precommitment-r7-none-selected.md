# R-586 pre-commitment r7 (R-632): `none-selected-exit` becomes a defect fact

This was drafted on 2026-10-22 by the R-632 builder. The draft came BEFORE any code for it and before any live run.
Lane bugs committed it to master before B's code and before any live `--regate`.

It is a delta on `2026-10-21-r586-alrunner-v3-precommitment-r6.md` (c7c505e6). Everything in r6 and the earlier
deltas stands, except what is below. A differing fact verdict in leg C is still a BLOCK.

## What changes

- **`none-selected-exit` moves from kind `contract` to kind `defect`.** It records the state of an upstream defect
  that LethAL filed: [#5613](https://github.com/aldevtools/BusinessCentral.AL.Runner/issues/5613). In R586's defect
  table this is row 13, "Exit 6 writes no `--output-json` document".
  - Upstream PR #5622 fixed it. It was merged at 16:50Z on 2026-10-21 and is in alpha.4. Its note: "`--output-json`
    now writes the document when the selection matches no test (exit 6). The document has no rows, all counts are
    0, and `warnings` says why."
  - Coded as a contract fact, this fix, which LethAL itself asked for, read as `diverged`, and so as `gate-fail`.
    That broke ruling I-2: "a defect gone is `held`, never a blacklisting".
  - That is how alpha.4 and edge-7739d8132 went to `failed/` on 2026-10-22 (diagnosis
    `/coord/handoff/al-runner-v3-update/diagnosis-2026-10-22.md` §2).
- **The new rule, on the probe call `--codeunit 0`.** The probe always passes `--output-json`, so the document goes to
  stdout.
  - `defect-present`: exit 6 and an empty stdout, so no document. This is what alpha.2 and alpha.3 did, as measured.
  - `gone`: exit 6 and a document that parses to 0 rows (`tests: []`). This is #5622's fix.
  - `diverged`: anything else. That includes exit 6 with output that does not parse, exit 6 with rows, and any other
    exit code. A `diverged` defect fact refuses the session (r6) and is `gate-fail` in leg C.
- Leg C's `DEFECTS` list gains `none-selected-exit`, so it now has 8 names.
- **The backend is not affected.**
  - On exit 6 it throws `AlRunnerV3SelectionError` and never reads the document.
  - `v3ContractRefusals` does not refuse on `gone`. It prints `al-runner-v3-defect-gone` through `v3DefectWarnings`.

## Figures that move

- Leg C still has **23 facts**. None is added or removed.
- Defect facts go from 7 to **8**. Contract facts go from 16 to **15**.
- On alpha.2 the fact reads `defect-present` where it used to read `matches`. Leg C's outcome does not change: `pass`.
- r6's summary list of facts that read `defect-present` gains `none-selected-exit`.

## Checked: is any other contract fact a filed defect?

Each contract fact was checked against R586's defect table and against the plan's §8 table, which maps each defect
to a fact. `none-selected-exit` is the only contract fact that IS the fact of a defect row.

Two other contract facts sit next to defects that #5622 also closed. This delta changes neither of them, but one is a
risk on alpha.4:
- **`predefined-symbols`** (row 15, #5615). #5622 says "No `CLEANSCHEMA<n>` symbol is predefined", and the fact
  expects none, so it should stay `matches`. This is inferred from the PR notes.
- **`refusal-row-shape`** (row 7, #5608). This one is a risk.
  - The probe's `HttpGet` calls `http://localhost:1/x`.
  - #5622 says that since corpus bump 43, a request BC fails without a connection (an internal address and the
    like) fails with BC's own error. Only a request BC would really send stays refused.
  - If v3 treats `localhost:1` as such an internal address, `HttpGet` is no longer `notRun` and the fact reads
    `diverged`.
  - alpha.3 read `matches` on 2026-10-22.
  - It is NOT measured on alpha.4.
  - If it reads `diverged`, that is the same mistake as `none-selected-exit`: a fix to a filed defect read as a
    contract break. It is then REPORTED as such, and it needs its own delta. It is outside R-632's approved scope.
  - It changes no overall prediction below, because the D legs decide first.

## Predictions for `--regate` on the final R-632 head, and for the gates after it

Every prediction says what it rests on. "Measured" means a run showed it. "Inferred" means it comes from code,
release notes or another build.

1. **`--regate <final head>` gates `current` (alpha.2, 91253f2d6). Predicted: `pass` on all eight legs.**
   - **Leg C:** 23 facts. `none-selected-exit` reads `defect-present`, the 7 other defects read `defect-present`,
     and every contract fact reads `matches`. This was measured on alpha.2 at 8a71e87d
     (`/coord/handoff/R-586/gate/final/`); only the classification changes.
   - **D1 and D1c** now run, because fix A passes `LETHAL_ITEST_V3_CDO`. Its default is `/work/lethal-wt/cdo-r396`,
     at 5f2a71d, with no symlinks under it. They were measured at 63 of 63 equal to BC on alpha.2. They are a corpus
     job, so they count toward the container's two-heavy-job limit.
   - **Inferred, not measured:** the other legs at the new head. The head carries about 128 commits since 8a71e87d,
     including changes to the orchestrator, the store and R-631's link walker. No leg is expected to move. Any move
     is a BLOCK to investigate, never a reason to re-record.
   - **On `pass`,** `current/.gated` takes the new commit. Nothing moves in `failed/` or `held/`.
2. **alpha.3, gated at the new commit by the next alpha run. Predicted: `gate-fail` on D1 and D1c.**
   - The cause is #5606: the pre-commitment's `v3-alpha3-companyopen` row, "all 63 CDO mutants `error` on alpha.3".
     It was measured on alpha.3 before the pin ruling.
   - Leg C on alpha.3: `pass`, because exit 6 comes with no document, which reads `defect-present`. It was measured
     on 2026-10-22 under the old classification, where the fact read `matches`; the observable is the same.
   - It goes to `failed/v3.0.0-alpha.3@<new head>`, now with its `receipt.json` (fix C). This is a CORRECT
     gate-fail.
3. **alpha.4, after that. Predicted: `gate-fail` on D1 and D1c (#5641). Inferred.**
   - #5641 (row 17) was measured on upstream main at 93415c0bb, which is an ancestor of 7739d8132. Its fix (#5668)
     is not in 7739d8132. It is not measured on alpha.4. That would be a CORRECT gate-fail.
   - **Leg C on alpha.4:** predicted `held`, not `gate-fail`. Five defect facts are inferred from the release notes
     to read `gone`: `none-selected-exit`, `duplicate-key-insert-raises`, `refusal-cascade`,
     `quoted-name-unselectable` and `sleep-is-noop`. The `refusal-row-shape` risk above could make leg C `gate-fail`;
     if so, it is reported as the wrong-reason case. Either way, the D legs make the build `gate-fail`.
4. **edge-7739d8132: NOT judged again by `--edge`.**
   - `edgeOnce` does nothing while `edge.last-seen` reads `7739d8132`. Upstream's `edge` has moved on, so the next
     `--edge` gates `edge-<new sha>`, a new key.
   - Judging 7739d8132 itself again would need `edge.last-seen` cleared by hand. R-632 does not touch the state
     directories, so that is the orchestrator's call.
   - It is the same commit as alpha.4, so the alpha.4 prediction (`gate-fail` on #5641, inferred) stands for it too.
5. **The first build that can be `held` or `pass`** is an edge or alpha build that contains #5668, provided
   `refusal-row-shape` holds.
