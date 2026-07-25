# Custom environment tool support — design

**Date:** 2026-07-26
**Status:** approved, not implemented
**Motivating case:** Continia's `continia.exe` (`U:/Git/CLI`), used to manage Continia BC developer
environments. LethAL must work against those environments without vendoring, importing, or
special-casing that CLI.

## Goal

Let a project point LethAL at an *external tool* that owns its BC environments — creating them,
publishing apps to them, tearing them down — while LethAL keeps owning everything that decides a
verdict. The tool is described entirely in configuration: a path plus command templates. No
tool-specific code ships in LethAL.

## Non-goals

- **Not a new execution backend.** Mutant activation and execution stay on LethAL's fenced
  `RunMutant` OData path (Layer 5C-B1: lease, op marker, in-flight classification). A tool that
  merely runs tests cannot activate a mutant, and activating by republishing costs minutes per
  mutant, which is not a pipeline.
- **Not a Continia integration.** `continia.exe` is the first consumer and the worked example; the
  mechanism knows nothing about it.
- **Not a credential manager.** Secrets come from the environment (optionally via `.env`), never
  from a committed file.

## Architecture

`envTool` is a **provisioner**. It answers "where is the environment, and how do I get an app onto
it?", then hands a resolved connection to the existing `BcDevMcpBackend`, which is unchanged.

```
session start
  1. envId       from config, else run createEnv template  → read envId from its JSON
  2. resolve     run resolve templates                     → baseUrl, username, password
  3. derive      server = origin(baseUrl), serverInstance = first path segment
                 (either may instead be read explicitly via `reads`)
  4. symbols     run downloadSymbols template              → packageCachePath populated
  5. control     run publish template with lethal-control.app
                 HarnessVerifier confirms it answers, exactly as today
per batch
  6. publish     run publish template with the instrumented .app
                 DeploymentVerifier confirms the artifact id that actually landed
per mutant
  7. RunMutant   LethAL's fenced OData call — unchanged code
session end
  8. deleteEnv   only if LethAL created the env, and not under --keep-env
```

The tool is spawned a handful of times per session, never once per mutant, so its latency does not
multiply across the mutant set.

### `odataBaseUrl` is bypassed, not extended

`odataBaseUrl(server, serverInstance)` (`cli.ts`) forces port 7048 — correct for a container,
wrong for `https://host/{envId}`. When `envTool` resolves a `baseUrl`, that string is used verbatim
as `ActivationConfig.baseUrl` and the port-forcing helper is not called. Everything downstream
already treats `baseUrl` as opaque and appends `/ODataV4/…`.

### Derivation of `server` / `serverInstance`

bc-dev-mcp's OnPrem mode wants `server` + `serverInstance`. From a resolved
`baseUrl = https://host/env-4711`: `server = https://host`, `serverInstance = env-4711`. A
`baseUrl` with no path segment throws — LethAL will not guess an instance name. A config may
override either by declaring a `reads` entry for `server` or `serverInstance` directly.

## Coverage: one probe decides the mode

bc-dev-mcp produces the coverage that drives mutant selection. It has never been pointed at a
Continia environment, so **the first implementation task is a live probe**, and its answer picks
the mode:

| probe result | mode | consequence |
|---|---|---|
| bc-dev-mcp connects and returns coverage | `coverage: "procedure"` | full fidelity; identical to a container run |
| it does not | `coverage: "none"` | every mutant runs against all green tests — slower, never wrong |

