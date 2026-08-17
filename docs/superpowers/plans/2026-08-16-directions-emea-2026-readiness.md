# Directions EMEA 2026 readiness

**Scope decided 2026-08-16.** Live session on stage. Public release, attendees can install it
afterwards. The AI-agent angle is headlined, not a footnote. Demo runs against a purpose-built
demo app, not the repo fixtures and not Continia Document Output.

**Timeline assumption: the conference is early November 2026, so roughly eleven weeks from
2026-08-16. Confirm the date and, more urgently, the CFP deadline before treating anything below
as scheduled.** If the abstract is not submitted, item F1 is the only real deadline and the rest
is speculative.

Every item below names the evidence it rests on. Effort figures are working days for one person
and are estimates, not measurements.

---

## A. Legal and repository hygiene. Hard blockers for a public release.

**Status 2026-08-16: A1, A2, A3 and A4's decisions are all made; A is closed.** MIT chosen;
`LICENSE` written and README updated. All six reports redacted and the guard widened from a
hand-written pair of paths to a glob, red-checked. Continia may be named. No history rewrite.

**Landed 2026-08-16:** D1, D2, D3 in full (`explain --top`, `doctor --json`, the agent reference
and the copyable skill, each with tests and a red-check), D4 half (published schemas for explain and
doctor), B1's two workflow files, and C1/C2 — the gift card demo app, measured live at 20 killed /
9 survived / 7 no-coverage in 13.8 s with all 36 pre-committed verdicts matching, then frozen.

**Landed 2026-08-17:** B1 fully verified (both workflows green on real runs), **B2 — release
0.1.0-alpha.2 cut and staged as a draft with all five binaries attached**, a `/release` skill
carrying the order of operations, release notes generated from the CHANGELOG rather than written by
hand, and Azure Trusted Signing wired but not yet switched on. Roadmap rows R150 to R156 record all
of it.

**Still untouched: B3, B4, B5, C3 to C7, D4's other half, D5, E and F.**

### A1. There is no LICENSE file (1 day, mostly the decision) — DONE

**Decided 2026-08-16: MIT.** `LICENSE` added at the repository root, copyright Torben Leth, and
README's "none declared yet" line now points at it.

`ls LICENSE*` finds nothing. README.md ends with "License: none declared yet. Add a `LICENSE` file
before distributing." Without one, every attendee who downloads the binary has no right to use it,
and no company lawyer will let it near a build server.

Decide the model before writing the file: permissive (MIT, Apache-2.0) if adoption is the goal,
source-available (BSL, PolyForm) if a commercial product follows, or dual. Apache-2.0 carries a
patent grant that MIT does not, which matters if this ever becomes a product.

### A2. Six committed campaign reports carry unredacted third-party source — DONE except the history decision

`bun scripts/redact-campaign-report.ts --check docs/campaign/*/*.report.json` reports 1,857
`originalText` / `mutatedText` fields of Continia Document Output source across six files in
`docs/campaign/2026-08-03-do/`:

| File | Fields |
|---|---|
| `rung1.report.json` | 241 |
| `rung1.resumed-run.report.json` | 241 |
| `rung1.run2-partial.report.json` | 140 |
| `rung2.report.json` | 753 |
| `rung3.independent-confirm.report.json` | 241 |
| `rung3.redcheck.report.json` | 241 |

`scripts/redact-campaign-report.test.ts:132-133` guards only the two 2026-08-07 and 2026-08-08
reports. This directory predates the 2026-08-09 ruling and was never swept. The repository is
public, and Directions EMEA is precisely the room where Continia's people are standing.

Three parts to this:

1. **Done.** Ran the script over all six: 1,857 fields replaced with the standard marker. A sweep
   of every JSON under `docs/campaign/` confirms the eight `*.report.json` files are the only ones
   that ever carried source; the `*.baseline.json` and `*.anchors.json` files contain none.
2. **Done.** The test now discovers the set with `new Glob("docs/campaign/**/*.report.json")`
   instead of naming two paths, and asserts the glob matched at least eight files BEFORE checking
   their content, because a glob that silently stops matching would make `--check` pass over
   nothing and read exactly like "everything is clean". Red-checked: planting one unredacted
   report under `docs/campaign/` turns the test red, and removing it turns it green again.
3. **Decided 2026-08-16: no history rewrite.** The redaction stands as a forward fix; the history
   keeps what it has. The alternative would have invalidated every clone and every commit hash
   cited in the roadmap and in `docs/campaign/*/manifest.md`, in a repository whose evidence
   pointers ARE commit hashes.

### A3. Continia permission and attribution — DECIDED

**Decided 2026-08-16: naming Continia is fine.** No further action. The repository-side question
was already settled by the 2026-08-09 ruling (names and paths yes, source no), and the source is
now gone.

The README cites Document Output throughout: 438 of 551 files carrying mutation sites, 19,850
sites, named procedures, named tests, measured failure modes. The 2026-08-09 ruling says names and
paths are fine to publish and source is not, which settles the repository question. It does not
settle whether you may put their product on a slide at their industry's conference. Ask them.
Getting a yes turns your strongest evidence into a strength; discovering a no on stage does not.

