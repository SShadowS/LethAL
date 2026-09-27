# 01: TestPage test in an OData action, truncated reply

> **WARNING.** Running this may leave the OData endpoint unresponsive until the container is
> restarted (`Restart-BcContainer`). Use a disposable container.

## What it reproduces

Incident record section 1, "TestPage baseline call: truncated reply, sometimes followed by an OData
wedge". An OData V4 action runs one test method through the platform test runner. The test opens a
`TestPage` on a card page, invokes an action, reads a field and closes it. In an OData session the
platform refuses TestPage (`System.NotSupportedException: Specified method is not supported. at
Microsoft.Dynamics.Nav.Runtime.NavSession.CreateNavTestService()`), the test runner records the
failure with its CLR callstack, and the action returns it in a JSON answer of about 6.6 KB.

Observed on: BC 28, application 28.4.53241.53758 (DK) on Cronus28 and Cronus284; also Cronus285
(build not recorded). 26 lost replies from 2026-09-18 to 2026-09-27, 4 of them followed by a wedge.

## The app

| Object | Id | Role |
| --- | --- | --- |
| codeunit "NST Repro01 API" | 91600 | Web service `NstRepro01`. `RunTest(testMethod, padTo)`, `Ping()` |
| codeunit "NST Repro01 Runner" | 91601 | Builds a one-method test suite, `Test Suite Mgt.RunAllTests`, `TestResultsToJSON`; called through `if Runner.Run()` |
| page "NST Repro01 Card" | 91602 | Card page, no source table, one action `Compute` |
| codeunit "NST Repro01 Tests" | 91603 | `OpenCardPage` (the TestPage arm), `Passes` (control and warm-up) |
| codeunit "NST Repro01 Install" | 91604 | Registers the web service |

`padTo` pads the answer with a `pad` field up to about that many characters. The control arm runs
the passing test padded to the same size, so answer size and "opens a TestPage" can be told apart.
In the incident they always varied together.

## Steps

1. Compile and publish the app (see [../README.md](../README.md)).
2. Control arm first: `bun client.ts --arm control --sessions 10`
3. TestPage arm: `bun client.ts --arm testpage --sessions 10` (the incident needed 10 to 60 sessions
   on some containers; raise `--sessions` if nothing happens).
4. Compare `bodyBytes` of the two arms' complete answers; adjust `--pad-to` (default 6600) so the
   control answer is the same size as the TestPage answer.

Each session opens a new keep-alive socket, sends `--warmup` (default 21) short passing calls on it,
then the arm call, with a `--timeout-ms` (default 120000) limit. The arm call is read from a raw TCP
socket, so each line reports `headersMs`, `status`, `transferEncoding`, `bodyBytes` (decoded chunk
data), `wireBytes`, `terminatorSeen` (the final `0\r\n\r\n` chunk arrived), `ending` (`complete`,
`timeout`, `socket-close`, `socket-error`) and the last 120 characters received. After each session
it checks `$metadata` and `Ping`; if either fails it prints `WEDGE` and stops (`--stop-on-wedge 0`
keeps going).

## Expected vs observed

- **Expected:** every call returns HTTP 200 with a complete body and chunked terminator; `$metadata`
  and `Ping` keep answering.
- **Observed (incident):** on some calls the headers arrive late (606 ms or more; clean answers took
  at most 543 ms), then the body stops 1 to 116 bytes short of the end: `terminatorSeen: false`, and
  either the client times out at 120 s or the socket is closed about 27 to 31 s after the request.
  In 7 of 8 measured hits the server had finished the AL work; only delivery failed. Afterwards the
  OData endpoint sometimes stops answering until the container is restarted. One hit logged
  Application event Id 705, "Request was throttled. It either timed-out or was cancelled."

Not yet run against a container in this standalone form: the rate on a given container is unknown
(it differed from 6 of 7 sessions to 6 of 60 between two containers in the incident).
