# R-984 cross-build window x3 pre-commitment: resume dos4 on edge-4ebfe7913, head c7316cf7 (PR-81, PR-121a, PR-123/126 batched re-check)

Lane lethal-bugs, 2026-11-17/18, committed before the window starts. Third window of `dos4.sqlite` (x1 4ac7a4a2 + 2fc7612b, x2
ed96cd23). Head: master c7316cf7 (x2's 7c6bba1c + PR-119 concurrent cross-check samples, PR-121a windows close on time only, PR-81
held errors (R1066), PR-124/125 measurements, PR-123 batched L5 re-check, PR-126 coverage only on its samples, PR-128, PR-129).
al-runner edge-4ebfe7913 (`v3.do-serve-xb.json`; gate record allows batching since the 7c6bba1c regate). `run-xb.sh 3`: `--resume`,
`--workers 3`, `--peak 15`, watchdog 17 GiB or under 4 GiB of headroom, `--time-budget 12600`. Events kept.

## Basis: x2 (`/coord/handoff/R-984/result.md`)
Baseline reused (233.6 s; the L5 re-check as 110 single-codeunit requests, 222.1 s); 3,748 covered at 3.28 s; 26 restarts (17 after a
refusal, 728.3 s of warm-up after-refusal); 0 differ vs x1; vs t1-t14 16 (A), 3 (D). 6,880 covered mutants remain.

## Measured before the window (`t6prep/dry-x3.txt` on c7316cf7)
Identical to x2's: 43,511 deployed.

## PR-81 and the same-build comparison (new class E)
`error` verdicts are never carried by `--resume`, so x3 re-scores x2's (and x1's) errors. PR-81 holds a non-terminal
`runner-refused` error and lets the walk go on, so a test of ANOTHER codeunit can now kill a mutant x2 recorded as `error`. Such a
move is allowed and counted apart as **(E) PR-81 walk-on**: x2 `error` -> x3 `killed`, where x2's row is a refusal (`NotRun:
out-of-scope: ...`) and x3's killing test belongs to a different codeunit than the refused test. Each (E) row is named and that
condition checked. Any other move against x2 is a BLOCK.

**Amendment 1 (orchestrator, 2026-11-18, x3 running, nothing scored yet):** E is accepted as PR-81's intended effect and kept
narrow. For each (E) row, also check from x3's events that the killing test ran AFTER the held refusal in the same walk (the
refused test precedes the killer in the mutant's covering walk). `error -> survived` and `error -> timeout-killed` against x2
stay BLOCKs, as does any E row failing a condition.

## Predictions
1. **vs x2 (same build, strict): 0 differ except (E).** (E) counted and named, not predicted in number (PR-81's spec: only tests of
   other codeunits can turn such an error into a kill; most DO refusals cascade within one codeunit).
2. **vs t1-t14:** (C) = 0; (A), (B), (D) counted and named (an (E) row shows there as (A)).
3. **Mutation set:** 43,511 deployed.
4. **Baseline: REUSED from x1's snapshot, named; the L5 re-check is BATCHED** (PR-123), with coverage only on its samples (PR-126):
   a batching stats line for the re-check is printed, and the baseline phase is **at most 120 s** (x2 233.6 s).
5. **PR-121a:** lane barrier time in TIMING at most 60 s summed over lanes (windows close on time only).
6. **PR-81's restart cost (reported, not predicted):** restarts after a refusal and their warm-up seconds (TIMING's after-refusal
   cause) against x2's 17 and 728.3 s, with the count of (E) rows; PR-81's spec asked for this measurement on one DO window.
7. **Speed:** at most 3.3 s per covered mutant scored (x2 3.28 s), at least 3,500 covered mutants scored; the window does NOT complete
   the covered set (6,880 left need more than one budget at this rate).
8. **Closes:** 0 GoToKey and 0 SetFilter-1030 refusal closes; every timeout kill `v3-cpu-stop`; capped walks counted if any.
9. **Memory:** tree <= 15 GiB; no watchdog stop; no budget overrun beyond one request.
10. TIMING quoted; PR-116's withheld-kills caveat counted if present.
