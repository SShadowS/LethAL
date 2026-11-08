# R873 / GitHub #10 P2: hardening trial, pre-commitment

**DRAFT. The owner's decision is pending.** Nothing here has been run. No live run starts until the owner approves this text and commits it. Figures below are the rule, not a result.

## What the trial measures

Issue #10 asks: can an agent, given only what LethAL's survivor packet shows, write tests that kill real survivors, and does `lethal verify` prove it? The acceptance (issue #10, as read in R-872's plan): ten non-equivalent survivors from three different operators, agent-written tests killing at least four of them.

## Who writes the tests

- A fresh agent with no prior context of this repo's measurements.
- It sees only what a user's agent gets: the output of `lethal explain <report> --project <dir>` for the chosen survivors (including `coveringTestLocations`), the agent doc `docs/using-lethal-from-an-agent.md`, and the project's own files.
- It never sees `mutatedText` from any other source: not a gate baseline, not a report from an earlier campaign, not the answer key of `sandbox-harden`. (`mutatedText` inside its own explain packet is part of the packet and is allowed.)
- It may not read `lethal.equivalent.json` answers from elsewhere, other trial agents' output, or this repo's roadmap and gate pages.
- It writes AL tests only. It runs nothing live; the owner (or a lane under the owner's word) runs `lethal verify`.

## The set

- A scratch copy of a fixture app and its test app, made for the trial. Never `sandbox-data`, `sandbox-app`, `sandbox-harden` or any other gate fixture: verify leaves its test app installed, and a gate would then refuse or measure the wrong build.
- The scratch copy gets its own app ids and object id range, and is restored (unpublished, removed) after the trial. The owner confirms the target server and that no gate runs there at the time.
- Survivors: ten, from at least three different operators, none marked equivalent (no reader mark, no `equivalenceRisk`), chosen from one full run's explain output by a fixed rule written down before the run: the first ten by report order that meet the operator spread. The chosen ids are committed before the agent starts.
- If the fixture cannot give ten non-equivalent survivors from three operators, the trial stops and is re-scoped by the owner. It is not padded.

## The pass rule

Per survivor, in order:

1. The agent's new test is `stable` in `lethal verify`'s `newTests` (passes twice on the unmutated build).
2. `lethal verify` reads that survivor `killed`, with `killedByNewTest: true` (since R873 this requires step 1).
3. A later full `lethal run` with the new tests in the project, on the same source, reads the same mutant `killed`, with that test as a killer (agreement, per mutant, not in aggregate).

A survivor counts as hardened only when all three hold. A verify kill with no later agreement counts as not hardened and is reported by name.

**Trial passes** when at least four of the ten survivors are hardened. Every other result is a fail or a partial result, reported as measured. The threshold is not changed after the run.

## What is reported

For each of the ten: operator, the agent's test name, `newTests` state, verify verdict, agreement verdict. Plus the count of hardened survivors and any survivor where verify and the later run disagree (each is a correctness finding to file). No test source text from a third-party project is committed; this trial uses a scratch fixture, so its source may be.

## Not decided here

- Which fixture the scratch copy is made from.
- Which server and which window.
- Whether the trial runs more than once (a single run is assumed).
