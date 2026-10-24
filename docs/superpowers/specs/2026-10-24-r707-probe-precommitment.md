# R-707 (roadmap R707): pre-commitment for the dependent-after-signature-change probe (2026-10-24)

Written BEFORE any server call. Probe: `scripts/r707-probe/` (lethal/r707, 7e531be5), run on **bc2** under
lethal-preproc's lease. Apps:
- A, "R707 Probe Target": `e390149d-8472-4ab1-b1ea-3e10a42156bb` (ids 93700-93709);
- B, "R707 Probe Dependent": `76068df3-2038-49cd-b992-51ea13158bda` (ids 93710-93719).

Publisher "LethAL Probe". Apps are read back by id only. The run uses exactly these builds, with no rebuild:

| Build | Version | Content | sha256 |
|---|---|---|---|
| A1 | 1.0.0.1 | `Answer(): Integer` returns 1 | a4c557344db6f7c14940ab117b509a2082e7ef9b9103889aa93aaf9f0773b295 |
| A1s | 1.0.0.1 | `Answer(X: Integer): Integer` returns X + 1; no zero-argument `Answer` | 4ffe7758c2f115eb38d679c67e8d305cb033b18981bf1e2f8a134229eba0b2e4 |
| A2r | 1.0.0.2 | `Answer` removed; `Other()` | 0ba4dadd2d70eaf1f2285136bde50e6a6fafc78e188ea9ca4ecb710d5c0d5bca |
| A3 | 1.0.0.3 | `Answer(): Integer` returns 3 | b4b8b3c6fddafc75fd17b6f82aa3f16ef6170557a04900997fd8c3a19fa0bb62 |
| B | 1.0.0.1 | `Call()` returns `Target.Answer()`, built against A1; web service `R707Dep` | cd40d074675cc86371acd91c9dfa6cf4449b08e747cc06cbb64a5c2bb0e69f2c |

Code-reading answer: `bc-republish.ts republish <target>` does NOT compile the target's installed dependents
(`publishOrder` filters `republishPlan`'s closure back to the requested apps).

## Step 1: publish A1, then B

- Both accepted, both installed: expected, go on.
- Anything else: the probe is wrong. Stop. Not a measurement.

## Step 2: call B (control)

- 200 and value 1: expected, the probe works.
- 404: the web service is not registered. Probe is wrong; fix and redo. Not a measurement.
- Other error or another value: probe is wrong. Stop.

## Steps 3, 4 and 5: publish A1s / A2r / A3 under installed B, then read A and B, then call B

Per step, the outcomes and what each means. "Call" is the call to B just after the publish.

| Outcome | Meaning | Action for setup / bc-republish |
|---|---|---|
| Publish refused (HTTP 4xx, body names the dependent or the signature) | BC protects the dependent. | None. Close R707 by ruling. Record the message. |
| Accepted; B row gone or `isInstalled` false | BC removed or uninstalled the dependent. A gate then sees its tests app missing. `StaleTestAppError` / `AL0185` fires loudly. | None for verdicts. Say so in docs; a republish of the target needs the tests app republished after it. |
| Accepted; B still installed; call errors (HTTP 4xx/5xx, error body) | B is stale but fails loudly. A gate's tests error at baseline and leave the green set; mutants read `no-coverage`. That under-reports, it never mis-kills. | Add a dependents compile check to `bc-republish.ts` (compile each installed dependent against the new target, refuse by name). Setup already compiles tests apps before publishing (row 5 covers it). Low severity. |
| Accepted; B still installed; call returns a value | **Dangerous.** B runs code it was not built for. | Setup and `bc-republish` must refuse, or recompile and republish the dependents, by name. Needs a design pass and an opus review. |

Value cases, for step 3 (A1s, `Answer(X)` returns X + 1, no zero-argument form):
- call returns 1: B still runs the old A1 bytes' behaviour (stale target code or stale compiled link). Dangerous row.
- call returns 1 because X defaults to 0 (0 + 1): BC bound the old call to the new signature. Also the dangerous row
  (a value from code B was not built for). Note: 1 is ambiguous between the two; the A1s sha and the resident
  bytes, read back, separate them.
- call returns something else, or an error: record it as is.

Step 4 (A2r, `Answer` removed):
- call returns any number: the removed `Answer` still ran. Dangerous.
- call errors naming a missing member: loud failure.
- publish refused: protected.

Step 5 (A3, `Answer()` restored, returns 3):
- call returns 3: B is live again against the restored signature. Recovery works with no republish of B.
- call still errors: B stays broken after recovery. Then recovering a fixture needs B republished. Record it.
- call returns 1: B kept the very first link. Dangerous.

Also record at every step: the publish status and body (500 chars), A's and B's rows (version, `isInstalled`),
and which built file A's resident bytes equal (`residentIs`).

## Cleanup

Uninstall and unpublish B, then A. Both read back absent. Expected: BC keeps the installed-version record
(1.0.0.3 here) until a restart; state it in the submit note. Anything left behind other than that is reported.

## What the run does not decide

Only bc2, BC 28.4 W1, one dependent, one codeunit call. A "refused" or "loud error" result at this size is the
rule the roadmap row needs, not proof for every procedure shape (events, table fields, page extensions).
