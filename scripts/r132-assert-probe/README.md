# R132 assert probe — what does a Library Assert failure say, and can a fixture depend on it here?

**Answers: it begins with `Assert.`, and yes.** Measured 2026-08-14 against **Cronus283** via the
`bc-dev` MCP tool's `bcdev_test_run`:

```
MEASURED AreEqual text: Assert.AreEqual failed. Expected:<1> (Integer). Actual:<2> (Integer). probe message.
MEASURED IsTrue text:   Assert.IsTrue failed. probe message
```

Both begin with `Assert.`, which is exactly what `looksLikeAssertionFailure`
(`packages/runner/src/assertion-screen.ts`) tests for, so a kill produced by one of these is NOT
flagged by R121's screen, while a kill produced by a bare `Error(...)` is.

## Why this exists

R132 says no live gate ever exercises the assertion screen in the mode where it discriminates
(`partial`): every LethAL fixture raises through bare `Error(...)`, so on every gate the screen flags
every kill and reports `vacuous`. Growing a fixture an `Assert.*` arm is the cheap way to make one
gate produce `partial` — but only if two things hold, and both are measurable rather than arguable:

1. **A dependency on Microsoft's `Library Assert` compiles and publishes here.** Its symbols are
   obtainable from the container itself; the probe compiled against them with `alc 18.0.38.8509` and
   published to Cronus283 with no schema or dependency complaints.
2. **The failure text really starts with `Assert.` on THIS BC build.** The AL source declares
   `Assert.AreEqual failed. Expected:<%1> (%2). Actual:<%3> (%4). %5` with `Locked = true`, so it
   should not localise — but a fixture arm built on "should not" would report `vacuous` after a full
   gate run instead of the `partial` it was built for.

Availability, checked the same day with `Get-BcContainerAppInfo -tenantSpecificProperties`: `Library
Assert` 28.0.46665.49944 is installed **Global** on **both** Cronus283 (the table fixture's
container) and Cronus281 (sandbox-app's), alongside `Test Runner`, `Any`, `Library Variable Storage`
and `System Application Test Library`. So the dependency costs a symbol file in `.alpackages` and an
`app.json` entry, not a toolkit install.

## The probe

`codeunit 71531 "R132 Assert Probe Tests"`, namespace `LethAL.R132`, `using
System.TestLibraries.Utilities` (BC 26+ puts `Library Assert` in a namespace). Two `[Test]` methods,
each calling a deliberately failing assertion inside a `[TryFunction]` and reporting
`GetLastErrorText()` through `Error()`. Both are EXPECTED to report `failed` — that is how the text
travels out.

Symbols were downloaded straight from the container rather than from a marketplace copy:

```bash
curl -u <user>:<pass> -o ".alpackages/Microsoft_Library Assert_28.0.46665.49944.app" \
  "http://Cronus283:7049/BC/dev/packages?publisher=Microsoft&appName=Library%20Assert&versionText=&tenant=default"
```

## What this settles, and what it does not

It settles that the `partial` branch is REACHABLE by a fixture on these containers, and what the text
looks like. It settles nothing about the rule's PRECISION — that number (26.1% on the 73-kill
Document Output corpus) comes from a hand-classified corpus, and a fixture built to produce `partial`
is a pipeline proof, not evidence about how well the rule separates real kills from false ones. R132
is explicit that confusing the two is the mistake it exists to prevent.

## Reproducing

Compile with `alc` against `.alpackages` (see above), publish with `Publish-BcContainerApp
-useDevEndpoint -syncMode ForceSync -install`, run codeunit 71531 through `bcdev_test_run`, then:

```powershell
$env:DOCKER_CONTEXT='desktop-windows'
UnPublish-BcContainerApp -containerName Cronus283 -name 'LethAL R132 Assert Probe' -unInstall -doNotSaveData -force
```

(Done on 2026-08-14 after the measurement above.)
