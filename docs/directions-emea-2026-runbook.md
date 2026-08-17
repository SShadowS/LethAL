# Directions EMEA 2026 — stage runbook

Everything needed to run the LethAL demo live, in the order you need it. The plan for what remains
before the conference is `docs/superpowers/plans/2026-08-16-directions-emea-2026-readiness.md`; this
file is what you hold on the day.

**The demo is `examples/gift-card`.** 36 mutants, and the last measured run took **13.8 seconds**.
Its expected verdicts are frozen at `docs/campaign/2026-08-16-gift-card/`.

---

## 1. The morning of

Run these in order. All are local except the last, none takes more than a minute.

```bash
bun run typecheck && rm -rf packages/*/dist && bun test   # the tool itself is sane
bun run compile:fixtures                                  # the demo app still compiles
bun scripts/demo-reset.ts                                 # known state + doctor green
```

Then confirm the frozen numbers still hold, which is the one check that would catch a change nobody
expected:

```bash
bun packages/runner/src/cli.ts run --project examples/gift-card \
    --tests examples/gift-card-tests --backend bcdev \
    --config examples/gift-card/lethal.config.local.json --out /tmp/rehearsal.json
bun packages/runner/src/cli.ts campaign compare \
    --manifest docs/campaign/2026-08-16-gift-card/campaign.json \
    --stage rehearsal --report /tmp/rehearsal.json
```

`compare` writes nothing and exits non-zero on any per-mutant difference. A difference on the morning
of is a finding, not a number to update.

**Ten minutes before you walk on**, run `bun scripts/demo-reset.ts` once more. Its last line is
either `ready. doctor is green.` or a named failing check.

---

## 2. Assume the network is hostile

Conference wifi fails, and the demo must not care.

- The BC container runs **on the presenter laptop**. Nothing in the demo path crosses the room's
  network.
- `bc-dev-mcp` is spawned locally by LethAL per run. No hosted service is involved.
- **Verify by disabling the network adapter and running the full demo.** That is the only test that
  counts; reading the config is not it.
- The one thing that does reach out is `al-runner`'s platform-app provisioning — and the demo does
  not use the al-runner backend. Use `--backend bcdev`, which is also the only authoritative one.

**Docker Desktop is the single point of failure and it has already failed once here.** On 2026-08-17
the Windows engine started returning `500 Internal Server Error` on every API call while the Linux
engine stayed healthy; the container was unreachable for about an hour. Symptom to recognise:

```
Test-NetConnection Cronus281 -Port 7049   →  False
docker ps  →  request returned 500 Internal Server Error ... dockerDesktopWindowsEngine
```

If that happens on the day, go to the recording (§5). Restarting Docker Desktop mid-session is not a
thing to attempt on stage.

---

## 3. The failure paths, rehearsed

Rehearse each of these once, so the shape is familiar. For each, the point is not to avoid it — it is
to narrate it. A narrated failure reads as an honest tool. An unrehearsed one reads as a broken one.

### Exit code 3 — quarantined

**What it looks like:** the run stops, the report says `quarantined`, and the console names the
reason. Verdicts already produced are not reported as findings.

**What to say:** "It has stopped and refused to give me numbers. That is the tool saying it cannot
prove the server was in a state where its answers mean anything — so it does not offer any. That is
the behaviour I want from something measuring my tests."

**Recovery:** `bun scripts/demo-reset.ts`, then `--resume` if you want the run continued.

### A red baseline

**What it looks like:** the report names the failing tests, marks the run `baseline-red`, and the
mutants covered only by those tests read `no-coverage` rather than `survived` (R55).

**What to say:** "Some of my tests were already failing, so the tool refuses to score the mutants
only those tests covered. A tool that scored them anyway would hand me a number built on a suite
that was already broken."

**Most likely cause on the day:** the test app on the container is stale relative to the source. See
§6.

### The container is unreachable

**What it looks like:** `doctor` red on `environment`, `control-version` and `lease`; a run refuses
before publishing anything.

**What to say:** nothing — switch to the recording. Do not debug Docker in front of a room.

### The agent does something unexpected (if you run §4 live)

**What to say:** "That is a live agent, so it is allowed to surprise me." Then switch to the branch
you prepared. Never present a prepared result as live.

---

## 4. The beat-by-beat

Target: five minutes. Times are from the measured 13.8 s run, so the narration has to carry the
middle, not the tool.

| Time | What you do | What you say |
|---|---|---|
| 0:00 | One slide: three objects, eight tests, all green. **Start the run immediately.** | "You have all written this app. Eight tests, all passing. Would you ship it?" |
| 0:20 | The run streams verdicts while you walk the test list | Name the tests: error paths, a trigger assertion, an audit-trail check. Let them believe the suite. |
| 0:40 | Run finishes. Read the summary. | "20 killed, 9 survived, 7 no-coverage. Coverage on `GetBalance` was 100% the whole time." |
| 1:00 | `lethal explain report.json --top 10` | **Use `--top 10`, not `--top 5`** — the planted bug ranks sixth of nine and a cap of five cuts it. |
| 1:20 | The planted survivor: the deleted `SetRange` | "One line gone, every test green. This function now returns the whole store's outstanding balance instead of this card's. `executionProven: true` — a test provably ran this line and did not notice." |
| 2:10 | The `no-coverage` cluster: `BlockExpiredCards` | "Seven mutants, no test executed any of them. That is the nightly job. Expiry *is* tested — at redeem time, which is different code." |
| 2:40 | The honest beat: the expiry boundary survivor | "Is a card valid ON its expiry date? Nobody wrote that down, so the tool will not tell you it is a bug. A survivor is a lead, not a verdict." |
| 3:10 | The agent loop (§ below), or its recording | "The output was built for this: an agent reads the report, writes the test, re-runs." |
| 4:40 | Close | "Green suite, shippable bug, one loop to close it. It runs on your app this afternoon." |

