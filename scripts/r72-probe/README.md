# R72 probe — what actually makes BC abort a transaction at `Codeunit.Run`?

**Answer: the RETURN-VALUE FORM of the call, and nothing else.** `Ran := Codeunit.Run(X)` with a
write transaction open aborts the transaction. A bare `Codeunit.Run(X);` statement with the same
write open does not. The call frame does not matter and a prior `Commit()` does not matter.

Measured 2026-08-08 against **Cronus281** (BC 28.0.46665.49944, `LethAL Control` 1.0.0.16), through
the **fenced** path — `LethALControl_RunMutant` at baseline (`mutantId: ""`), which is where every
verdict this tool issues is produced. Re-runnable; see "Reproducing" below.

## Why this exists

R72 was `blocked` on a contradiction between two live measurements of what looked like the same
code shape:

- **ABORTS** — `fixtures/sandbox-probes/src/WriteTxnProbe.Codeunit.al` (2026-08-02) and
  `Tier3Probe` arms M2a/M2b (R13, 2026-08-02): a write, or a bare `LockTable()`, in the `[Test]`
  method's own body, then `Codeunit.Run`. BC answers *"An error occurred and the transaction is
  stopped. Contact your administrator or partner for further assistance."*
- **SURVIVES** — `Data Commit Ops.CommitThenRun` with its `Commit()` deleted, live on the tables
  gate: a write in an ordinary codeunit called from a test, then `Codeunit.Run`, with the test
  having issued a `Commit()` of its own just before.

R72's row named the **call frame** as the candidate variable. Three things actually differed
between those two shapes, and the row named only one of them. This probe varies all three
independently.

## The design: 2 x 2 x 2, plus two controls

| factor | levels |
| --- | --- |
| prior `Commit()` in the test | absent / present |
| frame that opens the write and calls `Run` | the `[Test]` body / an ordinary codeunit called from it |
| `Codeunit.Run` form | `Ran := Codeunit.Run(X)` (return value consumed) / `Codeunit.Run(X);` (statement) |

Every arm ends in `Error('MEASURED arm=... ')`, so an arm that comes back with its OWN message did
not abort and an arm that comes back with BC's generic transaction message did. Every arm shows as
a FAILED test; that is the transport, not a broken experiment.

## Result — one factor explains all eight cells

| arm | prior `Commit()` | frame | form | outcome |
| --- | --- | --- | --- | --- |
| A1 | no | `[Test]` | value | **ABORT** |
| A2 | no | `[Test]` | statement | survives |
| A3 | no | callee | value | **ABORT** |
| A4 | no | callee | statement | survives |
| A5 | yes | `[Test]` | value | **ABORT** |
| A6 | yes | `[Test]` | statement | survives |
| A7 | yes | callee | value | **ABORT** |
| A8 | yes | callee | statement | survives |
| C1 | no write opened, value form | — | value | survives, `ran=Yes` |
| C2 | write only, no `Codeunit.Run` | — | — | survives |

- **The form decides it**, every time, in both frames and with or without a prior commit.
- **The frame is irrelevant** (A1 vs A3, A5 vs A7). This is the variable R72's row named, and it is
  measured not to be the one.
- **A prior `Commit()` is irrelevant** (A1 vs A5, A2 vs A6, A3 vs A7, A4 vs A8).
- **C1 is the control that makes the rule about the TRANSACTION** rather than about the form as
  such: the value form is perfectly fine when no write is open, and returns `Yes`.
- **C2 is the control that makes it about `Codeunit.Run`** rather than about the write or this
  probe's permissions.

## The GUARD form, measured 2026-08-08 in a second pass

The 2x2x2 above varies the ASSIGNMENT form against the bare statement and nothing else. Real AL
consumes the return value a second way, and R72's original row named it as the adversarial hole a
detector must survive: `if not Codeunit.Run(X) then Error(SomethingErr, GetLastErrorText())`. Any
detector phrased as "the return value is consumed" claims that shape too, so it was measured
rather than inferred from the mechanism.

| arm | write open first | form | outcome |
| --- | --- | --- | --- |
| B1 | yes | `if not Codeunit.Run(X) then Error(...)` | **ABORT** |
| B2 | no | `if not Codeunit.Run(X) then Error(...)` | survives, `ranFalse=No` |

