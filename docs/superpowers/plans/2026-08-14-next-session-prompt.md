# Next session: close R147 and R146 autonomously, one at a time

Written 2026-08-14, after R74/R75/R78, R144, R143, R131, R126, R130 closed in one session and R146
and R147 were filed out of that work. Everything below is already on the roadmap. Read `CLAUDE.md`
first: it is the authority on the build loop, the live gates and the roadmap discipline. This file
only adds what is specific to these two rows.

## How to work

Take the rows in order. Finish one completely, commit it, then start the next. Do not batch them,
and do not start the second because the first got hard. If a row turns out to be blocked, write what
you learned into its `docs/roadmap/R<nnn>.md`, commit that, and move on: a measured blocker recorded
on the row is a real result, an abandoned row is not.

You are running without a human in the loop, so the roadmap row plus its cited evidence IS the
approved scope. That licenses you to implement what the row asks for. It does not license you to
widen it: if you find yourself designing something the row does not name, stop, file a new row and
continue with what was asked. That rule earned its keep twice last session. R138's row asked for a
blanket tag and the narrowing became R143; R131 asked for a cache report and the fact that
`lethal doctor` refuses al-runner-only projects became R146 instead of being smuggled in.

Rules that are not negotiable, all learned the expensive way:

- **Build loop order:** `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test`. Skipping
  the dist wipe gives roughly 21 phantom failures from stale compiled `*.test.js`.
- **After touching any `.al` under `fixtures/`, run `bun run compile:fixtures`.** Nothing else
  compiles them, and a broken fixture leaves the live gate measuring the previously published build
  (R56).
- **TDD.** Write the failing test, watch it fail for the right reason, then implement. Red-check
  every fix: revert the specific fix, confirm the specific test goes red, restore, report both. A
  red-check producing the WRONG failure message is not a red-check.
- **Keep control tests that pass both ways.** R143 shipped with siblings that pass with the detector
  enabled and disabled alike, so the change could not pass by switching the feature off.
- **Live gates are the authority.** A differing verdict is a BLOCK, never "close enough": stop,
  report the mismatch verbatim, do not reconcile it by editing the expectation.
- **No two live gates at once.** The lease and the op marker are machine-global, even across
  containers.
- **Never pipe a live gate** through anything that can close the pipe early. Send it to a log file
  and run it in the background.
- **A baseline is re-recorded by DELETING it and re-running**, never by hand-editing and never by
  setting an env var to bypass the edit guard. Back the file up outside the repo first: `git checkout
  -- <path>` is blocked by a safety hook here.
- **Pre-commit per-mutant verdicts BEFORE any live run that changes a fixture or a report figure**,
  in `docs/superpowers/specs/`, committed. Never edit a pre-commitment after the run: a contradicted
  prediction is the finding.
- **Roadmap:** file a row the moment you discover one. Edit `docs/roadmap/R<nnn>.md`, then run
  `bun scripts/roadmap-index.ts`. Never hand-edit `ROADMAP.md`.
- **No `file.ext:<line>` citations in docs** (`scripts/line-citations.test.ts` fails the build). Cite
  a greppable name.
- **This repo is public.** Run `bun scripts/redact-campaign-report.ts <report.json>` before
  committing any campaign report from a real project.
- **Lint only what you touched:** `bunx biome check <paths>`.

Operational notes worth minutes each:

- Containers: `Cronus281` (sandbox-app), `Cronus283` (sandbox-data), `Cronus282` free. Switch with
  `docker context use desktop-windows` first; the session default is the Linux engine.
- In shell heredocs use `python3`, not `python`. Also beware `\\1`-style backreferences in Python
  replacement strings when the replacement contains a backslash path: last session that silently ate
  a character out of a committed transcript and needed a second repair pass. Build such strings with
  `chr(92)` or use plain `str.replace`.
