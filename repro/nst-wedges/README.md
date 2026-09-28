# Business Central server tier wedges: standalone reproductions

Four small repros of the server tier (NST) failures recorded in
[`docs/measurements/2026-09-27-nst-wedge-incidents.md`](../../docs/measurements/2026-09-27-nst-wedge-incidents.md).
None of them uses LethAL. Each is a minimal AL extension that depends only on Microsoft's
"Test Runner" app (04 depends on nothing), plus a small Bun/TypeScript client that calls it over the
standard OData V4 endpoint the way LethAL's control app is called: an unbound action on a codeunit
published as a web service, `POST <base>/ODataV4/<Service>_<Action>?company=...&tenant=...`, basic
auth.

> **WARNING.** These repros are built to trigger server tier faults. Running any of them may leave
> the OData endpoint unresponsive or the NST service stuck, and recovery may need
> `Restart-BcContainer` or `docker restart <container>`. Use a disposable container that nobody else
> is using.

| Folder | Incident section | What it does |
| --- | --- | --- |
| [`01-testpage-truncated-reply`](01-testpage-truncated-reply/) | 1 | A test that opens a TestPage, run inside an OData action; the ~6.6 KB answer sometimes arrives without its last bytes, and OData may then stop answering. Has a same-size passing control arm. |
| [`02-testpage-trigger-hang`](02-testpage-trigger-hang/) | 2 | A TestPage over a list page with triggers, a FlowField and a writing page extension; the call never returns and the NST can get stuck `StopPending`. Has a code-free page control. |
| [`03-infinite-loop-stopsession`](03-infinite-loop-stopsession/) | 3 | An action runs a test that loops; a second call ends it with `StopSession`. Checks whether the session ends and OData stays healthy. |
| [`04-odata-after-client-abort`](04-odata-after-client-abort/) | 4 | Several slow calls aborted by the client, then `$metadata` and a trivial action. |

## Shared setup

**Target.** A BC 28 on-premises Docker container (the incidents were on BC 28, application
28.4.53241.53758 DK for Cronus28/Cronus284; see each README). The apps use `runtime` 17.0 and
`platform` 28.0.0.0. Repros 01 to 03 need Microsoft's "Test Runner" app installed (it is part of the
test toolkit, `-includeTestToolkit` in BcContainerHelper). Object ids are 91600 to 91649.

**Compile.** With `alc.exe` from the AL Language extension, and a symbol folder holding `System`,
`System Application` and `Test Runner` for BC 28 (in this repository,
`fixtures/sandbox-data-tests/.alpackages` has them; otherwise use "AL: Download Symbols"):

```bash
alc.exe /project:<repro folder> /packagecachepath:<symbol folder> /out:<repro folder>/repro.app
```

**Publish.** From PowerShell with BcContainerHelper:

```powershell
Publish-BcContainerApp -containerName <container> -appFile <repro folder>\repro.app -skipVerification -sync -install
```

(Or publish from VS Code / `altool publishapp` against the dev endpoint, port 7049.) On install, an
install codeunit registers the API codeunit as a web service named `NstRepro0<n>` in every company.
If that did not happen (for example on an upgrade publish), add it by hand on the **Web Services**
page: Object Type `Codeunit`, Object ID from the table in each README, Service Name `NstRepro0<n>`,
Published.

**Run the client.** Needs [Bun](https://bun.sh). Settings come from the environment, never from a
file in this folder:

```bash
export BC_URL=http://<container>:7048/BC     # server tier base URL, OData on port 7048
export BC_USER=<user> BC_PASSWORD=<password>  # NavUserPassword / basic auth
export BC_COMPANY="CRONUS Danmark A/S"        # default
bun <repro folder>/client.ts [options]
```

Every client prints one JSON line per event. `common.ts` holds the shared settings and the health
check (`GET $metadata` and the app's `Ping` action, 30 s each).

**Clean up.** `UnPublish-BcContainerApp -containerName <container> -name "<app name>" -unInstall -doNotSaveData`.

## Recovery if a repro wedges the server

```powershell
Restart-BcContainer -containerName <container>
# if the NST service is stuck StopPending and the restart times out (incident section 2):
docker restart <container>
```