B1 comes back with BC's generic transaction message, and its callstack names
`R72 Probe.B1_NoCmt_Test_Guard line 3` — the `if` line itself. The guard's `then` branch never ran:
no arm ever reported `ranFalse=Yes`. So the guard form behaves exactly as the assignment form does,
and the re-wrap hole is closed by measurement rather than by argument. B2 is the guard form's own
version of C1: with no write open the same code returns true and the test reaches its own message.

Same container, same day, same fenced path as the eight arms above.

The abort is raised at the `Codeunit.Run` line itself and the assignment never completes — the
callstack for A3 names `R72 Callee.WriteThenRunValueForm line 6`, and no arm reported
`ran=No`. That reconfirms R72's earlier finding that the refusal is NOT catchable through the
Boolean form: the caller never regains control, so the adversarial
`if not Codeunit.Run(...) then Error(..., GetLastErrorText())` re-wrap cannot hide it.

## What this settles, and what it costs

**It settles the discriminator.** A `lethal.remove-commit` mutant produces this platform artifact
when, and only when, the `Codeunit.Run` that follows the deleted `Commit()` **consumes its return
value**. That is a syntactic property of the call site, visible to the engine before anything runs,
which is a far stronger condition than the operator-plus-corroborating-text rule R72 settled for
when the trigger was unknown.

**It explains the surviving fixture mutant.** `Data Commit Ops.CommitThenRun` calls
`Codeunit.Run(Codeunit::"Data Commit Target");` as a bare statement, so it cannot produce the
artifact at all. The live gate was right and the prediction was wrong; no fixture has ever held a
site that can produce it.

**It does not build the detector**, and it does not by itself give the detector something real to
fire on: a fixture site in the VALUE form is still needed for that.

## Reproducing

```bash
ALC="$HOME/.vscode/extensions/ms-dynamics-smb.al-18.0.2498801/bin/win32/alc.exe"
# symbols: any BC 28 .alpackages carrying Tests-TestLibraries + Permissions Mock
cp scripts/r13-probe/.alpackages/*.app scripts/r72-probe/.alpackages/
"$ALC" /project:"U:/Git/LethAL/scripts/r72-probe" \
  /packagecachepath:"U:/Git/LethAL/scripts/r72-probe/.alpackages" \
  /out:"U:/Git/LethAL/scripts/r72-probe/r72-probe.app"
```

Credentials come from the gitignored `fixtures/sandbox-app/lethal.config.local.json` (`bcdev.env`),
never from a literal here — this repo is public.

```powershell
$env:DOCKER_CONTEXT='desktop-windows'
$c = Get-Content 'U:\Git\LethAL\fixtures\sandbox-app\lethal.config.local.json' | ConvertFrom-Json
$cred = New-Object System.Management.Automation.PSCredential(
  $c.bcdev.username, (ConvertTo-SecureString $c.bcdev.password -AsPlainText -Force))
Publish-BcContainerApp -containerName Cronus281 -appFile 'U:\Git\LethAL\scripts\r72-probe\r72-probe.app' -useDevEndpoint -credential $cred -syncMode ForceSync
```

```bash
bun scripts/r72-probe/drive.ts fixtures/sandbox-app/lethal.config.local.json \
  df1aa9ff-6539-4c86-a9d0-ad702b61ac9a 71543 \
  A1_NoCmt_Test_Val A2_NoCmt_Test_Stmt A3_NoCmt_Callee_Val A4_NoCmt_Callee_Stmt \
  A5_Cmt_Test_Val A6_Cmt_Test_Stmt A7_Cmt_Callee_Val A8_Cmt_Callee_Stmt \
  B1_NoCmt_Test_Guard B2_RunOnly_Guard C1_RunOnly_Val C2_WriteOnly
```

The probe owns a TABLE, so a later republish with a changed table set meets the schema ghost — see
the `al-probe` skill for the `Sync-NAVApp -Mode Clean` order. Unpublish when finished:

```powershell
$env:DOCKER_CONTEXT='desktop-windows'
UnPublish-BcContainerApp -containerName Cronus281 -name 'LethAL R72 Probe' -unInstall -doNotSaveData -force
```
