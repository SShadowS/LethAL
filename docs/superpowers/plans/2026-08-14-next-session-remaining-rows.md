# Next session: work R137, R141, R139 (checks 2-3) and R132 autonomously, one at a time

Written 2026-08-14, after R134 closed and R139's check 1 landed. Everything below is open work that
is already filed on the roadmap. Read `CLAUDE.md` first; it is the authority on the build loop, the
live gates and the roadmap discipline, and this file only adds what is specific to these four rows.

## How to work

Take the rows in the order given. Finish one completely, commit it, then start the next. Do not batch
them into one change and do not start a second row because the first got hard. If a row turns out to
be blocked, write what you learned into its `docs/roadmap/R<nnn>.md` file, commit that, and move on;
a measured blocker recorded on the row is a real result, an abandoned row is not.

You are running without a human in the loop, so the roadmap row plus its cited evidence IS the
approved scope. That licenses you to implement what the row asks for. It does not license you to
widen it: if you find yourself designing something the row does not name, stop, file a new row for it
and continue with what was asked.

Rules that are not negotiable, all of them learned the expensive way:

- **Build loop order:** `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test`. Skipping
  the dist wipe gives roughly 21 phantom failures from stale compiled `*.test.js`.
- **After touching any `.al` under `fixtures/`, run `bun run compile:fixtures`.** Nothing else
  compiles them, and a broken fixture leaves the live gate happily measuring the previously
  published build (R56).
- **TDD.** Write the failing test, watch it fail for the right reason, then implement. For any bug
  fix, red-check it: revert the specific fix, confirm the specific test goes red, restore, and report
  both outputs. A test that passes whether or not the code is correct is this project's signature bug.
- **Live gates are the authority.** Unit tests are structurally blind to AL that cannot compile and
  to real BC behaviour. A differing verdict is a BLOCK, never "close enough": stop, report the
  mismatch verbatim, and do not reconcile it by editing the expectation.
- **No two live gates at once.** The lease and the op marker are machine-global, even across
  different containers.
- **Never pipe a live gate** through anything that can close the pipe early. Send it to a log file.
- **A baseline is re-recorded by DELETING it and re-running**, never by hand-editing it and never by
  setting an env var to bypass the edit guard. Back the file up outside the repo first, because
  `git checkout -- <path>` is blocked by a safety hook here.
- **Pre-commit per-mutant verdicts BEFORE any live run that changes a fixture**, in
  `docs/superpowers/specs/`, committed. Never edit a pre-commitment after the run: a contradicted
  prediction is the finding, and quietly reconciling it destroys the only evidence that the
  prediction was made in advance.
- **Roadmap:** file a row the moment you discover something worth one. Edit `docs/roadmap/R<nnn>.md`,
  then run `bun scripts/roadmap-index.ts`. Never hand-edit `ROADMAP.md`.
- **This repo is public.** Run `bun scripts/redact-campaign-report.ts <report.json>` before committing
  any campaign report from a real project.

Two traps that have each cost a full live gate run:

- **The test app is the operator's own workflow.** LethAL publishes only the target. If a fixture's
  tests changed, compile the target into the test project's `.alpackages` (a stale build hides behind
  an unchanged version string), compile the test app, publish it with `altool publishapp`, and
  confirm the container reports the version `app.json` declares. Since `16b4014` the runner refuses
  the run and names the missing tests instead of scoring them, so you should see a clear error rather
  than a plausible-looking aggregate.
- **A secret-scanning rule blocks any script that reads a JSON property named `key`.** Do not work
  around it. Check the same thing another way; `git diff --numstat` on a baseline usually proves more
  than a script would.

## Row 1: R137, the conformance refusals that assert nothing

`docs/roadmap/R137.md`. Cheapest of the four, no live gate, no fixture change.

`swap-rec-xrec`'s conformance refusal cases pass unconditionally: an empty `expectedSpecs` is never
checked for extras, so a refusal case would still pass if the operator started emitting a spec where
it must emit none. Every operator's refusal cases in that harness inherit the hole.

Do this: write the failing test first, by making a refusal case emit a spec it should not, and
confirm the harness currently stays green. That is the red state, and it is the whole point of the
row. Then fix the harness so a refusal case asserts the emitted set is EMPTY rather than asserting
nothing, re-run, and check the whole conformance suite still passes for every other operator. Sweep
the other operators' refusal cases for the same shape while you are there, since the fix may reveal
that another operator was quietly emitting something.

Acceptance: the deliberate break goes red with the fix in place and green without it, and
`bun test packages/builtin-tier2` passes. Close R137 with the commit.

## Row 2: R141, the character-refusal live negative

`docs/roadmap/R141.md`. One fixture arm, one pre-commitment, one baseline re-record, two live runs.

`lethal.flip-filter-literal` refuses a filter two structurally different ways and only one has ever
been exercised live. Arm H measures LADDER EXHAUSTION (a closed range classifies, then no rule
matches). The CHARACTER refusal (`REFUSED_CHARACTERS = /[*?@()'&]/` in
`packages/builtin-tier2/src/filter-expression.ts`) is covered by one offline unit test and nothing
else. It fails in the worse direction: a broken character refusal hands BC a string the parser never
validated, which scores `killed` on a platform error with nothing tagging the mechanism (R86, R138).

