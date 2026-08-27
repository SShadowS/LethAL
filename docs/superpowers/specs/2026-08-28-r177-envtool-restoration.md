# R177: restoring `itest:envtool`, with the disagreement pre-committed

Written BEFORE the restored gate ran. Nothing above the OUTCOME line is edited afterwards.

## 0. Why this needed a pre-commitment at all

This gate shares `fixtures/sandbox-app` with `itest:bcdev` and exists to prove one thing: reaching BC
through an external environment tool (Layer 6C) changes no verdict. That proof is worthless if the
baseline is re-derived from the first run that happens to succeed. A matching 3/12/4 looks identical
whether the indirection preserved the verdicts or quietly changed WHICH mutants they belong to, which
is exactly the confusion `refuseSelfRecordWhileUnverified` was added to block.

So the disagreement is predicted here, by identity key, before the run.

## 1. The environment, which is new and is NOT the one the old figures came from

The previous environment expired and was DELETED on 2026-08-26. A replacement was created 2026-08-28:

| | |
| --- | --- |
| id | `424c584e-d187-415a-a7b9-ae0883f919bf` |
| name | `LethAL-gate` |
| profile | `e7ef5985-70b4-4a82-a4ed-88d2fa2d93ff`, BASE Business Central 26.0 |
| build | `26.0.30643.41469`, platform `sandbox` |
| expires | 2026-09-10 |

**It is a different BC build from the one the stale baseline was recorded against, and that is a real
confounder**, so it is stated rather than glossed: a verdict that moves could be the indirection or
could be the platform. The fixture needs runtime 13.0 (BC 22+), so 26.0 is in range. It is also a
DEDICATED environment rather than one of the six real work environments on the account, because the
gate publishes the fixture app and a mutant-instrumented build into whatever it targets.

## 2. The three unverified moves, CONFIRMED against `itest:bcdev` on the same day

`itest:bcdev` was run 2026-08-28 and PASSES at 19 sites, killed 3 / survived 12 / no-coverage 4.
`UNVERIFIED_MOVES` names three things to confirm BY NAME, and all three are confirmed:

| move | predicted | measured 2026-08-28 | where |
| --- | --- | --- | --- |
| R159 `remove-assignment` at `Sandbox Logic.LogAudit` | survived | **survived** (M0015) | `SandboxLogic.Codeunit.al:23`, the self-assignment `Amount := Amount` |
| R159 `shift-integer` at `Sandbox Logic.LogAudit` | survived | **survived** (M0013) | `SandboxLogic.Codeunit.al:22`, `if Amount <> 0` becomes `<> 1` |
| R164 `loop-truncate` adds NOTHING here | 0 sites | **0 sites** | `sandbox-app` contains no `repeat` AND no `while`, grepped |

Line 20 is `local procedure LogAudit(Amount: Decimal)`, so lines 22 and 23 are inside it. That is the
check that matters: a matching COUNT would not have told the two operators apart.

## 3. The prediction: exactly two ADDED mutants, nothing else moves

The committed baseline holds **17** mutants (killed 3 / survived 10 / no-coverage 4). The restored
run must produce **19** (killed 3 / survived 12 / no-coverage 4). The per-mutant comparison must
therefore report exactly this and nothing else:

```
ADDED   : <hash>|Sandbox Logic|LogAudit|lethal.shift-integer|1      -> survived
ADDED   : <hash>|Sandbox Logic|LogAudit|lethal.remove-assignment|1  -> survived
REMOVED : none
CHANGED : none   (all 17 existing keys keep their verdict)
```

The 17 that must not move, by identity key, are the contents of
`packages/runner/itest/envtool.baseline.json` at commit-time: 8 on `Sandbox Logic` procedures
`ClampPercent`/`ApplyAudit`/`LogAudit`, 3 killed on `IsOverBudget`, 4 no-coverage on
`Sandbox Pricing.DiscountedPrice`, plus the two `LogAudit` `empty-block` entries.

## 4. What would REFUSE the restoration

- **Any REMOVED key.** The indirection dropped a mutant the direct backend finds.
- **Any CHANGED verdict.** This is the finding the gate exists to produce, and it would mean Layer 6C
  changes a verdict. It must NOT be re-frozen; it must be investigated.
- **An added mutant that is not one of the two named above.**
- Totals matching 3/12/4 while the per-mutant set differs. This is the failure mode the whole row is
  about, and it is why the aggregate is not the check.
- A verdict difference that could be the BC 26.0 build rather than the indirection. Then the honest
  move is to say so and NOT claim the indirection is proven.

## 5. Only then

Clearing `UNVERIFIED_MOVES` and re-recording the baseline happen in ONE commit, together, as the
guard's error message instructs. Not before.

---

## AMENDMENT, 2026-08-28, BEFORE the gate ran. Section 1 is superseded, not edited.

The BC 26.0 environment `424c584e-...` was created, started, and REFUSED the publish:

```
Publishing failed ... The runtime version of the extension package is currently set to '16.0'.
The runtime version must be set to '15.2' or earlier ... to install on this server.
```

