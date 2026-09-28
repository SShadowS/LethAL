# 04: OData stops answering after client-aborted calls

> **WARNING.** In the incident every OData call hung afterwards, including `$metadata`, for 40+
> minutes, until the server tier was restarted. Use a disposable container.

## What it reproduces

Incident record section 4, "OData endpoint stops answering after client-aborted calls
(2026-07-18)". The client calls an action that runs longer than the client waits, aborts it
client-side while the server is still running it, repeats, then checks whether `$metadata` and a
trivial action still answer.

Observed on: Cronus28 (then a separate host), 2026-07-18, BC build not recorded. The original slow
call was a different action (`MutationControl_SetActive`, aborted after about 90 s); what it was
doing on the server is not recorded, so this repro uses a CPU loop.

## The app

| Object | Id | Role |
| --- | --- | --- |
| codeunit "NST Repro04 API" | 91640 | Web service `NstRepro04`. `Slow(ms)` spins for `ms`, `Ping()` |
| codeunit "NST Repro04 Install" | 91641 | Registers the web service |

No dependencies.

## Steps

1. Compile and publish the app (see [../README.md](../README.md)).
2. `bun client.ts`

Options: `--calls` (default 5), `--slow-ms` (default 120000, how long each call runs on the server),
`--abort-after-ms` (default 10000, when the client aborts it), `--checks` (default 5) and
`--check-every-ms` (default 60000) for the health checks afterwards. It checks health before
starting, logs each aborted call, then checks `$metadata` and `Ping` repeatedly.

3. If OData stops answering, check that the dev endpoint still answers (port 7049; in the incident
   it did), for example by publishing any app from VS Code, then restart the server tier.

## Expected vs observed

- **Expected:** an aborted call's server work ends or runs out on its own, and `$metadata` and
  `Ping` keep answering (at most after the slow calls finish).
- **Observed (incident):** from the abort on, every OData call hung with no response
  (`SetActive` 25 s, `ClearActive` 15 s, `$metadata` 15 s), no recovery after 40+ minutes, while the
  dev endpoint stayed healthy. Only an NST restart recovered.

The cause (a pool of OData sessions filling with abandoned requests) is a guess, not measured. If
five calls do not do it, raise `--calls` and `--slow-ms`.
