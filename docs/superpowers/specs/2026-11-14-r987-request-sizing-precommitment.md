# R-972 pre-commitment: serve requests sized from each codeunit's measured cost (R987); the v3 gate's request counters

Committed before the gate on the final head, 2026-11-14. Coord task R-972, branch `lethal/r-972` (build dfb0ea88). Evidence:
`/coord/handoff/R-972/`.

## The change

A serve daemon holds every entry of a request until it ends; on Contoso Coffee Demo that took it to 21 GB at 256 entries a request.
LethAL now reads the daemon's RSS while each request runs, charges the growth per entry to every codeunit the request ran (each keeping
its highest), and cuts each prefetch and kill-pair chunk when it is sent: at most 256 entries, at most 16 entries of codeunits no
request has measured, at most 4 GiB of measured cost. R912's batch-refusal judgement stays on a fixed 256-entry chunk. Details: R987.

## What moves in `itest:alrunner-v3`, and nothing else

Read from an observe run of the full gate on dfb0ea88 (`v3-observe2.log`, edge-736fc7677, CDO and tables legs included). The first
prefetch request now carries at most 16 codeunit entries, so a leg whose prefetch held more sends one more prefetch request, and
`boundChecks` (warm-ups + prefetch + live + coverage requests) rises by one:

| leg | pin | was | becomes |
|---|---|---|---|
| S1E (and DB, which shares S1E's pins) | `boundChecks` | 3 | 4 |
| N1S | `boundChecks` | 3 | 4 |
| WRE | `boundChecks` | 3 | 4 |

Every other pinned counter equals its pin in that run and stays: `entriesSent` (S1E 48, N1S 266, MOE 46, WRE 448), `liveRequests` (1),
`warmups` (1), `pairRequests`, `pairBatchRequests` (1), `pairBatchStored` / `Served` / `Refused`, `echoMismatches` (0); MOE's
`boundChecks` stays 3 (its prefetch fits one request). Every per-mutant table, killing test, count and note of every leg is
unchanged: those legs passed, and in S1E, DB, N1S and WRE the counters are asserted after the per-mutant comparison, which passed.
No baseline file changes. A difference beyond this table is a BLOCK.

## Procedure

Edit the three pin objects in `packages/runner/itest/al-runner-v3.itest.ts` to the table above (with a comment naming this file), run
the full v3 gate on the final head (CDO and tables legs), CI.

## Amendment 1 (2026-11-14, before the gate on the final head)

The branch was merged with master 2c0976bc after the observe run. Master's R975 (R-965 amendment 4) had already moved WRE's
`entriesSent` from 448 to 436 (6 twin `OnOpenPage` mutants read no-coverage and are not sent); the observe run predates it. So WRE's pin
on the final head is `entriesSent` 436 (master's value, untouched by R987) with `boundChecks` 4; the table above is otherwise unchanged.
The gate on the merged head decides; any other difference is a BLOCK.
