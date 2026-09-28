# 03: Looping test in an OData action, ended with StopSession

> **WARNING.** In the incident the stop did not take and OData stopped answering until
> `Restart-BcContainer`. Use a disposable container. The loop here is bounded by `--max-ms`
> (default 120 s) so a failed stop clears on its own; the incident loop had no bound.

## What it reproduces

Incident record section 3, "A non-terminating AL loop inside a fenced call". Action `StartLoop`
records its own session id, commits, then runs a test method (through the platform test runner)
that spins in a pure CPU loop with no database I/O. From a second connection, action `StopLoop`
calls AL `StopSession(<that session id>)`, as LethAL's `StopHungRunAt` does.

Observed on: Cronus28, BC 28, application 28.4.53241.53758 (DK), 2026-09-26 (the stop failed once;
the same code passed three times before and after). Normal behaviour (stop works, 408) measured on
Cronus281 (BC 28.1), 2026-07-31.

## The app

| Object | Id | Role |
| --- | --- | --- |
| table "NST Repro03 Run" | 91630 | One row: run id, looping session id, bound, `Finished` |
| codeunit "NST Repro03 Tests" | 91631 | `LoopUntilBound`: spins until `MaxMs` has passed |
| codeunit "NST Repro03 API" | 91632 | Web service `NstRepro03`. `StartLoop(runId, maxMs)`, `LoopState()`, `StopLoop(targetSessionId)`, `Ping()` |
| codeunit "NST Repro03 Runner" | 91633 | One-method test suite run, as in 01 |
| codeunit "NST Repro03 Install" | 91634 | Registers the web service |

`StartLoop` sets `Finished` only after the test returns, so `Finished` set means the loop ran to its
own bound: nothing stopped it.

## Steps

1. Compile and publish the app (see [../README.md](../README.md)).
2. `bun client.ts --mode hold`: the looping request stays open while `StopLoop` runs (the path that
   failed on 2026-09-26).
3. `bun client.ts --mode abort`: the client aborts the looping request first, then calls `StopLoop`.

Options: `--budget-ms` (default 20000, when to stop), `--max-ms` (default 120000, the loop's bound).
The client prints the looping session id, the `StopLoop` answer, in hold mode what the held request
received, then waits past the bound and prints `LoopState` (`sessionEnded` is true when `Finished`
is still unset), then the `$metadata`/`Ping` health check.

Optional, by hand while the loop runs: list sessions in the container to see whether the looping
session is still there.

```powershell
Invoke-ScriptInBcContainer -containerName <container> -scriptblock {
  Get-NAVServerSession -ServerInstance BC | Select-Object SessionID, ClientType, LoginDatetime
}
```

## Expected vs observed

- **Expected:** hold mode: the held request ends with HTTP 408, "The server stopped the session (ID:
  n) because of a stop session request. The session was stopped by an AL StopSession call."
  (measured 20098 ms on a 20000 ms budget). Both modes: `Finished` stays unset and OData keeps
  answering.
- **Observed once (2026-09-26):** the session was not stopped and stayed open; afterwards the
  control app's `HarnessInfo` action and the company list timed out until the container was
  restarted. Not reproduced since.

Note: `StopSession` raises no error for a session id that does not exist (measured), so the
`StopLoop` answer alone proves nothing; the 408 and `Finished` are the evidence.
