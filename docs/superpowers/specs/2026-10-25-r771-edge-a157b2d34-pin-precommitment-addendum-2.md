# R771 pre-commitment, addendum 2: O1's CDO set reads the login WorkDate on edge-a157b2d34

Coord task R-771. On master BEFORE the pin entry it predicts. Amends
`2026-10-25-r771-edge-a157b2d34-pin-precommitment.md` and addendum 1.

## What happened
After the R-788 merge, `--regate 5841b90a` of current (`edge-dcdf9e821`) passed every leg, O1 included (19:31-19:38Z,
`/coord/handoff/R-771/final-regate.out`). Then `--edge-rejudge a157b2d34` at 5841b90a read `gate-fail` on one leg, O1
(R784). Receipt:
`/work/tools/al-runner-v3/rejudge/edge-a157b2d34@5841b90af1e9f9da9068ab643644836550657671/receipt.json`.
- Addendum 1's fix held: C passed with all seven facts pinned. X (b), T and N1E were pinned, every other leg passed,
  and K was skipped as a candidate.
- O1's own set passed. O1's CDO set read `WORKDATE=2026-08-01` in every Reader entry of all five requests, R0.0 on the
  fresh daemon included. R784 pre-committed the run's date (2026-10-25).
  - Every other kind read its default. The Writer's 2001-01-01 never appeared. Nothing carried over, and the order
    held (lethal-bugs confirmed the reading).

## Where 2026-08-01 comes from (measured)
- Upstream commit 5e1db1c7 ("login WorkDate", issue
  [#5743](https://github.com/aldevtools/BusinessCentral.AL.Runner/issues/5743), closed) is in a157b2d34 and not in
  dcdf9e821.
  - When a test session with a client opens the company, al-runner now calls Base Application's codeunit 40
    `LogInManagement`, procedure `GetDefaultWorkDate`, as BC's login does (`install::login_work_date`).
  - `GetDefaultWorkDate` checks `Company Information Mgt.`.`IsDemoCompany` (the `Demo Company` field). In a demo
    company it returns the posting date of the last `G/L Entry`; otherwise it returns WorkDate unchanged.
- O1's CDO set holds Base Application (from CDO's `Test/.alpackages`), so al-runner restores the CRONUS demo company
  of BC 28.4.53241.53758 by default (test data). The own set has no Base Application: no login code, no demo data.
- Probe (`/tmp/claude-1000/-work-tools-continia-cli/04ebe3b0-6a9a-4def-a311-36e58b337b81/scratchpad/wd-probe`, a
  one-test app on Base Application, CDO's packages, `--bc-version 28.4.53241.53758`):

  | Build | Test data | WorkDate | Demo Company | G/L entries | Last G/L date |
  |---|---|---|---|---|---|
  | a157b2d34 | default | 2026-08-01 | Yes | 4178 | 2026-08-01 |
  | a157b2d34 | `--no-test-data` | 2026-10-25 | No | 0 | |
  | dcdf9e821 | default | 2026-10-25 | Yes | 4178 | 2026-08-01 |
  | dcdf9e821 | `--no-test-data` | 2026-10-25 | No | 0 | |

- No CDO object sets WorkDate. The Continia apps' sources hold no WorkDate setter; the CDO set's only part is that it
  brings Base Application.
- BC itself runs the same login code in a client session. In this CRONUS company it shows 2026-08-01, so a157b2d34 is
  the more faithful build. Upstream's #5743 recorded exactly this difference, with BC's answer, and fixed it. Nothing
  is left that differs from BC, so nothing new is owed upstream.

## The pin entry
- `edge-a157b2d34` gets `o1: { cdoWorkDate: "2026-08-01", issue: #5743, evidence }` in `al-runner-v3-pins.ts`.
- `judgeOrderProbe(requests, today, loginWorkDate)`: with the pin, every Reader entry's WorkDate must equal exactly
  the pinned date, in every request. That covers R0.0 on the fresh daemon and every entry after a W.
  - The clock's date then fails, any other date fails, and a writer value fails (named CARRY-OVER).
  - A pin naming a writer value is refused.
  - The order and plan checks are unchanged.
- The itest passes the pin for the CDO set only and prints `O1: cdo set: WorkDate pinned 2026-08-01 (pin
  edge-a157b2d34, ...#5743)`. The own set and every other build are judged as before.
- Tests in `r784-order-probe.test.ts`, each red-checked:
  - the pinned date passes, and without the pin it fails;
  - under the pin the clock's date fails, R0.0 included;
  - one entry with another date fails;
  - a carried-over 2001-01-01 after a W fails;
  - a writer-value pin is refused;
  - only this pin carries `o1`.

## Predictions
1. `--regate <the merge of this pin>` for current (`edge-dcdf9e821`): `pass`, every leg as at 5841b90a. The rejudge
   judges at `.gated`'s commit, so the pin must be there first.
2. `--edge-rejudge a157b2d34`: as addendum 1 predicts (seven `C: pinned:` lines, no `pin-mismatch`, X (b), T and N1E
   pinned, X (d) 2 / 3 / 0, K skipped), plus O1 `pass`, with the own set at the clock's date and the CDO set
   `WorkDate pinned 2026-08-01` in all five requests. Outcome `pass`; `current` moves.
3. The K run on the new current: every leg pass, K 3 / 12 / 4 over 19, 0 differences. A failure is a BLOCK.
