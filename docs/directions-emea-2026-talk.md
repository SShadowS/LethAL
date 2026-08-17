# Directions EMEA 2026 — the talk

Slide-by-slide, with the words that carry each one and the number behind every claim. Written to be
turned into whatever deck tool you use; the runbook
(`docs/directions-emea-2026-runbook.md`) is the operational half.

**Shape:** roughly 25 minutes of talk, 5 of which is the live demo, then questions. If the slot is
45, the extra goes to §7 and to questions, not to more slides.

---

## The positioning decision (F3)

**Call it alpha. Say so on the title slide.**

The temptation is to drop the word for a conference audience. Do not. The README's voice — "honest
about its limits rather than complete" — is the strongest asset in a room that has been oversold
tooling before, and it is the thing that makes the rest of the talk credible. A tool that opens by
telling you what it cannot measure has earned the right to tell you what it can.

What that means concretely on stage:

- The limits slide (§7) is not an apology at the end. It is a feature, and it goes before the close.
- The honest survivor beat in the demo (§5) is not a stumble. It is the point.
- "Alpha" sets the expectation that it will change under them, which is true: the CLI surface, the
  config schema and the report shape may all move before 1.0.

---

## 1. Title

> **LethAL — which of your AL tests actually catch bugs**
> Alpha. Honest about its limits.

Say your name, your day job, and that this is a tool you built because you could not answer that
question about your own code.

## 2. The question coverage cannot answer

One slide, one sentence, and it is the whole talk:

> **Coverage tells you a line ran. Mutation tells you a line is checked.**

Then the concrete version:

> If I change this line and every test still passes, running it proved less than the coverage number
> suggested.

Do not define "mutation testing" as a technique yet. Define the question first; the technique is the
answer to it and lands better in that order.

## 3. What LethAL does

Four words, and they are the vocabulary for the rest of the talk:

| Word | Meaning |
|---|---|
| **mutant** | one small deliberate change: `<` becomes `<=`, a block is emptied, a `TestField` is dropped |
| **killed** | a test failed. Your suite caught it. |
| **survived** | every test still passed. Nothing you wrote notices that behaviour. |
| **no-coverage** | no test executed that code at all |

Mention once, and move on: **the technique is decades old outside the BC world. What is new here is
the AL implementation, not the idea.** Claiming to have invented mutation testing in front of this
audience would cost you the room.

## 4. How it works, in one slide

> It copies your project to a scratch directory, instruments **every** mutation site behind a runtime
> guard, compiles **once**, publishes **once**, then switches on one mutant at a time and runs your
> tests.

Two things worth saying out loud because they are the objections forming in the room:

- **Your source tree is never modified.** The copy is mutated, not your code.
- **It is one compile and one publish**, not one per mutant. That is what makes 36 mutants take 14
  seconds instead of an afternoon.

## 5. The demo

Runbook §4 has the beat-by-beat and the exact commands. The narrative arc:

1. Eight tests, all green. Would you ship it?
2. Start the run. Talk about the suite while it goes — error paths, a trigger assertion, an
   audit-trail check. Let them believe it. It is a *good* suite by everyday standards.
3. 20 killed, 9 survived, 7 no-coverage.
4. **The survivor:** one deleted `SetRange`, every test still green, and the function now returns the
   whole store's outstanding balance instead of one card's. `executionProven: true` — a test
   provably ran that line and did not notice.
5. **The no-coverage cluster:** the nightly job nothing calls. Expiry *is* tested, at redeem time,
   which is different code.
6. **The honest beat:** the expiry-boundary survivor. Is a card valid ON its expiry date? Nobody
   wrote it down, so the tool will not call it a bug. *A survivor is a lead, not a verdict.*

Thirty seconds of (6) buys the room for everything else.

## 6. The agent angle

> The output was built for a machine to read, because increasingly a machine is what reads it.

Show, do not describe:

- `lethal doctor --json` — the pre-flight, parseable, `notChecked` saying what a green report does
  **not** cover.
- `lethal explain report.json --top 10` — every survivor with `executionProven`, `coveringTests`,
  and the interpretation that says what the value means and what it rules out.
- Then the loop: an agent reads that, writes the test, re-runs, and the verdict flips.

The line that matters: **`--top` exists because the projection did not fit an agent.** A 473-mutant
report projects to 243 KB, and the output now always states what it dropped. That is the kind of
detail that tells this audience the tool was built by someone who actually pointed it at something
real.

End the slide with the two paths they can take home:

```
docs/using-lethal-from-an-agent.md      the contract
skills/lethal-mutation-testing/SKILL.md  drop this into your own agent
```

## 7. What it cannot measure

Before the close, not after. Every number here is measured; runbook §7 has the sources.

- **Every verdict describes the non-interactive branch.** `GuiAllowed=No`, `ClientType=ODataV4`.
  Measured whole-app: **62 of 19,850 sites, 0.3%**, sit inside a `GuiAllowed`- or `Confirm`-guarded
  branch.
- **A `TestPage` test cannot be scored**, and on the default path one can hang a whole run. Recovery
  was measured at **2.30%** of a real app's mutants and the routed path was **deleted** rather than
  kept as a half-answer.
- **Unscoped runs on a real app are refused by default.** 19,850 sites is days. Scope with `--only`.
- **A survivor is a lead.** Some survivors cannot be killed by any test.
- **`al-runner` is not authoritative** — under-reporting only, never a false kill.

Then the sentence that ties it to slide 1:

> A mutation score you cannot qualify is worse than no score. Every report carries its own caveats,
> and the tool refuses to give you a number it cannot stand behind.

## 8. Close

> Green suite. Shippable bug. One loop to close it.

Three links, and the last one is the ask:

```
github.com/SShadowS/LethAL        the tool, MIT
examples/gift-card                the app from this talk — run it before you trust it on your own
docs/using-lethal-from-an-agent.md
```

The ask: **point it at one codeunit of your own and tell me what it finds.** Not "adopt it" — one
codeunit. That is a request a skeptical partner can say yes to on the flight home.

---

## Things to have ready but not on a slide

- The 2.30% TestPage recovery number, and the fact that R69 closed with the path **deleted**. Someone
  will ask why you did not keep it as a fallback.
- The cost table: 231 s narrowed, 954-1,065 s unnarrowed, with **baseline dominating** at 864 s of
  the 1,065.
- That the demo's 36 verdicts were pre-committed before the run and all 36 matched, with the file
  dated in the repo. This is the answer to "how do I know the number is real".
- Which backend the demo used (`bcdev`) and why it is the only authoritative one.

## What NOT to say

- Do not claim a mutation score is a quality metric. It is a question generator.
- Do not promise it runs on a whole app today. It does not, and someone in that room will try it on
  Monday.
- Do not present a prepared agent result as live. If the loop is recorded, say it is recorded.
- Do not name a customer's code without their permission.
