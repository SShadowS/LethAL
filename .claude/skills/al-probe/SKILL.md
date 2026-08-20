---
name: al-probe
description: Scaffold, publish and run a throwaway AL probe app against a LethAL BC container to MEASURE real Business Central behaviour instead of reasoning about it. Use when a claim about what BC actually does is load-bearing — before writing it into a spec, a comment, a roadmap row or a verdict rule. Knows this repo's id ranges, the schema-ghost publish order, and why StartSession is unavailable.
---

# Measure BC, don't reason about it

LethAL's AL has **no unit-test harness**. `alc` proves it compiles; nothing proves what BC *does*.
When a behavioural claim is about to become load-bearing — a verdict rule, a spec section, a
roadmap row — measure it.

The generic `bc-measure` skill covers experiment design (controls, disjoint row ranges, cache
confounds, reading `SqlStatementsExecuted`). **Read it for the method.** This skill exists because
that one does not know LethAL, and three of its landmines cost real time here.

## The three landmines, and how to avoid them

### 1. Id range 91000–91099 is TAKEN

`LethAL Control` owns it. A probe scaffolded from the generic template (91000–91010) fails at
publish, not at compile:

```
The application object of type 'Table' with the ID '91000' is defined in multiple apps.
The apps are: <probe>; LethAL Control by LethAL 1.0.0.x
```

**Use 91500+.** Set it in `app.json` `idRanges` *and* on every object.

### 2. The schema ghost, and the order that clears it

Adding or removing a probe TABLE between publishes gives:

```
Cannot synchronize the extension ... it is already synchronized. Furthermore, the provided
extension has a different set of tables and table extensions than the synchronized extension.
```

Unpublishing does **not** clear it — the tenant keeps the schema in `Synced` / `IsInstalled False`
and the next publish compares against that ghost. The cure is `Sync-NAVApp -Mode Clean`, and the
**order matters**: it must run while the app is UNPUBLISHED. Cleaning first, then publishing (which
unpublishes and republishes) leaves the ghost intact.

```powershell
$env:DOCKER_CONTEXT='desktop-windows'
# unpublish first (or let deploy-probe.ps1's unpublish step fail once), THEN:
Invoke-ScriptInBcContainer -containerName <name> -scriptblock {
  Sync-NAVApp -ServerInstance BC -Name "<probe name>" -Mode Clean -Force
}
# now publish
```

### 3. `StartSession` is unavailable, and it is the wrong tool anyway

A `[Test]` method calling `StartSession` fails:

```
Sessions can only be started in tests that are run by a TestRunner that has TestIsolation
set to Disabled.
```

The platform runner does not give you that. **But it would also measure the wrong thing**: LethAL's
sessions are OData **web-service** sessions, so if the question involves session behaviour, the
probe must reproduce that topology — register the probe codeunit as a web service and drive it over
`/ODataV4/<Service>_<Procedure>` from PowerShell, exactly as the runner does.

Register it the way the control app does (`extensions/lethal-control/src/Install.Codeunit.al`):

```al
codeunit 91504 "<Probe> Install"
{
    Subtype = Install;
    trigger OnInstallAppPerCompany()
    var Tws: Record "Tenant Web Service";
    begin
        if Tws.Get(Tws."Object Type"::Codeunit, '<ServiceName>') then exit;
        Tws.Init();
        Tws."Object Type" := Tws."Object Type"::Codeunit;
        Tws."Object ID" := Codeunit::"<Probe> API";
        Tws."Service Name" := '<ServiceName>';
        Tws.Published := true;
        Tws.Insert(true);
    end;
}
```

Then drive it with Basic auth against `http://<container>:7048/BC/ODataV4/<ServiceName>_<Proc>?company=...&tenant=default`.
Credentials are in the gitignored `fixtures/*/lethal.config.local.json` (`bcdev.env`).

## Working example

`scripts/r53-probe/` is a complete, re-runnable one: probe app + `drive.ps1` + a README recording
what was measured. It answered whether a second session can end one hung in an AL loop. Copy its
shape.

## Two rules that are not optional

**Bound every loop.** A probe that hangs forever wedges a container that other gates need. R53's
probe bounded its hang at 90 s precisely so a NEGATIVE result could not take the container down.

**Carry results out through `Error()`** — a passing test reports nothing useful:

```al
Error('MEASURED a=%1 b=%2 c=%3', A, B, C);
```

The test shows as `failed`. That is expected and is how the data travels; say so when reporting, so
a red test is not mistaken for a broken experiment.

## Verifying names before you compile

Virtual tables are easy to get wrong and the compiler error is unhelpful (`AL0118: The name
'"Session ID"' does not exist`). `Session` (2000000009) is the legacy table with no session id; the
one you want is **`Active Session`** (2000000110). Read the real shape out of the symbols rather
than guessing:

```bash
python - <<'PY'
import zipfile, io, json
p = "U:/Git/al-perf-bc/.alpackages/Microsoft_System_28.0.47067.0.app"
data = open(p, "rb").read()
z = zipfile.ZipFile(io.BytesIO(data[data.find(b"PK\x03\x04"):]))
sym = json.loads(z.read("SymbolReference.json").decode("utf-8-sig"))
def walk(ns):
    for t in ns.get("Tables") or []: yield t
    for c in ns.get("Namespaces") or []: yield from walk(c)
for t in walk(sym):
    if "session" in (t.get("Name") or "").lower():
        print(t["Name"], t.get("Id"), [f.get("Name") for f in t.get("Fields", [])])
PY
```

(`.app` files carry a header before the zip payload — hence the `PK\x03\x04` seek.)

## Finish the job

**Unpublish the probe** when done — a stray test extension on a shared container is someone else's
confusing afternoon. **Keep the source** in `scripts/<name>-probe/` with a README stating what was
measured, on which container and BC version. A measurement nobody can re-run is barely better than
a guess, and the next question in the same area reuses the scaffold.
