# R572 Next(0) probe: what does `Rec.Next(0)` return, and does it move the cursor?

R572's narrowing (a) accepts a forced step `R.Next(X) = 0` when X is invariant in the loop. A mutant that
leaves X at 0 is safe only if `Next(0)` returns 0 (the loop ends) rather than stepping. This probe measures it.

Measured 2026-10-21 on **bc1** (BC on Linux, System 28.0.54946.56477, runtime 17.0), company
`CRONUS International Ltd.`, twice, identical:

| case | record | `Next(0)` | cursor moved |
|---|---|---|---|
| after `FindFirst` / mid-set / `FindLast` / `FindSet` | `Tenant Web Service` (SQL) | 0 | no |
| after `FindFirst` | the same, TEMPORARY | 0 | no |
| after `FindFirst` | `AllObj` (virtual) | 0 | no |
| after `FindFirst` | `RecordRef` | 0 | no |
| no `Find` first | fresh variable | 0 (no error) | |
| `repeat .. until Next(0) = 0` | | ends after 1 pass | |
| `while Next(0) <> 0 do` | | 0 passes | |

Control: `Next(1)` returned 1 and moved in the same runs. So a zero step ENDS such a loop.

## Running it

App `LethAL R572 Next0 Probe`, id `6c55454e-679b-457e-aae1-32b5b7bbf8ec`, objects 91500-91501 (the al-probe
range; 91000-91099 is LethAL Control's). It reads real tables only and writes only a temporary record; every
loop is capped at 5 passes. The install codeunit registers the web service `R572Next0Probe`.

1. Copy the server's `Microsoft_System.app` into `.alpackages/` and compile:
   `"$LETHAL_ALC_DIR/alc" /project:. /packagecachepath:.alpackages /out:<dir>/r572-next0-probe.app`.
2. Take the server's coord lease. Copy a gitignored `lethal.config.bc<N>.json` here (never commit it).
3. The driver is NOT in the repo: it builds automation-API URLs for the uninstall and unpublish actions, which
   `scripts/automation-api-guard.test.ts` keeps out of the source tree (R433). It is
   `/coord/handoff/R-572/next0-probe/drive.ts`; run it from a worktree root:
   `bun /coord/handoff/R-572/next0-probe/drive.ts <config> publish <app>`, then `... measure`.
4. `... cleanup`: removes the web-service row, uninstalls with data deletion, unpublishes, and reads the app by
   id to confirm `[]`. Release the lease.