- `al-runner` ships several times a day and is a global dotnet tool. PRINT the version first
  (`al-runner --version`) and record it beside any measurement. It was **v2.1.2.0** on 2026-08-14.

Current frozen figures to work against:

- `itest:tables`: killed **191** / survived **31** / no-coverage **10** over **232** deployed
  (**252** raw), score 191/222, `untargetedTriggerCount` **0**, `assertionScreen.discrimination`
  **`partial`**, **`platformArtifactKills.killedCount` 2** (lowered from 3 by R143 on 2026-08-14;
  `run-trigger-skipped-insert` now holds `InsertTwiceWithKeyTrigger` alone),
  **`declarativeSites.siteCount` 1** in `src/DataMainList.Page.al` (added by R144), exactly one
  baseline failure by name (`Data Tests.PageActionComputesNonZero`).
- `itest:bcdev`: **3 / 10 / 3**, `assertionScreen.discrimination` **`vacuous`**.
- `itest:alrunner`: **3 / 13 / 0** against al-runner v2.1.2.0. The gate PRINTS the build it ran
  against as its first line; read it before calling a difference a regression.
- `itest:envtool`: **cannot currently run**. Its environment reported `Stopped` on 2026-08-14 and
  LethAL refuses to start an environment it does not own. Do not start someone's cloud environment.

---

## Row 1: R147 — every al-runner CLI invocation re-downloads 230 MB of platform apps

`docs/roadmap/R147.md`. The only open row with a measured payoff, and the one that changes the argv
producing every verdict. It needs the live `itest:alrunner` gate.

Measured 2026-08-14 on al-runner 2.1.2.0, warm cache, `fixtures/sandbox-app` + `fixtures/sandbox-tests`:

