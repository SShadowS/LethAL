# R472 probe: does `Insert(false, true)` with a copied SystemId collide?

**MEASURED 2026-10-05 on Cronus28** (BC 28.4, CRONUS Danmark A/S, tenant `default`; dev endpoint
webApiVersion 7.0; the build is not shown by the dev endpoint, and other probes this month record
Cronus28 as 28.4.53241.53758). Compiled with alc 18.0.43.1464 (linux) against System 28.0.47067.0.

## Question

`flip-boolean-literal` flips `Insert`'s SECOND argument (InsertWithSystemId) with no platform tag
(R459, R472). If code copies an existing row's `SystemId` into a record with a fresh primary key,
does `Insert(false, true)` die on the platform? And does `Insert(false, false)` assign a fresh one?

## The probe

- `table 91720 "R472 Probe Row"`: `"No."` Integer (PK), `Tag`. No `OnInsert`.
- `codeunit 91721 "R472 Probe Insert B"` (TableNo): does `Rec.Insert(false, true)` or
  `Rec.Insert(false, false)`, chosen by `Tag`.
- `codeunit 91722 "R472 Probe API"`, web service `R472ProbeApi` (registered by `codeunit 91723`,
  an Install codeunit). Each call empties the table, inserts row A (No. 1), commits, then builds row
  B (No. 2):
  - mode 1: `B.SystemId := A.SystemId`, `B.Insert(false, true)`
  - mode 2: `B.SystemId := A.SystemId`, `B.Insert(false, false)`
  - mode 3 (control): `B.SystemId := CreateGuid()`, `B.Insert(false, true)`
  - `Measure(mode)` runs B's insert through `Codeunit.Run` and reports the error code and text and
    the rows after. `Raw(mode)` runs it directly, so an error reaches the OData client unchanged.

## Results (verbatim)

| mode | call | result |
|---|---|---|
| 1 | `Insert(false, true)`, copied id | **FAILS.** `GetLastErrorCode` = `DB:RecordExists`, text: `There is already a record in table R472 Probe Row that has the same values in a unique index for the following fields: System ID='{63D06B95-E0C0-F111-A5CA-F47B8B536101}'`. Rows after: 1. |
| 1 raw | same, uncaught | HTTP 400, `"code":"Internal_EntityWithSameKeyExists"`, `"message":"There is already a record in table R472 Probe Row that has the same values in a unique index for the following fields: System ID='{67D06B95-E0C0-F111-A5CA-F47B8B536101}'  CorrelationId:  450e0caf-f7ce-489f-bd2b-ee4d613332c8."` |
| 2 | `Insert(false, false)`, copied id | **Succeeds.** Rows 2; B got a fresh SystemId (`{65D0...}` vs A's `{64D0...}`, `sameAsA=No`): BC ignores the copied id. |
| 3 | `Insert(false, true)`, fresh `CreateGuid()` | **Succeeds.** B keeps exactly the id asked for. |

So the `false -> true` flip of InsertWithSystemId on a copied-SystemId site kills through a
platform uniqueness error that names no assertion, with the same error code (`DB:RecordExists`)
and the same message shape as an ordinary duplicate primary key. The `true -> false` flip never
collides: BC writes a fresh id.

## How many mutants this touches (offline, 2026-10-05, master 1b149422)

Every `flip-boolean-literal` mutant whose literal is exactly the second argument of a two-argument
Record `Insert` (claimed, or an unresolved receiver), counted on the fixtures (17 projects), CDO
(6) and BC.History (519):

| set | `false -> true` (can collide) | `true -> false` (cannot) |
|---|---|---|
| fixtures | 0 | 0 |
| CDO | 0 | 0 |
| BC.History | **0** | 20 (17 claimed, 3 on unresolved `Rec` in `QltyCreateInspectionAPI.Page.al`) |

No source anywhere writes a literal `false` as InsertWithSystemId, so the only direction that can
collide has no site today. The 20 existing flips all write a fresh id, which mode 2 shows succeeds.

## Re-running

```bash
S=<scratch dir>; mkdir -p $S/sym && cp <a fixture's .alpackages>/Microsoft_System_28.0.47067.0.app $S/sym/
$LETHAL_ALC_DIR/alc /project:scripts/r472-probe /packagecachepath:$S/sym /out:$S/r472probe.app
bun scripts/r254-probe/publish.ts <lethal config naming Cronus28> $S/r472probe.app
bun scripts/r472-probe/drive.ts <same config>
```

`drive.ts` reads the endpoint and credentials from the config's `bcdev` block and never prints them.

**Left published** on Cronus28: `LethAL R472 SystemId Probe` by `LethAL`, id
`a2f5493c-3c9b-4b4f-ad4b-81f5a1884efa`, version `1.0.0.0`. Unpublishing is host-only
(`UnPublish-BcContainerApp`); afterwards a re-publish with a changed table set needs
`Sync-NAVApp -Mode Clean` first (the schema ghost, see `.claude/skills/al-probe`).