### A4. Naming and branding check (0.5 day)

Confirm "LethAL" collides with nothing, and check Directions' and Microsoft's rules on using
Business Central branding in a session title and slides.

---

## B. Release engineering. Attendees can install it.

### B1. There is no CI — WRITTEN 2026-08-16, never run

`.github/workflows/ci.yml` (push and pull request: typecheck, clean dist, unit tests) and
`.github/workflows/release.yml` (on a `v*` tag: version guard, same gate, all five binaries,
`--version` smoke test, draft release) now exist. Neither has executed, so every claim in them is
untested — see `docs/roadmap/R154.md` for the specific untested claims and the three deliberate
limits (windows-latest only, no repo-wide biome, no CI-built control app).

**DONE 2026-08-17.** `ci.yml` verified on run 31961823874 — and its first push found a real trigger
defect, fixed in `af0b056`. `release.yml` verified on run 32063692530: 1m44s, five targets, draft
release, notes from the changelog. R154 is closed. The SIGNING path is the one part still
unexercised, deliberately: the three Azure repo variables that switch it on are unset, so the
guarded steps skip and the release publishes unsigned.

### B2. Cut a real release — DONE 2026-08-17, draft awaiting publication

`docs/releasing.md` exists and its numbers are measured rather than estimated, which is more than
most projects have. It has not been executed as a release. Do it once, end to end, from a clean
clone on a machine that is not your development machine. Decide the version: 0.1.0-alpha.1 is what
the binary stamps today, and "alpha" on a conference slide sets an expectation you may or may not
want.

### B3. Ship the control app as a release asset (0.5 day)

`extensions/lethal-control/` holds sixteen committed `.app` files from 1.0.0.2 to 1.0.0.16, plus
`lethal-control.app`. A stranger cannot tell which to publish. Attach exactly one to the release,
named by version, and say in the README that it is the one. Separately decide whether the control
app goes to AppSource or stays a side-load, because "publish this unsigned app to your server" is
a sentence some IT departments will refuse.

### B4. Watch one stranger install it (1 day, highest value on this list)

Hand the release to a BC developer who has never seen the tool. Do not help. Every place they
stall is a work item, and this test finds the ones no amount of re-reading your own README will.
Budget a follow-up day for what it finds.

### B5. Config friction (2 days, not strictly blocking)

`lethal.config.json` requires `mcpCommand`, `server`, `serverInstance`, `company`, `username`,
`password`, `packageCachePath`, `controlSymbolPath`, and an `env` block that the README has to
explain is "not optional in practice". That is the ugliest moment in the quick start. A `lethal
init` that probes a container and writes the file would remove it. Worth doing if time allows,
and worth demoing if it exists.

---

## C. Demo mechanics. Live, on stage.

### C1. Build the demo app — DONE 2026-08-16, measured live and frozen

Sizing is already measured, so this can be designed rather than guessed at
(`docs/benchmarks/runs.jsonl`):

| Shape | Mutants | Total run |
|---|---|---|
| Fixture on a container | 13 | 6 s |
| Real app, tests narrowed | 102 | 231 s |
| Real app, unnarrowed | 102 | 954 to 1,065 s |

Baseline dominates: 864 s of that 1,065 s run was baseline, and narrowing tests collapsed it to
25 s. So the demo app must have a small test suite, not merely a small source tree.

Target: 20 to 40 mutants, under 90 seconds wall clock, so the run finishes inside the talk without
dead air. Design the result before writing the code. You want a survivor that is a genuine bug, a
`no-coverage` finding, and a healthy killed majority, so the report tells a three-part story
rather than showing a number.

### C2. Plant one real bug behind a green suite — DONE, and it survived as predicted

The payoff sentence is "this suite is green, and this bug ships". Make sure the demo app earns it,
and that the surviving mutant is one an experienced BC developer will immediately recognise as
dangerous, not a contrived off-by-one.

### C3. Rehearse the failure paths (1 day)

Know what the screen shows and have one sentence ready for each: quarantine (exit code 3), a red
baseline, a stopped container, a publish refusal from the ceiling. An unrehearsed failure on stage
reads as a broken tool; a narrated one reads as an honest tool, which is the whole positioning.

### C4. Assume no usable network (1 day)

Conference wifi. Everything local: Docker container on the laptop, images pre-pulled, symbols
cached, no step that downloads at demo time. Verify by disabling the machine's network adapter and
running the demo start to finish.

### C5. Reset script (0.5 day)

One command back to a known state between rehearsals and after a bad take: clear quarantine, clear
the publish ceiling, republish the control app, delete `lethal.sqlite`, restore the demo app's
source. You will use this more than anything else on this list.

### C6. Backups (0.5 day)

A recorded video of the same run, and a pre-generated `report.json` so `lethal explain` still has
something to show if the container dies. Both on the laptop, not in the cloud, for the reason in
C4.

### C7. Legibility (0.5 day)

Terminal font size, colour scheme and output width tested on a projector, or at least at 1080p
from across a room. The console renderer's output is dense.

---

## D. The agent angle. You chose to headline it, so it has to work.