### The agent loop (D5)

Prompt the agent with the shipped skill and one instruction:

> Read `report.json`. Take the top survivor. Write the test that kills it, publish the test app, and
> re-run LethAL narrowed to that file to show the verdict flip.

The kill it should write is a **second gift card**: issue two, redeem against one, assert each
balance separately. That makes the missing `SetRange` load-bearing for the first time.

Re-run narrowed with `--only "src/GiftCardMgt.Codeunit.al"`. Narrowing selects which mutants run and
**cannot change a verdict**, so the flip is honest.

**Decide by the end of September whether this is live or recorded, and build the recording either
way.** If it is live, kick it off before you talk through the JSON fields, so the compile and publish
happen while you have something to say.

---

## 5. Backups, on the laptop, not in the cloud

1. **A recording of the full run**, made during a rehearsal. Not yet recorded — do it during the
   first clean rehearsal.
2. **The frozen report**, already committed at
   `docs/campaign/2026-08-16-gift-card/rehearsal.report.json`. `lethal explain` on it works with no
   server at all, so the entire "read the result" half of the talk survives a dead container.
3. **The source overlay**, generated ahead of time:
   ```bash
   bun scripts/render-overlay.ts docs/campaign/2026-08-16-gift-card/rehearsal.report.json \
       examples/gift-card --out overlay.html --first-party
   ```
   One self-contained HTML file, no network, opens in any browser.

---

## 6. Legibility, and the one thing that bites

Test on the actual projector if you can, at 1080p from the back of the room otherwise.

- Terminal font 16pt or larger. The console renderer is dense.
- The `explain` output is JSON: consider piping the survivor block through a larger-font viewer, or
  show the overlay (§5) instead, which was built to be read at distance.
- Dark or light both work for the overlay; it follows the viewer's theme.

**The bite:** if you edit the demo's AL and forget to republish the TEST app, the tool reports a
stale test app or a red baseline, and the cause is not on screen. `bun run compile:fixtures` catches
a broken app; only a republish fixes a stale one:

```powershell
Publish-BcContainerApp -containerName Cronus281 -appFile GiftCardDemoTests.app `
    -skipVerification -sync -install -useDevEndpoint -credential $cred
```

Both apps must be published to the **DEV scope**. At global scope the dev endpoint refuses to let
LethAL replace the target, and the error names a dependency rather than the scope.

---

## 7. Answers for the floor, with the numbers

Do not improvise these. Each is measured and each has a file behind it.

**"Can I run this on my 500-file app?"**
Not unscoped. A real commercial extension measured **19,850 mutation sites**; an unscoped run is
refused by default above 1,000 because it costs days and usually cannot publish at all. Scope with
`--only` and `--tests-only`. A narrowed slice of 102 mutants took **231 seconds**; the same slice
unnarrowed took 954 to 1,065 s, and **baseline execution dominates** — 864 s of that 1,065 s was the
baseline test run.

**"What about code behind a `Confirm` or a page?"**
Every verdict describes the non-interactive branch: `GuiAllowed=No`, `ClientType=ODataV4`. Measured
whole-app: **62 of 19,850 sites — 0.3% — sit lexically inside a `GuiAllowed`- or `Confirm`-guarded
branch.** The three constructs differ: `Message` is a no-op, `Confirm` forces its DEFAULT answer so
the non-default arm is the unreachable one, and `Page.RunModal` errors.

**"Does it work with TestPage tests?"**
No, and it says so. A `TestPage` test cannot be scored; on the default fenced path one can hang and
quarantine the whole run. The mitigation is `coverageMode: "procedure"`, which completes but runs
the hub GUI-allowed, so it can disagree with the fenced runner about a test's outcome. Mutant
verdicts always execute on the fenced path, so a mutant covered only by TestPage tests receives no
verdict and is reported unscoreable rather than guessed at. Recovery was measured at **2.30% of a
real app's mutants** and the routed path was deleted rather than kept as a half-answer.

**"Is a survivor a bug?"**
No. It is a lead. What HAS been established on a real product: coverage selection does not hide
kills — two runs of one codeunit, identical except coverage mode, compared per-mutant across all 138
mutants, and no mutant reported `survived` or `no-coverage` under selection was killable by the full
suite. What is NOT established is that any individual survivor is non-equivalent. Read `validity`
before quoting `mutationScore`.

**"How do I know the number is real?"**
The report carries its own caveats: `reliability`, `scoreDescribes`, and a caveat list. A narrowed
run says it is narrowed. A red baseline says so and withholds the affected mutants. And the demo's
own 36 verdicts were **pre-committed before the run and all 36 matched** — the file is in the repo,
dated before the run.

**"Which backend should I use?"**
`bcdev`. `al-runner` is offline and NOT authoritative: its `asserterror` never fails a test, so
mutants killable only that way come back survived there. Under-reporting only, never a false kill,
and a startup canary measures the actual binary each session.

**"You planted that bug."**
Yes. The app is a plant; the mechanism is not. It is released, so point it at your own code — and
the demo app ships with it, so you can reproduce this exact run before you trust it with anything
real.
