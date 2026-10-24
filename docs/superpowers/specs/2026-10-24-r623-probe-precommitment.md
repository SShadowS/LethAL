# R-623 (roadmap R623, R605): pre-commitment for the dev-endpoint publish probe (2026-10-24)

Written BEFORE any server call. Probe: `scripts/r623-probe/drive.ts` (lethal/r623, 6f726044), run on **bc2** under
lethal-preproc's lease. Two invented, table-free apps, publisher "LethAL Probe", read back by app id only (never a
list of all extensions):
- **A, "R623 Probe Target":** app id `3543fecd-9a43-4256-a10d-8d6df316c223`, ids 91800-91809.
- **B, "R623 Probe Dependent":** app id `5ea135b0-2061-4c4c-9be0-d3c8a17a9182`, ids 91810-91819; depends on A
  >= 1.0.0.1.

Build sha256s (`.kraken-local/r623-probe/shas.json`; the run uses exactly these files, with no rebuild):

| build | sha256 |
|---|---|
| tX1 (A 1.0.0.1, returns 1) | 2a077504c31a881186b319a75e12826f868615f65215819c111d8514cf436014 |
| tY1 (A 1.0.0.1, returns 2) | e9cd19374a89f1aeb502826bafef0b051ee70672c6e01c366b5474061371e55c |
| t5 (A 1.0.0.5) | 72d01dcb276f537bd5382d99b495a55e5bc1de4aaee89a8213cc47c555033840 |
| t2 (A 1.0.0.2) | 21f4eca1e3d73d30524b8b763610f057b4197ebbb3822661f1894ba881bfb5e7 |
| t6 (A 1.0.0.6) | 788cd642cfa6ee5969573e028f275f76ea492a50e5af452edfbaafeb1ae6be9b |
| dep (B 1.0.0.1) | bedd95cb723fc2351f0822d24a40eb4b8e64dc086de69da6f254d7f398ec7cb5 |

**Questions.**
- **R623:** may `decideApp` row 6 (`scripts/bc-app-content.ts`: same version, other content, an installed dependent)
  go on to row 7 (publish in place) instead of `refuse same-version-target`?
- **R605:** does the dev endpoint refuse a publish below the installed-version record after uninstall + unpublish, and
  does a publish above it work?

**Limits stated now.**
- The probe cannot EXERCISE B (no web service), only read its installed state.
- R623's "the gate that uses it still passing" is not shown by a probe app. If row 6 changes, the fixture gates that
  read setup run on the final head.

## Readings, per step
**Step 1** (publish A tX1, then B).
- Both accepted, one installed row each at 1.0.0.1, and the resident bytes equal the built bytes: go on.
- Anything else: the probe is wrong, or the server holds stale state. Stop, with no conclusion.

**Step 2** (A tY1 in place, with B installed). This step decides R623.
- **(a)** Accepted, A has ONE installed row at 1.0.0.1 whose bytes equal tY1 (the packageId changed), and B is still
  installed: row 6 may go to row 7. Close R623 by code, keeping a test, with this measurement as the reason.
- **(b)** Accepted, but A's bytes are still tX1 (a silent no-op): keep the refusal, with the no-op as its reason.
- **(c)** Accepted, but B is no longer installed, or A has two rows or is not installed: keep the refusal, with the
  measured damage as its reason.
- **(d)** Refused (any status): keep the refusal, quoting BC's message as its reason.

**Step 3** (A t5, an upgrade, with B installed).
- Accepted, with A at 1.0.0.5 installed and B still installed: the record is now 1.0.0.5. Go on.
- Refused, or B uninstalled: a new finding, filed as a roadmap item. Step 5 does not run.

**Step 4** (uninstall + unpublish B, then A, through the automation API).
- Every call 204, and both absent by id: go on.
- Otherwise: stop and record.

**Step 5** (A t2, 1.0.0.2). This step decides R605.
- **(a)** Refused 422, with "a newer version 1.0.0.5 was already installed": R605 is confirmed on bc2. Keep `refuse
  above-build` and `--mint`, and close R605 by ruling with the measurement.
- **(b)** Accepted, with A at 1.0.0.2: R605 is not reproduced for a probe app. Correct R605's text, and keep it open
  for the minted-version case.
- **(c)** Refused with another message: record it. The mechanism is not the one filed.

**Step 6** (A t6, 1.0.0.6, above the record).
- Accepted, with A at 1.0.0.6 installed: only an upward publish works, which is what `--mint` does.
- Refused: stronger than R605 says. File a new item.
- If step 5 was (b), this step says nothing about the record.

**Cleanup** (B, then A, removed and read back absent).
- **Leftover, stated now:** bc2 keeps the installed-version record for A (the highest accepted version) until a
  restart. A later probe of this app id on bc2 must publish above it.

**Rule.** An outcome not listed here is reported as it came, and no reading is applied until a new pre-commitment
is written.