### D1. Bound the `explain` output — DONE (`docs/roadmap/R150.md`)

`lethal explain --top <n>`. Measured on the committed rung2 report (473 mutants, 125 survivors):
243 KB uncapped, 30 KB at `--top 15`. The output always carries `survivorSelection`
(`total`/`shown`/`omitted`/`rankedBy`), even when nothing was capped, so a capped list can never
read as a complete one. A cap ranks by how much evidence each survivor carries, in a total order,
so the same report and cap give the same rows on any machine.

### D2. `doctor --json` — DONE (`docs/roadmap/R151.md`)

`DoctorJsonOutput`: `doctorSchemaVersion`, `ok`, `checks[]`, `notChecked` tokens, and a `caveat`
with a machine `kind`. Same exit code, only the rendering changes. `--json` on any other subcommand
is refused rather than ignored. `run` and `campaign` deliberately did not get it.

### D3. Ship an agent contract — DONE (`docs/roadmap/R153.md`)

`docs/using-lethal-from-an-agent.md` (the reference) and
`skills/lethal-mutation-testing/SKILL.md` (the copyable skill), both linked from the README and
both checked against the code by `packages/runner/tests/agent-contract.test.ts`: every `--flag`
they name must exist, and the exit codes and schema versions they promise must match the constants.

**What is left for the talk is not writing these, it is rehearsing them.** The skill is what people
copy after the session; put its path on a slide.

### D4. Publish JSON Schemas (1 day) — still open, filed as `docs/roadmap/R152.md`

Now four versioned surfaces with no schema artifact: report `schemaVersion` 2, explain
`explainSchemaVersion` 4, stream `streamSchemaVersion` 1, doctor `doctorSchemaVersion` 1.
Publishing them lets consumers validate and generate types, and signals that the versioning is
real. R152 records the one design decision worth making first: generate from the TypeScript
declarations (the `typeLeafPaths` walk in `packages/runner/tests/helpers/` is most of it already)
rather than hand-write and pin.

### D5. The live agent loop (2 days plus rehearsal, decide early)

The money shot: an agent runs LethAL, reads `explain`, writes a test, kills a survivor, re-runs
green. It needs D1 to D3 finished, and it is the most fragile thing in the talk because it adds a
non-deterministic component to a live demo. Decide by the end of September whether this runs live
or plays as a recording, and build the recording either way.

---

## E. Questions from the floor. Have the answer, with the number.

- **E1. TestPage.** Someone will ask. README has the measured table: fenced hangs and quarantines
  the whole run, the hub path completes, mutant verdicts remain unscoreable either way. R69 was
  closed as "we do not recover this, and we say so", with recovery measured at 2.30% of a real
  app's mutants. Decide whether you mention that recovery is built but deliberately unwired
  (R74 / R75).
- **E2. Cost.** "Can I run this on my 500-file app?" Answer with the real numbers: 19,850 mutation
  sites on Document Output, unscoped runs refused by default above 1,000 sites, 231 s for a
  narrowed slice, days unscoped. A slide with these numbers turns a weakness into candour.
- **E3. GUI caveat.** 62 of 19,850 sites (0.3%) sit lexically inside a `GuiAllowed` or `Confirm`
  guarded branch, measured whole-app. Having the number defuses the objection; not having it makes
  the caveat sound unbounded.
- **E4. Backends.** Say plainly which backend the demo used and that `al-runner` is not
  authoritative.
- **E5. Roadmap.** 5 of 154 items are not `done`: R014 and R089 are standing watches, R145 is
  deliberately unscheduled, R148 and R149 are open and small. Either close R148 and R149 before
  the talk or be ready to describe them. Do not walk on stage with unopened cans.

---

## F. The talk itself.

- **F1. CFP deadline.** Find it today. If the abstract is not in, this is the only deadline that
  exists and everything above is contingent.
- **F2. Slides.** The room will contain people who have never heard of mutation testing. The
  concept needs one slide and one sentence, not a lecture: coverage says a line ran, mutation says
  a line is checked.
- **F3. Positioning.** Alpha or beta on the slide. The README's current voice ("honest about its
  limits rather than complete") is a real asset in a room full of people who have been oversold
  before. Do not lose it in the marketing pass.

---

## Suggested order

Revised 2026-08-16, after A, D1, D2, D3 and B1's authoring all landed in one sitting.

1. **This week:** F1 (CFP deadline — still the only real deadline). Push the branch and watch CI
   go green or fix it (B1's remaining half, R154).
2. **Weeks 2 to 4:** C1 and C2 (the demo app). This is now the long pole and everything about the
   talk depends on it.
3. **Weeks 4 to 6:** B2 (cut a real release from the tag flow), B3 (control app as a named asset),
   D4 (schemas, R152).
4. **Weeks 6 to 8:** B4 (stranger install test) and whatever it finds, D5 decision (live agent loop
   or recorded), C3 to C7 (demo mechanics).
5. **Weeks 8 onwards:** rehearse. E1 to E5 answers written down. B5 if time remains.

The item that most often gets left too late is B4, because it needs another person's calendar.
Book it now, not when the release feels ready.
