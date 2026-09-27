# 02: TestPage over a page with triggers, call never returns

> **WARNING.** Running this may hang the call for good and leave the NST service stuck
> `StopPending`. In the incident, `Restart-BcContainerServiceTier` then timed out and only
> `docker restart <container>` recovered. Use a disposable container.

## What it reproduces

Incident record section 2, "TestPage over a page with real triggers: the call never returns, NST
stuck `StopPending`". Same topology as repro 01 (an OData V4 action runs one test method through the
platform test runner), but the test opens a `TestPage` on a list page whose source table has
`OnInsert`/`OnModify` triggers, a field `OnValidate` trigger and a FlowField, and a page extension
whose `OnOpenPage` inserts a row in another table and modifies a source row. The control test opens
a code-free list page the same way.

Observed on: Cronus283, BC 28 (build not recorded), 2026-07-31 and 2026-08-01. Code-free control:
Cronus281, 2026-07-31.

## The app

| Object | Id | Role |
| --- | --- | --- |
| table "NST Repro02 Main" | 91610 | Triggers and FlowField |
| table "NST Repro02 Related" | 91611 | No triggers |
| page "NST Repro02 Main List" | 91612 | List on Main, shows the FlowField |
| pageextension "NST Repro02 Main List Ext" | 91613 | `OnOpenPage` inserts into Related, modifies Main |
| page "NST Repro02 Plain List" | 91614 | Code-free control page on Related |
| codeunit "NST Repro02 Tests" | 91615 | `OpenTriggerPage`, `OpenPlainPage` (each: seed a row, `OpenView()`, `Close()`) |
| codeunit "NST Repro02 Runner" | 91616 | One-method test suite run, as in 01 |
| codeunit "NST Repro02 API" | 91617 | Web service `NstRepro02`. `RunTest(testMethod)`, `Ping()` |
| codeunit "NST Repro02 Install" | 91618 | Registers the web service |

## Steps

1. Compile and publish the app (see [../README.md](../README.md)).
2. Control: `bun client.ts --test OpenPlainPage`. Expected to return quickly with `runOk: true` and
   a test failure carrying `NotSupportedException` at `NavSession.CreateNavTestService()`.
3. The arm: `bun client.ts --test OpenTriggerPage` (client timeout `--timeout-ms`, default 600000).
   The client reports whether the call returned, then checks `$metadata` and `Ping`.
4. Record the NST service state by hand:

   ```powershell
   Invoke-ScriptInBcContainer -containerName <container> -scriptblock {
     Get-Service 'MicrosoftDynamicsNavServer$BC' | Select-Object Name, Status
   }
   ```

5. If the state is `StopPending`, try `Restart-BcContainerServiceTier -containerName <container>`
   and note whether it times out, then `docker restart <container>`.

## Expected vs observed

- **Expected:** both tests end quickly with the same `NotSupportedException` (TestPage is not
  supported in this session), and the server stays healthy.
- **Observed (incident):** the code-free page was refused in 87 ms. The page with triggers never
  returned (3 measured hangs). After one of them the NST service was stuck `StopPending` and
  `Restart-BcContainerServiceTier` failed with "Time out has expired and the operation has not been
  completed"; `docker restart` recovered in 30 s. In the other runs the service stayed `Running`.

Which ingredient causes the hang (triggers, FlowField, or the writing `OnOpenPage`) is not known.
To narrow it, remove them one at a time from this app.