`extensions/lethal-control` is runtime 16.0, which needs BC 27 or newer. BC 26 was my error. The
replacement is **BC 28.0**, which is a better choice than the original for a reason worth stating:
the local `itest:bcdev` container is BC 28.0.46665, so the two gates now run the same major platform
and the confounder §1 flagged (a verdict difference that could be the platform rather than the
indirection) is largely removed rather than merely disclosed.

| | |
| --- | --- |
| id | `097b33c9-129a-40a6-bd9d-e71ea1579ac0` |
| name | `LethAL-gate-bc28` |
| profile | `2f9f7256-f51c-402e-bac9-e15848895211`, BASE Business Central 28.0 |
| build | `28.0.46665.48632` (bcdev container: `28.0.46665.47126`, same build, later revision) |

**Nothing in sections 2, 3 or 4 changes.** The prediction was never platform-specific: it is that
this gate reports the same 19 mutants with the same verdicts as `itest:bcdev`, and the two additions
are named. If anything, a matching platform makes a divergence HARDER to explain away.

---

## AMENDMENT 2, 2026-08-28, still BEFORE the gate ran. Two dead ends, recorded as requirements.

The BC 28.0 BASE environment `097b33c9-...` published the control app fine and then failed:

```
HarnessVerificationError: HarnessInfo failed: HTTP 404
The company "CRONUS Danmark A/S" does not exist.
```

Both `lethal.config.envtool.json` and `lethal.config.local.json` name `CRONUS Danmark A/S`, so
`itest:bcdev`'s container is DK-localized and the gate's fixture expects that company. A W1/BASE
environment does not have it.

**So restoring this gate has two hard requirements that were nowhere written down, and both were
found by hitting them:**

1. **BC 27 or newer.** `extensions/lethal-control` is runtime 16.0; BC 26 caps at 15.2 and refuses
   the publish outright.
2. **DK localization.** The company `CRONUS Danmark A/S` must exist, which BASE/W1 does not provide.

The third environment, and the one the gate actually ran against:

| | |
| --- | --- |
| id | `e77394cb-fd23-4abb-9f04-dd83f5f64909` |
| name | `LethAL-gate-dk28` |
| profile | `c803cb93-a8e4-4fb1-b61f-e5f60f17b43a`, DK Business Central 28.0 |
| build | `28.0.46665.48632` (bcdev container: `28.0.46665.47126`) |

This is now as close to `itest:bcdev` as a hosted environment gets: same BC major.minor.build, same
localization, same company. The platform confounder §1 raised is as small as it can be made, and what
remains is a revision difference.

**Sections 2, 3 and 4 still stand unchanged.** The prediction is per-mutant and was never
platform-specific.

---

## OUTCOME, appended after the run. Nothing above is edited.

**RESTORED AND PASSING. Every prediction in §3 matched, and §4 refused nothing.**

### The run

19 mutants, **killed 3 / survived 12 / no-coverage 4**, `baselineGreen: true`.

The per-mutant comparison against the stale 17-mutant baseline reported exactly what §3 said it must:

```
ADDED   : <hash>|Sandbox Logic|LogAudit|lethal.shift-integer|1      -> survived
ADDED   : <hash>|Sandbox Logic|LogAudit|lethal.remove-assignment|1  -> survived
REMOVED : 0
CHANGED : 0
```

### The check that mattered, which is not the totals

The 19-mutant table is **IDENTICAL to `itest:bcdev`'s run on the same day** — same mutant codes, same
files, same lines, same operators, same verdicts, diffed mechanically rather than read side by side:

```
IDENTICAL: all 19 mutants match bcdev exactly (code, line, operator, verdict)
```

That is this gate's whole claim: reaching BC through an external environment tool (Layer 6C) changes
no verdict. A matching 3/12/4 would have looked the same even if the indirection had changed WHICH
mutants those were, which is why §3 predicted identity keys and not counts.

### What was restored, and the two requirements found by hitting them

Three environments were created before one worked, and the two failures are now recorded as
REQUIREMENTS on [[R177]] because neither was written down anywhere:

| environment | outcome |
| --- | --- |
| BC 26.0 BASE | publish REFUSED: `lethal-control` is runtime 16.0, BC 26 caps at 15.2 |
| BC 28.0 BASE | harness 404: the company `CRONUS Danmark A/S` does not exist on W1 |
| **BC 28.0 DK** | **works** |

A fresh environment also needs the fixture apps bootstrapped: LethAL publishes the instrumented
TARGET on every run, but the TEST app is the user's own workflow, so on a brand-new environment the
tests app fails to compile with `AL0185: Codeunit 'Sandbox Logic' is missing` until the baseline
target is published once by hand.

### The re-freeze, done the way the guard demands

`UNVERIFIED_MOVES` cleared and the baseline re-recorded in ONE commit, after the three moves were
confirmed by name against `itest:bcdev` on the same day. The gate was then run a THIRD time so it is
verified against its own committed baseline rather than merely having recorded one.

**The figures in `CLAUDE.md` may now be quoted as measured.** They were not, for two days.
