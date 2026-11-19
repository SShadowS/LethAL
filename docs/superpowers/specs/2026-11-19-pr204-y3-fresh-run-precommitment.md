# PR-204 y3 pre-commitment: a fresh end-to-end DO run on master df6d0073 (PR-191's and PR-195's keeps, recheck on), compared with y2

Lane lethal-bugs, 2026-11-19, coord PR-204. Committed before the run.

**Head: master df6d0073.** That is y2's head 196afaf7 plus, on the al-runner-v3 path:
- PR-182 (and PR-185's wording): the withheld-kill recheck (PR-144) is **on by default**, with its own budget
  (`recheckBudgetSeconds` default 3,600 s), after the main pass;
- PR-191: y2's five XML refusal texts kept; PR-195: the collation texts U+516C and U+041A kept;
- PR-197: a pre-run warning for tests whose HTTP policy does not block outbound calls (a warning only).
- The other merges are bcdev-side (LethAL Control 1.0.0.27/28), tooling, gates, docs and roadmap.

**al-runner:** edge-4ebfe7913 (`current`). If `current` moves before the run, this file is void and an amendment comes first.
**Dry run on df6d0073** (`/coord/handoff/PR-204/dry-y3.txt`): 469 files, 45,014 sites, **43,511 deployed**, as y2.

**Shape, as y2** (`run-y2.sh` with its own folder `/coord/handoff/PR-204/`): a NEW store `doy3.sqlite`, triage first, config
`/coord/handoff/R-984/v3.do-serve-xb.json`, `--workers 3`, `heavy-slot.sh --peak 18 baseapp`, watchdog at a 20 GiB tree or
under 4 GiB of headroom, `--time-budget 54000` as a safety stop, events kept. Any other heavy job sharing the container is
named in the result (from `/coord/locks/heavy-queue` and the process table).

## Basis: y2 (`/coord/handoff/PR-163/result.md`, head 196afaf7, the same al-runner build)
- 25,661 s; 1.54 s per covered mutant (TIMING 1.48 s); 86.4% under 1 s by `durationMs`. Mutants phase 24,709.2 s; baseline 895.5 s.
- y2 ran under extra load (PR-172 to PR-186's measurements, 20:03Z to 22:25Z).
- Lanes (TIMING union): 7 waits at window boundaries, 1,001.8 lane-seconds.
- 82 daemon restarts: 59 after a refusal (2,551.0 s of warm-up compile), 23 after a timeout.
- Counts: killed 6,033, survived 9,885, timeout-killed 7, error 757 (of which **516 withheld kills**), no-coverage 26,829.

## Predictions
1. **Mutation set:** 43,511 deployed; the numbering digest equals y2's.
2. **Refusal restarts:**
   - **0 closes on any of the seven newly kept texts** (PR-191 P3: unassigned XmlNode, unassigned XmlElement, XmlNode as XML
     content, XmlAttributeCollection, XML name within the slot; PR-195 P3: U+516C, U+041A). A close on an XML name outside the
     slot, or on a cascade row whose quoted name holds a SAFE_TAIL word, is named, not counted as a miss (PR-191 LOW-1/LOW-2).
   - **At most 25 refusal closes** (y2's 59 less PR-191's upper bound 30 and PR-195's exact 4); every refusal close is named,
     and any text y2 did not close on is listed.
   - Timeout closes: about y2's 23 (the same hanging mutants); total restarts at most 52.
   - After-refusal warm-up compile at most 1,371 s (y2's 2,551 s less 1,180 s).
3. **The kept refusals are safe (PR-191 P4, PR-195 P4):**
   - the 8 XML mutants (M36703, M36708, M36714, M36716, M36741, M36754, M36794, M36795) and the 4 collation mutants (M39779,
     M39781, M39786, M39788) keep y2's main-pass verdict (`error`) and refused-test sets. Five of them were also withheld
     kills in y2 (M36794, M36795, M39779, M39781, M39786), so the recheck may turn them into kills: those are in the named
     class of 6, and their final verdicts are listed;
   - each newly kept text is seen at least once as a NotRun row and is followed by no close;
   - every mutant scored on a lane after a kept refusal, up to that lane's next close, keeps its y2 verdict and killing test
     (outside the recheck class in 6);
   - every `serve-drift-after-kept-refusal` event is named. A difference here is re-run on a fresh daemon before y3 is
     accepted; if the fresh daemon gives y2's answer, that keep is withdrawn.
4. **Time:**
   - the mutants phase (main pass) is at most 25,500 s (y2 24,709 s, under load), central 24,000 s;
   - main-pass seconds per covered mutant at most 1.54, central 1.46;
   - the session wall, recheck included, at most 30,000 s, central 27,000 s.
5. **Waits:** at most 2,004 lane-seconds at window boundaries (twice y2's), central about 1,000; from TIMING's union.
6. **The recheck (default on):**
   - targets = the main pass's withheld kills, about y2's 516;
   - **recovered at least 480, central 505** (x3: 294 of 295); every recovered row is an error -> killed change, and its
     killing test is the test whose failure the main pass withheld;
   - the rest stay `error` (kept error), each named with its rule;
   - **unmeasured: 0** — rows the recheck did not reach (budget cut or skip) are named as unmeasured, never as kills;
   - the recheck's time at most its 3,600 s budget, central 2,300 s; a budget stop is reported, not a failure.
   - errors after the recheck: y2's 757 less the recovered rows.
7. **Per mutant vs y2** (all 43,511 by the full site key: file, start, end, operator, mutated text):
   - **0 verdict differences outside the recheck's error -> killed class** (listed row by row);
   - killing-test-only differences (D) are allowed and named;
   - anything else is a BLOCK.
8. **Baseline:** fresh and batched; phase at most 1,100 s; 1,979 outcomes equal y2's, test by test.
9. **Lanes and memory:** 3 of 3 lanes; 0 lane-memory holds; tree at most 18 GiB; no watchdog stop; no budget stop (rc 0).
10. TIMING is quoted in full; lane figures come from TIMING's union; events are kept.
