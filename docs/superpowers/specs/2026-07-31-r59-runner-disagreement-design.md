# R59 — the unsafe direction of the runner disagreement

**Status:** design, 2026-07-31. **The entry's premise is wrong, and that is the main finding.**

## 1. What R59 says, and what the code says

R59 fears a **false kill**:

> A test the hub passes that the fence would fail … enters the green set, then fails against every
> mutant it covers on the verdict path, and each of those reads as a KILL: a false kill, the one
> error class LethAL otherwise structurally avoids.

**That cannot happen, and it has not been able to since Layer 5C-A.** A `killed` verdict is not
produced by a failing covering run. `runMutantsOnBackend` (`packages/runner/src/orchestrator.ts`,
the `v.outcome === "fail"` branch) does this instead:

```ts
if (v.outcome === "fail") {
  await activateOnce(args.backend, args.safety, null);      // deactivate the mutant
  const { verdict: confirm } = await runFenced(args.backend, args.safety, ref,
                                              { coverage: "none", timeoutMs: budget }, …);
  …
  } else if (confirm.outcome === "pass") {
    verdict = "killed";                                      // ONLY here
```

The confirmation run is **unmutated** (`activate(null)`) and **fenced** (`coverage: "none"` routes
to `runViaTransport`, never to the hub — `BcDevMcpBackend.run`). So a kill requires the test to fail
WITH the mutant and pass WITHOUT it **on the same runner that produced the failure**. A hub-green /
fence-red test fails that confirmation and lands in the `else` branch:

```
verdict = "error"; cause = "unstable";
failureNote = `unstable test ${ref.method}: fails at baseline confirmation`
```

Not a kill. The direction R59 calls unsafe is already contained, by a mechanism built for a
different reason.

## 2. What IS missing — the diagnosis, not the containment

The user is told their test is **unstable**, which reads as flakiness in their own suite. In a hub
coverage mode the real cause is deterministic and nameable: the green set was measured on a
`GuiAllowed=Yes` / `ClientType=Web` session and every verdict is produced on a `GuiAllowed=No` /
`ClientType=ODataV4` one (R57, measured). Sending a developer to debug flakiness when the answer is
"your two runners are different session types" is the same shape as R27 (a permissions refusal
reported as `unstable`) and R35 (a refusal reported as "unsupported test type").

This is also the only part of R59 that survives: an item that says "undetected" is right about the
*naming*, wrong about the *hazard*.

## 3. The detector — zero extra runs

In a **hub** coverage mode (`procedure`, `line`), every covering test reached the mutant loop by
being in the hub-produced green set. So a confirmation failure IS, by construction, an observation
of "passed on the hub, failed on the fence". Nothing needs to be re-run to detect it; the
observation is already in hand and is being discarded.

- Condition: `caps.coverage` is `"procedure"` or `"line"` **and** the confirm run failed.
- Effect: the per-mutant note names the disagreement instead of only "unstable", the test is
  collected session-wide, and the report carries `runnerDisagreement` plus a
  `runner-disagreement` caveat.
- **Verdicts do not move.** The mutant is already `error cause=unstable` and stays exactly that.
  This is a naming change, which is why it cannot introduce a wrong verdict of its own.

**What one confirmation run cannot tell us**, and the note must not pretend otherwise: a
deterministic hub/fence disagreement and an ordinary flaky test both present as one failed confirm.
The note names both and points at `coverageMode: "fenced"` — where baseline and verdicts come from
one session type — as the way to tell them apart. A second confirm run would separate them, and is
deliberately NOT added: it costs a run per affected test on a mode that is scheduled for deletion
after one release, and "deterministic on the fence" is not the actionable part — "stop measuring
your green set somewhere else" is.

## 4. Why this is being built at all, given the mode is legacy

`coverageMode: "procedure"`'s one-release grace has **not** expired: there are no git tags in this
repo and `docs/releasing.md` states in terms that no release has been cut. The execution plan's
instruction is explicit for that branch — build the detector, do not delete a documented escape
hatch early.

## 5. Testing

The load-bearing test is a fake backend **whose two runners disagree** — `run()` returns `pass` for
`coverage: "procedure"` and `fail` for `coverage: "none"` on the same test. R55's own review named
this as the thing any check here needs, because every frozen gate has a green baseline and is
therefore blind to the mechanism.

Assertions:

1. The mutant is `error` with `cause: "unstable"` — **NOT `killed`**. This is R59's stated fear,
   pinned as impossible rather than argued as impossible.
2. The note names the hub/fence disagreement and cites the fenced mode as the resolution.
3. `SessionReport.runnerDisagreement.tests` lists the test, and `validity.caveats` carries
   `runner-disagreement`.
4. In a **fenced** or **none** mode the same fake produces no such note and no report field — there
   is one runner, so the diagnosis would be a lie.

Red-checked by revert.

## 6. Live proof

A throwaway `[Test]` on `fixtures/sandbox-tests` whose body is `if not GuiAllowed then Error(...)`
followed by a call into mutable code, run once in `coverageMode: "procedure"` against Cronus281:
hub-green, fence-red, covering a real mutant. Expected: the mutants it covers come back `error`
(never `killed`) with the new note, and the report names the test. Removed afterwards — the frozen
gates run in `fenced` mode and must not move.

## 7. What this does NOT prove

- It does not prove hub/fence disagreement is RARE or COMMON in the field; R55 measured 12 of 56 on
  Document Output in the *safe* direction, and nothing has yet measured the unsafe one on a real
  project. The detector is what would measure it.
- It does not distinguish flakiness from disagreement (§3).
- It changes nothing on the default (`fenced`) path, which has one runner and cannot have this
  problem at all.