| invocation | wall clock | platform-app downloads |
| --- | --- | --- |
| `--auto-provision` (LethAL's argv today) | 17.0 s | 2 x 115 MB |
| third consecutive run of the same | 17.0 s | 2 x 115 MB |
| `--package-cache <artifacts>/<build>/platform-apps`, no `--auto-provision` | 7.1 s | 0 |
| no flags at all | 1.4 s, FAILS with the provisioning-gap message | 0 |

LethAL makes one CLI invocation per (mutant x covering test), so this is paid on every one.

Do this, in this order:

1. **Measure the three unknowns first.** A wrong answer here produces false verdicts rather than slow
   runs, which is why none of this is a refactor:
   - Does the run still work when the project's declared dependency version differs from the resolved
     platform-app build? The fixture declares `28.0.46665.47126` in `.alpackages` and the runner
     resolved `28.0.46665.53655`. That mismatch is what `--auto-provision` papers over today, and the
     7.1 s control above already ran green across it once. Confirm it deliberately rather than
     inheriting one lucky run.
   - What happens on a machine with NO artifacts, where provisioning must happen first? This is
     R125's case, and R125's ruling stands: do NOT drop `--auto-provision` from the provisioning
     step, and never pin the tool to an older release to make a gate pass.
   - Is `[provision] Resolved: 28.0 -> 28.0.46665.53655` reliably present and parseable? Note it is a
     DIFFERENT build from the engine build R129 already reads off `[bc] selected BC ...` (28.0.x vs
     28.1.x). The two provisioning passes disagreeing about where the toolkit lives is R130's own
     observation.
2. **Then implement the shape the row names:** provision once per session (R128 already does), read
   the resolved platform-app build off the runner's own line the way R129 reads `[bc]`, and for every
   subsequent mutant invocation pass `--package-cache <artifacts>/<that build>/platform-apps` with no
   `--auto-provision`.
3. **Write the spec first** under `docs/superpowers/specs/` and run the `spec-adversary` subagent
   against it before writing code. This touches verdict-producing argv.
4. **Pre-commit the live expectation** before the gate run: `itest:alrunner` frozen at **3 / 13 / 0**,
   every per-mutant verdict unchanged, and the al-runner build printed as the gate's first line. The
   wall-clock improvement is a bonus, not an assertion: do not gate on timing.
5. **Live:** `LETHAL_ITEST_ALRUNNER=1 LETHAL_ALRUNNER_PATH="C:/Users/SShadowS/.dotnet/tools/al-runner.exe"
   bun run itest:alrunner`, in the background, to a log file. Over ten minutes.

A side benefit worth stating in the row when it closes: pinning the directory found at session start
makes a mid-session Microsoft publish unable to move the platform apps under a running campaign.
Today the prefix resolves forward on every invocation, so a run that starts on `…53655` can finish on
`…53700` with nothing recording that it did.

Acceptance: the three measurements recorded, a spec reviewed by `spec-adversary`, the argv change
landed, `itest:alrunner` unchanged at 3 / 13 / 0 judged per mutant, and R147 closed with the new
per-invocation cost measured the same way the old one was.

## Row 2: R146 — `lethal doctor` refuses an al-runner-only project

`docs/roadmap/R146.md`. Offline, no container, small. Do it after R147 so the two do not share a
gate run, and because R147 may teach you what an al-runner doctor should actually check.

`buildDoctorDeps` throws when a config has neither an `envTool` nor a `bcdev` section, with a message
that was accurate until R131 added the `al-runner-cache` check on 2026-08-14. That check reads a
local directory, needs no environment, and is ABOUT al-runner, but an al-runner-only project never
reaches it because the throw fires first.

Do this:

1. Decide what an al-runner-only `lethal doctor` should CHECK, not just print. Candidates needing no
   BC container: the al-runner binary's presence and version (the same read R123 would formalise),
   the artifact cache (built), and `alc` (needed for the target compile on both backends).
2. The environment, lease, quarantine and control-version checks have no meaning there and must stay
   ABSENT, never pass vacuously. That is the R110 lesson: a check that structurally cannot fail,
   rendered as `[ok]`, was green in exactly the scenario the recovery tooling exists for.
3. Keep the throw for a config that is neither al-runner nor bcdev. That is a real mistake worth
   refusing.
4. Print a caveat naming what was NOT checked, the way `DOCTOR_CREATE_MODE_CAVEAT` already does for a
   create-mode envTool config, so a green al-runner doctor cannot read as a green bcdev doctor.
5. Red-check: with the caveat suppressed, or with the new checks removed, a test must go red.

Note `buildDoctorDeps` already takes `alRunnerCacheDir` for injection, added so the doctor-cli suite
does not walk whatever multi-GB cache the machine happens to hold. Use it in any new test.

Acceptance: an al-runner-only config produces a report rather than a throw, the absent checks are
named rather than faked, red-check passes, `bun test` green, R146 closed.

## Explicitly NOT in scope

- **R89** is a standing watch, not work. It needs a recurrence with its argv captured on a Running
  hosted environment. Re-checked 2026-08-14: the environment reports `Stopped`, and the guard that
  would capture the next occurrence was red-checked and is live (suppressing the `resume-resolved`
  emit turns 10 resume tests red). Do not start the environment.
- **R145** (per-mutant artifact variants for declarative surfaces) is filed deliberately unscheduled:
  blocked on DEMAND, with an unanswered coverage question. Do not start it.
- **R126 is CLOSED and must not be retried.** Measured 2026-08-14: a resident `al-runner --server`
  answers with the FIRST bundle it compiled, forever, so one call per mutant would score every mutant
  against whichever compiled first. Reopen only if a resident server's answer reflects a changed
  bundle; `scripts/r126-server-probe/` settles that in about a minute.
- **R14** (stay on the newest tree-sitter-al) is a standing re-check. Re-check it if you touch the
  grammar; otherwise leave it.

## When you are done

Report per row: what landed, what the evidence was, what you left open and why. Regenerate
`ROADMAP.md` a final time and confirm `bun test scripts/roadmap-index.test.ts` passes. State the open
count afterwards and list the rows.
