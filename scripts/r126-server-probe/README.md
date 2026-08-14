# R126 probe — a resident `al-runner --server` answers with the FIRST bundle it compiled

Measured **2026-08-14** against **al-runner v2.1.2.0** on this Windows machine, with
`fixtures/sandbox-app` + `fixtures/sandbox-tests` copied into a scratch directory.

## Why the probe exists

[R126](../../docs/roadmap/R126.md) says al-runner's warm server mode "only pays if the backend can
make ONE call per MUTANT instead of one per test", because a single whole-suite response already
carries every verdict that mutant needs. The row's first deliverable is whether that condition
holds.

LethAL activates a mutant by REWRITING `MutationSelector.Codeunit.al` in the source directory
(`AlRunnerBackend.activate`). So one call per mutant means: change a source file, ask the resident
server, read the verdicts, repeat. Nobody had measured whether a resident server acts on the change.

## What it does

`probe.ts` drives `al-runner --server` over stdin/stdout, one JSON request per line, and:

1. asks once with unchanged sources;
2. edits `SandboxLogic.IsOverBudget` from `>` to `>=` — which `OverBudgetDetected` asserts against
   ("equal amounts must not be over budget"), so the verdict MUST flip to `fail` — and asks again;
3. restores and asks again;
4. sends eight guessed request fields (three isolation spellings, five reload/rebuild spellings)
   while the source is mutated, so a field that works announces itself by flipping the verdict;
5. sends an unknown command;
6. **the control**: mutates the source FIRST, starts a FRESH server, and asks once. Then restores
   while that server is still resident and asks again.

```
bun scripts/r126-server-probe/probe.ts <scratch-dir> [al-runner path]
```

`<scratch-dir>` must hold `app/` and `tests/` copies of the two fixtures. Warm the AL-output cache
with one CLI run first: `--server` has no `--auto-provision`.

## What it measured

| step | source at the time | verdict returned |
| --- | --- | --- |
| request 1, fresh server | original | `OverBudgetDetected` **pass** (correct) |
| request 2, same server | mutated to `>=` | **pass** (WRONG — should fail) |
| request 3, same server | restored | pass |
| fresh server, request 1 | mutated to `>=` | **fail** (correct) |
| same fresh server, next request | restored | **fail** (WRONG — should pass) |
| the CLI, same mutated source | mutated to `>=` | **fail** (correct) |

The staleness is symmetric, and the control is what makes it a finding rather than a fixture
accident: each SERVER is correct on its first answer and frozen afterwards, while the CLI is correct
every time on the same files.

It is not the AL-output cache. On one run the stale answer arrived with
`"cached": false, "changedFiles": ["SandboxLogic.Codeunit.al"]` in the summary — the server DETECTED
the edit, said it was not serving from cache, and still executed the previously loaded assembly. A
fresh server that reported `"cached": true` gave the correct answer.

No request field reaches it. All eight guessed fields were ignored silently, exactly as the six
test-filter spellings were in R97's measurement:

```
isolation, testIsolation, isolationMode, noCache, reload, forceRebuild, rebuild, invalidate
```

## The timings, so the size of the prize is on record

Same machine, same fixture, al-runner 2.1.2.0:

| path | wall clock |
| --- | --- |
| CLI, whole suite, AL-output cache MISS | 26.1 s |
| CLI, whole suite, cache hit | 13.2 s |
| CLI, `--test <one test>`, cache hit | 13.2 s |
| server, first request after start | 4.7-6.3 s |
| server, subsequent warm requests | 0.42-1.14 s |

A single test costs the same as the whole suite on the CLI: the fixed process + dependency load
dominates completely. That fixed cost is exactly what server mode removes, which is why R126 is
worth keeping honest about rather than dismissing.

## What this does NOT establish

- **Not a claim about the VS Code extension.** It is the documented consumer of this protocol, and
  an editor that reloads on save may never hit this. The finding is about a caller that changes
  sources BETWEEN requests to one resident server.
- **Not isolation semantics.** Still unmeasured, and now moot for R126: a protocol that will not
  recompile cannot be given a per-mutant isolation guarantee to reason about.
- **Not stability.** al-runner ships several times a day. `protocolVersion: 2` and every number here
  are today's values, against 2.1.2.0.
