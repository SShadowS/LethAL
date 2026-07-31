---
name: control-app
description: Rebuild the LethAL Control BC extension and publish it to the target containers. Use after editing anything under extensions/lethal-control, after bumping its app.json version, or when a live gate refuses with "The deployed LethAL Control app reports version X, older than the Y this client requires". Compiles with alc, stages lethal-control.app, then publishes to every container the fixture configs name.
---

# Rebuild and publish LethAL Control

`extensions/lethal-control/lethal-control.app` is **gitignored** — a local build every machine makes
for itself, which no pull refreshes. Editing the AL does not rebuild it, and nothing republishes it
to a container automatically before the harness check runs. So the source, the local `.app`, and
what the container actually runs are three separate things that drift independently.

The symptom is always the same and always late:

```
backend not ready: The deployed LethAL Control app reports version 1.0.0.9, older than the
1.0.0.10 this client requires — your control app predates this client.
```

## Before building: the lockstep

`MIN_CONTROL_VERSION` in `packages/runner/src/harness.ts` must **equal** `app.json`'s `version`. A
test pins it (R28). If you bumped one, bump the other before compiling — a control app built ahead
of the minimum passes; a minimum ahead of the app makes a freshly built app fail its own gate.

Bump the version at all only when the wire surface changed in a way a client can depend on (a new
action, a new field on the marker). It is `MIN_CONTROL_VERSION` that gates, deliberately, rather
than `protocolVersion` — the protocol moves only when an existing wire contract BREAKS, and adding
an action breaks nothing.

## 1. Compile

`alc` lives under the AL VS Code extension. Output goes next to the previous versioned builds, which
are kept as a record:

```bash
ALC=$(ls -d ~/.vscode/extensions/ms-dynamics-smb.al-*/bin/win32/alc.exe | tail -1)
VER=$(python -c "import json,io;print(json.load(io.open('extensions/lethal-control/app.json',encoding='utf-8-sig'))['version'])")
"$ALC" "/project:U:/Git/LethAL/extensions/lethal-control" \
       "/packagecachepath:U:/Git/LethAL/extensions/lethal-control/.alpackages" \
       "/out:U:/Git/LethAL/extensions/lethal-control/LethAL_LethAL Control_${VER}.app"
```

A clean compile prints only the start/end lines. Any diagnostic is a stop — do not publish a build
you have not read the output of.

## 2. Stage it as the local build

The runner and `controlSymbolPath` both read `lethal-control.app`, not the versioned filename:

```bash
cp "extensions/lethal-control/LethAL_LethAL Control_${VER}.app" extensions/lethal-control/lethal-control.app
```

## 3. Publish to every container that matters

**Which containers**: read them from the gitignored fixture configs rather than assuming — the two
fixtures target *different* containers, and a gate against the one you forgot will refuse.

```bash
grep -h '"server"' fixtures/*/lethal.config.local.json
```

Today that is `Cronus281` (sandbox-app: `itest:bcdev`) and `Cronus283` (sandbox-data:
`itest:tables`). Publish to each:

```powershell
$env:DOCKER_CONTEXT='desktop-windows'   # the session default is the LINUX engine; without this
                                        # every command reports the container does not exist
Publish-BcContainerApp -containerName <name> `
  -appFile "U:\Git\LethAL\extensions\lethal-control\LethAL_LethAL Control_<ver>.app" `
  -skipVerification -sync -upgrade
```

`-upgrade` is what makes a version bump land: publishing does not replace, and without it BC refuses
with "tenant already uses a different version of it with the same app ID".

## 4. Verify

Cheapest proof is the gate itself refusing to refuse:

```bash
LETHAL_ITEST_BCDEV=1 bun run itest:bcdev
```

Expect **3 killed / 10 survived / 3 no-coverage**, twice. If it still reports the old version, the
publish went to the wrong container or the wrong context.

## Notes

- Publishing to a container is **outward-facing**: confirm before doing it unless the user has
  already said to build and publish.
- Removal (rare) needs `UnPublish-BcContainerApp` under the Windows Docker context, naming
  `-publisher` AND `-version` once two versions exist.
- If a publish fails with *"already synchronized … different set of tables"*, the tenant kept a
  schema ghost. Unpublish first, THEN `Sync-NAVApp -ServerInstance BC -Name "LethAL Control" -Mode
  Clean -Force` inside the container, then publish. Order matters — cleaning while it is still
  published does nothing.
