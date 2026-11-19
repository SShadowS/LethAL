# PR-244 spec-light: show a reworded kept refusal at once, not as a restart storm

Coord PR-244, lethal-code, 2026-11-19. Owner request q-20261119T201755-7ad0b2a3; orchestrator added option (4).
Measured offline on y2 (`/coord/handoff/PR-163/`), y3 (`/coord/handoff/PR-204/`) and PERF-10 (`/coord/handoff/PR-217/`:
the triage and the run). Scripts: `closes.py` (`closes.json`/`.txt`), `nearmiss.ts` (`nearmiss.txt`), `exposure.py`
(`exposure.txt`). Warnings only: no keep behaviour changes (principle 9).

**Ruling (orchestrator, 2026-11-19):** build (1) with the pre-committed known-variants list, plus (2) as the backstop:
two warning codes, keep behaviour unchanged, no gate leg printing either (confirmed by the full v3 gate), red tests both
ways. (4) is declined: half of y3's later requests would have run on a possibly dirty daemon, and a kill could turn into a
survivor that no check sees. (3) is not built.

**The pre-committed known variants** (each printed once per session as a known variant, never as the warning):
- `report-parameters-no-xml-declaration` + a text containing `given to Report.RunRequestPage`;
- `cascade-manual-binding` + a text containing `An error was expected inside an ASSERTERROR`.

**The thresholds, fixed:** (1) containment ≥ 0.8 over entries of ≥ 8 literal words; (2) the 10th close of one family in
one session.

## 1. The incident
- Upstream inserted a hint into the `company-findset` refusal: `… does not know; name them with --companies NAME[,NAME...]
  (serve: the companies field); all needs test data (ADR-046 decision 4a)`.
- The keep entry is an anchored regex, so the text stopped matching. Every refusal then closed the daemon: 9 restarts in
  PERF-10's triage, 39 in its run.
- Nothing said why until someone read the closes.

## 2. The refusal closes in the three runs (`closes.txt`)
- **y2:** 59 refusal closes, 16 families. With today's keep list several of them would now be kept (entries added since).
- **y3:** 25 refusal closes, 10 families; at most 6 for one family.
- **PERF-10:** 49 refusal closes, 2 families: `FindSet on the Company table` 48, `Record.SetFilter` 3 (triage plus run).

## 3. The options, measured
**(1) A near-miss warning.**
- **The rule:** an UNKEPT refusal that closes a daemon, whose text holds at least 80% of one keep entry's literal words
  (entries of at least 8 words; the head `NotRun: out-of-scope:` excluded), prints
  `al-runner-v3-keep-near-miss: <text> almost matches keep entry <name> (<k>/<n> words) but does not: a rewording, or an
  unmeasured variant; it closes the daemon as before`. Once per text per session.
- **Measured** (`nearmiss.txt`, against the real exported `V3_SERVE_SAFE_REFUSALS`):
  - **the true positive:** PERF-10's text holds 15 of 15 words of `company-findset`. It would print at the FIRST close.
  - **2 false alarms per DO run** (y2 and y3 alike), both unmeasured VARIANTS the list leaves out on purpose:
    - `a parameters string … given to Report.RunRequestPage`, 17 of 18 words of `report-parameters-no-xml-declaration`,
      whose `%REPORTM%` covers only the measured methods;
    - a `cascade` text whose tail differs ("An error was expected inside an ASSERTERROR"), 27 of 32 words of
      `cascade-manual-binding`.
  - No other unkept text reaches 0.8: the next best is 0.75, on 4- to 8-word entries.
- **The fix for the 2:** a pre-committed list of KNOWN unmeasured variants, by entry and a distinguishing pattern
  (`Report.RunRequestPage`; the ASSERTERROR cascade tail), printed once as known and not as a warning. On y2 and y3 the
  warning then fires 0 times.
- **Cost:** a word-set comparison on each unkept refusal close, which is rare.
- **Misses:** a rewording that drops more than 20% of the words (a full rewrite). (2) backstops that.

**(2) A restart-storm warning.**
- **The rule:** at the 10th daemon close in one session by the same refusal family, print once
  `al-runner-v3-refusal-restart-storm: <family> closed the daemon 10 times this session (<text>); a reworded keep entry,
  or an unkept class worth measuring`.
- **Measured:** y3's maximum is 6 and y2's is 6 under today's list (its 12 `XmlNode` closes are kept now), so 0 false
  alarms. PERF-10: it fires at the 10th close, about 10 restarts in.
- **Cost:** one counter per family.
- **Catches** what (1) misses, but late.

**(3) A pre-run probe check of keep entries.**
- **Coverage today: 0.** No keep entry is exercised by the contract probe; `company-findset` cannot be, since the probe's
  daemon has no package cache (`al-runner-v3-contract.ts` says so).
- A probe case per entry would be a large build and would still miss refusal texts that depend on test data.
- **Not recommended.**

**(4) Keep the daemon after ANY notRun refusal** (alrunner's offer), restarting only on a panic, a protocol error or our
own timeout, with (a) PR-56's drift check after every kept refusal, (b) al-runner's clean check on a sample, (c) a warning
on any class outside the measured set.
- **What it guards:** restart cost, all of it (y3: 25 restarts, about 1,120 lane-s of warm-up; PERF-10: 49).
- **What a never-measured DIRTY class could do before (a) or (b) catches it** (`exposure.txt`):
  - had y3's 25 unmeasured refusals kept their daemons, 3,593 later requests (about half of y3's mutant requests) and
    67,514 entries would have run on a daemon holding an unmeasured refusal: median 35 requests, maximum 1,274.
  - Polluted state can turn a kill into a survivor, and **a survivor is never re-checked.** A kill is re-confirmed (NONE
    pass and reproduction), so it mostly turns into a refusal instead.
  - PR-56's drift check compares only rows that cannot legitimately differ from the baseline. A mutant entry's row MAY
    differ, so a dirty state that flips a mutant's verdict is indistinguishable from the mutant's own effect.
  - (b) catches only sampled classes, after the fact.
- **So under (4), one dirty class can silently misreport survivors over hundreds of requests.** That flips principle 9
  ("keep only what is proven clean").
- **Not recommended as a default.** If wanted, it needs per-class proof (the R945/R968 census) before keeping, which is
  today's rule.

## 4. Recommendation
- **Build (1) with the known-variants list, plus (2).**
  - Two new warning codes, `al-runner-v3-keep-near-miss` and `al-runner-v3-refusal-restart-storm`. Both are warnings only:
    the keep decision (`serveDaemonReusable`) is unchanged.
  - **Pre-committed:** no v3 gate leg prints either code, since the gate's fixtures close no daemon on a near-miss and
    never reach 10 closes. The full v3 gate confirms, with `GATE_WARNINGS` unchanged.
  - **Red tests both ways:**
    - PERF-10's exact text warns at its first close; the y2/y3 known variants do not;
    - an unrelated unkept refusal does not;
    - the 10th close of one family warns once and the 9th does not;
    - and no warning changes `serveDaemonReusable`'s answer (the same rows give the same keep decision with and without
      the warnings).
- **(4) goes to the orchestrator and the owner** with the exposure above. It is not built here.
- **(3) is not built.**