The fallback is the shape al-runner already has and the shape table-trigger mutants already use
(`coverageFilter`'s all-green fallback), so it costs runtime and no correctness. Build for the
fallback; upgrade if the probe passes.

## Configuration

`envTool` lives in `lethal.config.json` (shape) and `lethal.config.local.json` (per-machine paths).
Secrets live in the environment, loaded from a `.env` file next to the project if one exists; a
real environment variable always wins over a `.env` entry.

```jsonc
{
  "envTool": {
    "toolPath": "U:/Git/CLI/continia.exe",
    "cwd": ".",                                  // optional; default = project dir
    "env": { "CONTINIA_API_TOKEN": "${CONTINIA_API_TOKEN}" },
    "vars": { "profile": "bc28-w1", "envName": "lethal-{runId}" },
    "envId": "${CONTINIA_ENV_ID}",               // optional — absent means "create one"
    "timeoutSeconds": 900,

    "createEnv": {
      "command": ["env", "create", "--name", "{envName}", "--profile", "{profile}", "--json"],
      "reads":   { "envId": "id" }
    },
    "resolve": [
      { "command": ["env", "get", "{envId}", "--json"],   "reads": { "baseUrl": "url" } },
      { "command": ["env", "users", "{envId}", "--json"],
        "reads": { "username": "0.username", "password": "0.password" } }
    ],
    "downloadSymbols": { "command": ["deps", "download", "{envId}", "{projectDir}", "--json"] },
    "publish":         { "command": ["publish", "{envId}", "{appFile}",
                                     "--sync-mode", "ForceSync", "--json"] },
    "deleteEnv":       { "command": ["env", "delete", "{envId}"] }
  }
}
```

```sh
# .env — gitignored
CONTINIA_API_TOKEN=…
CONTINIA_ENV_ID=env-4711        # omit to make every run create and delete its own env
```

### `${VAR}` — environment interpolation

Valid in any config **value**. Resolved from `process.env` after `.env` is loaded. An unset
variable throws at validation time, naming both the variable and the config field that referenced
it.

### `{placeholder}` — argv interpolation

Valid only inside a `command` array element. Closed set, plus the user's own `vars`:

| placeholder | supplied by |
|---|---|
| `{envId}` | config, or `createEnv`'s `reads` |
| `{appFile}` | LethAL — the compiled `.app` for this batch, or `lethal-control.app` |
| `{projectDir}` | LethAL — absolute path to the target project |
| `{testDir}` | LethAL — absolute path to the test project |
| `{packageCache}` | LethAL — directory symbols must land in |
| `{runId}` | LethAL — this session's run id |
| anything else | the `vars` map |

An unknown placeholder, or a `vars` entry nothing references, throws at **validation time** —
before any process is spawned, not twenty minutes into a session.

A `vars` **value** may itself contain LethAL-supplied placeholders (`"envName": "lethal-{runId}"`
in the example); those are resolved first, and a `vars` value referencing another `vars` entry
throws rather than recursing.

### `reads` keys — also a closed set

| key | meaning | required |
|---|---|---|
| `envId` | the environment's id | from `createEnv`, when no config `envId` |
| `baseUrl` | the environment's root URL, used verbatim as `ActivationConfig.baseUrl` | yes |
| `username`, `password` | BC credentials for OData and bc-dev-mcp | yes |
| `server`, `serverInstance` | explicit override of the derivation above | no |
| `expiresUtc` | ISO timestamp; drives the expiry warning | no |

Any other key throws at validation time. A key read more than once (two `resolve` entries both
producing `baseUrl`) also throws — silently letting the last one win is how two clients end up
pointed at different endpoints.

### Which blocks are required

Per run, not globally:

| block | required when |
|---|---|
| `resolve` | always |
| `publish` | always |
| `createEnv`, `deleteEnv` | `envId` is absent |
| `downloadSymbols` | `bcdev.packageCachePath` is absent or empty |

A config that only ever reuses a long-lived environment never has to write a `createEnv` block it
does not use.

## Execution contract

**Spawn.** argv array, never a shell: no quoting rules for the user to get wrong, and no injection
surface from an interpolated value. `toolPath` must exist at validation time. The child process
receives the declared `env` merged over the parent's. `timeoutSeconds` bounds every call.

**Success is exit code 0.** Nothing else is accepted. A tool that reports failure on stdout while
exiting 0 is caught by `reads` — a missing path throws.

**Reading values.** `reads` maps a LethAL key to a dot path; numeric segments index arrays
(`url`, `0.username`, `data.items.0.id`).

| failure | behaviour |
|---|---|
| non-zero exit | throw, with exit code and the last stderr lines |
| timeout | throw; for `publish`, hand to `DeploymentVerifier` (below) |
| stdout is not JSON | throw, with the first bytes of stdout |
| path missing, or wrong type | throw, naming key, path and command |
| resolved value is empty | throw — an empty `baseUrl` or `password` is the empty-vs-empty bug in waiting |

`EnvToolError` extends `Error` **directly**, never `AlcCompileError` — bisection reads only
`AlcCompileError` as "this source subset does not compile", and a broken tool invocation must
never be mistaken for one (project convention, `CLAUDE.md`).

**A failed publish is not a failed deploy.** A non-zero exit or a timeout from the publish command
says nothing about whether the `.app` landed. Publish therefore never retries and never aborts on
its own verdict: `DeploymentVerifier` reads back what the server reports and that answer governs.
This is the existing publish-is-indeterminate design (Layer 5A/5B); the env tool changes the
channel, not the semantics.

**Digest check.** The env-tool publisher verifies the artifact's sha256 before publishing, exactly
as `ContainerDeployer.publish` does — refusing to publish a file that changed after compilation.

**Serialization.** Publishes serialize per `envId`, reusing the existing publish serializer. Two
workers publishing to one environment is the same hazard as two publishing to one container.

**Redaction.** The resolved `password`, and every value sourced from `${…}`, are replaced with
`***` in all error messages, logs and command echoes. LethAL now holds an environment user's
password in memory; it must never reach a transcript.

## Teardown

- `deleteEnv` runs **only** for an environment LethAL created. A config-supplied `envId` is never
  deleted, under any outcome.
- `--keep-env` (a flag on `lethal run`) suppresses deletion, so a failed run can be inspected. It
  is accepted and ignored when `envId` came from config, since nothing would have been deleted
  anyway.
- `--dry-run` never spawns the tool at all: it neither creates nor resolves an environment, because
  it publishes and runs nothing.
- If the session quarantines the tier, the environment is **kept** regardless — deleting it would
  destroy the evidence of what wedged.
- A created `envId` is written to session scratch state *before* anything else runs, so a crash
  between create and delete still lets LethAL print the id and the exact delete command instead of
  silently leaking a paid environment.

## Files

| file | responsibility |
|---|---|
| `packages/runner/src/env-tool.ts` (new) | `EnvToolClient`: config types, validation, template render, spawn, JSON-path read, `EnvToolError`, redaction. No BC or session knowledge. |
| `packages/runner/src/env-tool-session.ts` (new) | Lifecycle: create-or-take `envId`, resolve, symbols, publish control, teardown. Returns a resolved `BcDevConfigSection` + `ActivationConfig`. |
| `packages/runner/src/env-tool-publisher.ts` (new) | Publishes a `CompiledArtifact` through the tool; same contract as `ContainerDeployer.publish`. |
| `packages/runner/src/publisher.ts` (modify) | Extract the publish contract `ContainerDeployer` already satisfies into a small interface, so `BcDevDeployment` can name the interface rather than the class. Rename-scale change. |
| `packages/runner/src/cli.ts` (modify) | `envTool` in `LethalConfigFile`, its validator, `--keep-env`, `.env` loading, teardown in the existing `finally`. |
| `packages/runner/itest/envtool.itest.ts` (new) | Env-gated live gate (below). |

## Testing

**Unit** — a fake spawn driven by call counters, never wall-clock ordering (project convention):

- validation rejects an unknown `{placeholder}`, and a `vars` entry nothing references
- an unset `${VAR}` throws naming variable and field
- each read failure mode throws with key, path and command
- an empty resolved value throws
- secrets are redacted in every error string
- `deleteEnv` fires only for a created env; never for a config-supplied one; never under
  `--keep-env`; never after a quarantine
- publish verifies the digest, and serializes per `envId`

**Live gate** — `itest:envtool`, env-gated (`LETHAL_ITEST_ENVTOOL=1`), skipping cleanly with exit 0
when unset. Runs the existing `sandbox-app` fixture end to end against a real Continia environment,
dumps the per-mutant table before asserting, and freezes a per-mutant baseline
(`envtool.baseline.json`) on first run, exactly like `itest:bcdev` and `itest:tables`.

Expected: **3 killed / 10 survived / 3 no-coverage** if the bc-dev-mcp probe passes;
**3 / 13 / 0** if it does not and coverage falls back to `"none"` — the same numbers al-runner
produces, for the same reason.

## Risks and open questions

1. **bc-dev-mcp against a Continia environment is unproven.** Task 1 is that probe; its result
   selects the coverage mode. Everything else works either way.
2. **`LethAL Control` must publish to a Continia environment and answer OData.** `HarnessVerifier`
   already checks exactly this. If it cannot, the fence is unavailable there and this feature stops
   at "provision and publish" — no mutation runs.
3. **R1 (fenced-path write permissions) applies unchanged.** A test that writes to its own tables
   hits the same permission failure on a Continia environment as on a container. Not worsened by
   this work, not fixed by it.
4. **Environment expiry.** A Continia environment carries `expiresUtc`. A config may declare it as
   an optional `reads` key, and LethAL then warns loudly if the environment expires within the hour
   — a run that outlives its environment must not look like a mutation result. Without that key
   there is no warning, because there is nothing to read.
5. **Cost.** Ephemeral mode creates a real environment per run. Reuse is the default for that
   reason.

## Exit criteria

1. The bc-dev-mcp probe is run and its result recorded, with the coverage mode chosen from it.
2. A run against a config-supplied `envId` completes end to end and produces the expected verdict
   table, frozen in `envtool.baseline.json`.
3. A run with no `envId` creates an environment, completes, and deletes it; the created id is
   visible in scratch state while the run is in flight.
4. `--keep-env` and the quarantine path both demonstrably skip deletion.
5. Every failure mode in the execution-contract table throws with its named fields — proven by unit
   test, not by inspection.
6. No secret appears in any error string, log line or echoed command.
7. No tool-specific code exists in LethAL: the entire Continia integration is the config example in
   this document.