Do this:

1. Add ONE arm to `fixtures/sandbox-data/src/DataFilterOps.Codeunit.al` whose `SetFilter` literal
   carries a refused character. The `<>''` not-blank idiom is the highest-value choice, because it is
   the commonest `<>` shape in real AL and the one whose accidental mutation is most likely to raise
   inside BC. Mind the AL string escaping; if it fights you, a wildcard (`*`) arm is an acceptable
   second choice, but say in the spec which you chose and why.
2. Give it a covering test in `fixtures/sandbox-data-tests/src/DataTests.Codeunit.al`, its own
   `"Main No."` tag and its own `"Entry No."` band outside 79150-79192 so no existing arm can see its
   rows. Bump the test app's `app.json` version.
3. Run the offline census (`bun scripts/census-fixture-mutants.ts fixtures/sandbox-data/src`) from a
   clean worktree at HEAD and at the fixture commit, and reconcile the delta exactly, the way
   `docs/superpowers/specs/2026-08-12-r134-filter-precommitment.md` does. The load-bearing number:
   `flip-filter-literal` must still appear EXACTLY SIX times, never seven.
4. Write and COMMIT a pre-commitment naming every new mutant's predicted verdict before running
   anything live.
5. `bun run compile:fixtures`, publish the test app, then delete
   `packages/runner/itest/tables.baseline.json` and run `LETHAL_ITEST_TABLES=1 bun run itest:tables`
   to a log file. Judge per mutant against the pre-commitment using `report.mutants`, not baseline
   rows. On any mismatch, stop and report verbatim.
6. If everything matches, run the gate a SECOND, SEPARATE time to prove the new baseline compares
   against itself. An in-process double run does not satisfy this.
7. Update the frozen figures in `CLAUDE.md` and `fixtures/README.md`, extend
   `assertFilterLiteralEvidence` in `packages/runner/itest/tables.itest.ts` to assert the new arm
   emits NO flip mutant, and close R141.

Current frozen figures to grow from: killed 183 / survived 31 / no-coverage 10 over 224 deployed
(243 raw), score 183/214, `platformArtifactKills.killedCount` 1, `assertionScreen.discrimination`
`vacuous`, `untargetedTriggerCount` 0, exactly one baseline failure by name
(`Data Tests.PageActionComputesNonZero`).

## Row 3: R139 checks 2 and 3, identity before measuring

`docs/roadmap/R139.md`. Check 1 landed (`16b4014`, `52dc777`, `7882262`) and refuses the run when the
server answers "found 0" for a declared test. It is reactive: the operator still pays a baseline
round-trip to learn it.

Read the row's own correction before designing anything. The claim that the identity comparison
already exists was WRONG and is now recorded as wrong: `env-tool-publisher.ts` learns "already
published" by attempting the publish and catching BC's `duplicate package ID` rejection, which is a
write-side skip. The bcdev path never publishes the test app, so nothing can reject it.

So this row needs a genuine server READ plus a local expectation, and the local expectation is the
hard half: LethAL deliberately does not compile the test app, so it has no local package id to
compare. Decide between reading the installed test app's VERSION and comparing it against the test
project's `app.json` (cheap, and a version string can match while contents differ) and something
stronger, and write the decision down with its cost. If a control-app procedure over
`NAV App Installed App` is the answer, note that shipping it means bumping
`extensions/lethal-control/app.json`, rebuilding with `/control-app`, and republishing to every
fixture container, and that every gate then requires the new version.

Whatever you build, it must not fire on a healthy run: all four frozen gates must come back
unchanged. Check 3 (folding it into the doctor preflight) is optional and secondary; the row notes
the doctor does not check baseline test health today, so it would widen its remit.

## Row 4: R132, the assertion screen where it actually discriminates

`docs/roadmap/R132.md`. The largest of the four. Do it last, and spec it before building.

All four live gates produce `assertionScreen.discrimination` of `vacuous`, because every fixture test
raises through a bare `Error(...)`. The screen's rule ("the failure text does not begin with
`Assert.`") therefore flags every kill and separates nothing, and no gate anywhere exercises the mode
where it separates real kills from platform artifacts. The rule was scored on Continia Document
Output at 100% recall and 26.1% precision, which is the only place it has ever discriminated, and
that is a customer app nobody can commit.

Before writing any AL, establish whether the fixture containers have Microsoft's test libraries
available and what publishing a dependency on them costs, because that is the whole feasibility
question. If they do, the shape is a test codeunit that raises through Library Assert alongside the
existing bare-`Error` ones, so one suite produces both kinds of failure text and the screen has
something to separate. Pin the DISCRIMINATION (`partial`) rather than a count, for the same reason
the tables gate pins `vacuous`: a count reads identically on a suite that separates nothing and one
that separates well.

If the dependency turns out to be unavailable or too expensive, that is a legitimate outcome. Record
it on the row with what you measured and stop.

## When you are done

Report per row: what landed, what the live evidence was, what you left open and why. Regenerate
`ROADMAP.md` a final time and confirm `bun test scripts/roadmap-index.test.ts` passes.
