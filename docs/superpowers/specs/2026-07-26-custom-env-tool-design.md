# Custom environment tool support — design

**Date:** 2026-07-26
**Status:** approved (revised after review round 1 — `fable`, SHIP-WITH-FIXES; all findings folded in)
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
it?", then hands a resolved connection to `BcDevMcpBackend`.

```
session start
  1. envId       from config, else run createEnv template  → read envId from its JSON
  2. resolve     run resolve templates                     → baseUrl, username, password, …
  3. derive      server = origin(baseUrl), serverInstance = first path segment
                 (either may instead be read explicitly via `reads`)
  4. symbols     run downloadSymbols template              → packageCachePath populated
  5. prepublish  run publish template once per entry in `publishApps`
                 (the test app and its dependencies — see "The test app problem")
  6. control     HarnessVerifier first; publish lethal-control.app ONLY if it does not
                 already answer, then verify again
per batch
  7. publish     run publish template with the instrumented .app
                 DeploymentVerifier confirms the artifact id that actually landed
per mutant
  8. RunMutant   LethAL's fenced OData call — unchanged code
session end
  9. deleteEnv   only if LethAL created the env, and not under --keep-env
```

The tool is spawned a handful of times per session, never once per mutant, so its latency does not
multiply across the mutant set.

**Step 6 verifies before publishing, deliberately.** The machine-global lease lives in
`LethAL Control`'s own tables, and a republish runs its install/upgrade codeunits. Unconditionally
republishing at session start would let a second session disturb the lease and `serverGeneration`
state of a session already running against a shared long-lived environment. Verify → publish only
if absent or broken → verify again.

**Resolution happens exactly once per process.** `cli.ts` today calls `validateBcDevConfig`
independently in `buildBackend`, `leaseSessionFor` and `resourceIdentityFor`. A naive port would
resolve — and in create-mode, *provision an environment* — three times. The env-tool session runs
once, before any of them, and its resolved output feeds all three seams.

### `odataBaseUrl` is bypassed, not extended

`odataBaseUrl(server, serverInstance)` (`cli.ts:346`) forces port 7048 — correct for a container,
wrong for `https://host/{envId}`. When `envTool` resolves a `baseUrl`, that string is used verbatim
as `ActivationConfig.baseUrl` and the port-forcing helper is not called. Both OData clients treat
`baseUrl` as opaque and append `/ODataV4/…` (`activation.ts:44`, `run-mutant-transport.ts:78`).

### Derivation of `server` / `serverInstance`

bc-dev-mcp's OnPrem mode wants `server` + `serverInstance`. From a resolved
`baseUrl = https://host/env-4711`: `server = https://host`, `serverInstance = env-4711`. A
`baseUrl` with no path segment throws — LethAL will not guess an instance name. A config may
override either by declaring a `reads` entry for `server` or `serverInstance` directly.

## The resolved connection, field by field

`env-tool-session` produces a complete `BcDevConfigSection` plus an `ActivationConfig`. Every field
has exactly one source, and **declaring a field in both `envTool.reads` and the `bcdev` section is
a validation error** — not a precedence rule. Two sources for one value is how two clients end up
pointed at different endpoints.

| field | source | notes |
|---|---|---|
| `baseUrl` (`ActivationConfig`) | `reads` | used verbatim; never passed through `odataBaseUrl` |
| `server`, `serverInstance` | derived from `baseUrl`, or `reads` | derivation throws on a path-less URL |
| `username`, `password` | `reads` | also fed to bc-dev-mcp as `BC_DEV_USER` / `BC_DEV_PASSWORD` |
| `company` | `bcdev` section | the tool does not know it; every OData URL carries `?company=` (`activation.ts:5`) |
| `tenant` | `bcdev` section, no default | raw OData Basic auth 401s without it even on a single-tenant server (`activation.ts:10`). `continia.exe` hardcodes `tenant=default` when it publishes, so `"default"` is the expected value for Continia environments — but LethAL will not invent it |
| `packageCachePath` | `bcdev` section, else `<projectDir>/.alpackages` when `downloadSymbols` runs | see below |
| `controlSymbolPath` | `bcdev` section | path to the compiled `lethal-control.app` on this machine |
| `mcpCommand` | `bcdev` section | **required only in `coverage: "procedure"` mode** (see below) |

## Coverage: one probe decides the mode, and the mode is an explicit delta

bc-dev-mcp produces the coverage that drives mutant selection. It has never been pointed at a
Continia environment, so **the first implementation task is a live probe**, and its answer picks
the mode:

| probe result | mode | consequence |
|---|---|---|
| bc-dev-mcp connects and returns coverage | `coverage: "procedure"` | full fidelity; identical to a container run |
| it does not | `coverage: "none"` | every mutant runs against all green tests — slower, never wrong |

**The fallback is not free, and the earlier claim that the backend is "unchanged" was wrong.**
`BcDevMcpBackend` hardcodes `coverage: "procedure"` (`bcdev-backend.ts:149`), and `status()` goes
through bc-dev-mcp (`bcdev-backend.ts:206`) while `runSession` hard-gates on `status()` being ok
(`orchestrator.ts:1419`). If bc-dev-mcp cannot reach a Continia environment, the session would
abort at the readiness probe before any fenced call. Fallback mode therefore requires three small,
named changes:

1. **Coverage mode becomes a constructor input** rather than a literal, defaulting to
   `"procedure"` so existing callers are untouched.
2. **`status()` in `"none"` mode probes via `HarnessVerifier`** (an OData call to the already-
   required control app) instead of bc-dev-mcp.
3. **`mcpCommand` is optional in `"none"` mode.** Nothing would ever call it: baseline and mutant
   runs both go through `RunMutantTransport`, and test discovery is static from source
   (`discovery.ts:9`).

Everything downstream already anticipates an authoritative coverage-`"none"` backend — the
orchestrator threads `resyncSessionOpSeq` for exactly that case (`orchestrator.ts:1502`). The
fallback is plumbed everywhere except the backend's own capability and status surface.

The fallback's verdict semantics are honest: per-mutant execution is `coverage: "none"` through the
fenced transport in **both** modes (`orchestrator.ts:2272`, `:2392`); the mode changes only
baseline routing and selection, taking the branch al-runner already takes
(`orchestrator.ts:1828`). A mutant that would have been `no-coverage` becomes `survived` only after
every green test has actually run against it — a measured result, not the unmeasured widening
`selection.ts:180` refuses.

## The test app problem

LethAL's documented contract is that the test app is already on the server: "publishing the test
app is the user's own workflow, not LethAL's job" (`fixtures/README.md`). That holds for a
long-lived environment. It is **impossible** for an environment that did not exist until LethAL
created it — a fresh Continia environment from a BC profile contains no user test app, so a
create-mode run would discover tests from source and then fail every one of them at execution.

Therefore: **`publishApps`** — an optional ordered list of pre-built `.app` paths, published
through the same `publish` template at session start (step 5), before the control app.

- **Create-mode requires it.** A config with no `envId` and no `publishApps` is a validation error
  naming the reason: nothing would put the tests on the new environment.
- **Reuse-mode ignores it if absent** — the existing "you published your test app yourself"
  workflow is unchanged.
- Entries publish in declared order, so a test app's dependencies can precede it.

## Configuration

`envTool` lives in the config file passed to `--config` (`lethal.config.json`, or a gitignored
per-machine file — the existing convention: `loadLethalConfigFile` reads exactly one file, and the
itests pass their `.local.json` *as* the config). **No two-file merge is introduced.**

Secrets live in the environment, loaded from a `.env` file next to the project if one exists; a
real environment variable always wins over a `.env` entry.

```jsonc
{
  "bcdev": {
    "company": "CRONUS Danmark A/S",
    "tenant": "default",
    "controlSymbolPath": "U:/Git/LethAL/extensions/lethal-control/lethal-control.app"
    // no server/serverInstance/username/password — envTool resolves those
  },
  "envTool": {
    "toolPath": "U:/Git/CLI/continia.exe",
    "cwd": ".",                                  // optional; default = project dir
    "env": { "CONTINIA_API_TOKEN": "${CONTINIA_API_TOKEN}" },
    "vars": { "profile": "bc28-w1", "envName": "lethal-{runId}" },
    "envId": "${CONTINIA_ENV_ID}",               // optional — absent means "create one"
    "timeoutSeconds": 900,
    "publishApps": ["U:/Git/LethAL/fixtures/sandbox-tests/out/tests.app"],

    "createEnv": {
      "command": ["env", "create", "--name", "{envName}", "--profile", "{profile}", "--json"],
      "reads":   { "envId": "id" }
    },
    "resolve": [
      { "command": ["env", "get", "{envId}", "--json"],
        "reads": { "baseUrl": "url", "expiresUtc": "expiresUtc" } },
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
| `{appFile}` | LethAL — the batch's instrumented `.app`, a `publishApps` entry, or `lethal-control.app` |
| `{projectDir}` | LethAL — absolute path to the target project |
| `{testDir}` | LethAL — absolute path to the test project |
| `{packageCache}` | LethAL — the resolved `packageCachePath` (see below) |
| `{runId}` | LethAL — this session's run id |
| anything else | the `vars` map |

Validation-time errors, all before any process is spawned:

- an unknown placeholder
- a `vars` entry nothing references — checked across **all declared blocks**, not only the blocks
  this particular run needs, so a typo in an unused block still surfaces
- a `vars` key shadowing a LethAL-supplied placeholder name
- a `vars` value referencing another `vars` entry (LethAL-supplied placeholders inside a `vars`
  value are fine and resolve first: `"envName": "lethal-{runId}"`)

### `reads` — a closed set too

| key | meaning | required |
|---|---|---|
| `envId` | the environment's id | from `createEnv`, when no config `envId` |
| `baseUrl` | the environment's root URL, used verbatim as `ActivationConfig.baseUrl` | yes |
| `username`, `password` | BC credentials for OData and bc-dev-mcp | yes |
| `server`, `serverInstance` | explicit override of the derivation above | no |
| `expiresUtc` | ISO timestamp; drives the expiry refusal | no |

Any other key throws at validation time. So does the same key being produced by two blocks —
silently letting the last one win is the same "two sources, one value" hazard as above.

`reads` may be **omitted entirely** on a block whose output LethAL does not need (`deleteEnv`, or a
warm-up step such as `env start`). Omitted means "run it, require exit 0, parse nothing".

### `packageCachePath`

If `bcdev.packageCachePath` is set, it is used and `downloadSymbols` is optional. If it is absent,
`downloadSymbols` is required and `packageCachePath` resolves to `<projectDir>/.alpackages` — which
is where `continia deps download` puts symbols, and what `{packageCache}` expands to. `ArtifactCompiler`
needs a concrete path at construction (`cli.ts:441`), so this is resolved before the backend is built.

### Which blocks are required

Per run, not globally:

| block | required when |
|---|---|
| `resolve` | always |
| `publish` | always |
| `createEnv`, `deleteEnv` | `envId` is absent |
| `publishApps` | `envId` is absent (see "The test app problem") |
| `downloadSymbols` | `bcdev.packageCachePath` is absent |

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
| timeout | throw; for `publish`, the deploy outcome is decided as below |
| stdout is not JSON | throw — **stdout is echoed only when the block's `reads` contain no credential key** (see redaction) |
| path missing, or wrong type | throw, naming key, path and command |
| resolved value is empty | throw — an empty `baseUrl` or `password` is the empty-vs-empty bug in waiting |

`EnvToolError` extends `Error` **directly**, never `AlcCompileError` — bisection aborts on anything
that is not `AlcCompileError` (`orchestrator.ts:1686`), and a broken tool invocation must never be
mistaken for "this source subset does not compile".

**A failed publish is indeterminate, and indeterminate aborts.** A non-zero exit or timeout from
the publish command says nothing about whether the `.app` landed, so publish never retries on its
own. `DeploymentVerifier` reads back what the server reports, and `decidePublishOutcome`
(`deployment-verifier.ts:49`) governs: publish-failed together with verify-accepted is
**`anomalous`, which aborts** — it is not "the verifier says it landed, carry on". The env tool
changes the publish channel; it changes no deploy semantics.

**Version-conflict recovery needs BC's own message.** The orchestrator's one-shot recovery parses
BC's rejection text out of the publish error (`orchestrator.ts:1650`). Through an external tool
that text survives only if the tool relays it. `continia.exe` does — it parses `Message` out of the
dev-endpoint response and surfaces it. For a tool that does not, the conflict aborts loudly instead
of self-healing; LethAL never guesses that an unrecognised failure was a version conflict.

**Digest check.** The env-tool publisher verifies the artifact's sha256 before publishing, exactly
as `ContainerDeployer.publish` does (`publisher.ts:84`). `lethal-control.app` and `publishApps`
entries have no `CompiledArtifact` record, so they publish through a hash-at-read variant: the
digest is computed and logged, not compared against an expectation that does not exist.

**Serialization.** Publishes serialize per `envId`, reusing `serializePublish`. Two workers
publishing to one environment is the same hazard as two publishing to one container, and the
in-process-only scope is inherited honestly: cross-process safety remains the server-side lease,
which lives in the environment.

**Redaction.** The resolved `password`, and every value sourced from `${…}`, are replaced with
`***` in all error messages, logs and echoed commands. Additionally — and this is not covered by
value-based redaction — **a block whose `reads` include `username` or `password` never has its raw
stdout echoed anywhere**, because a parse failure would otherwise print credentials that were never
successfully read as values. `continia env users --json` returns plaintext passwords; its own help
text warns about it.

## Teardown

- `deleteEnv` runs **only** for an environment LethAL created. A config-supplied `envId` is never
  deleted, under any outcome.
- `--keep-env` (a flag on `lethal run`) suppresses deletion. Accepted and ignored when `envId` came
  from config, since nothing would have been deleted anyway.
- If the session quarantines the tier, the environment is **kept** regardless — deleting it would
  destroy the evidence of what wedged.
- A `deleteEnv` that fails is logged with the manual delete command and **never changes the session
  report or exit code**. The verdicts are the product; cleanup is not.
- `--dry-run` never spawns the tool at all: it neither creates nor resolves an environment, because
  it publishes and runs nothing.

**Crash safety.** A created `envId` is written to `~/.lethal/env-state/<runId>.json` *before*
anything else runs — a stable location, not session scratch, because a crashed process cannot print
and a `mkdtemp` directory cannot be found afterwards. The file records the envId, the resolved
`deleteEnv` argv, and the start time. A later `lethal run` prints a warning naming every stale entry
it finds; removal is manual and deliberate, since LethAL cannot know whether another session owns it.

## Expiry: refuse, do not warn

A Continia environment carries `expiresUtc`. If a config declares that `reads` key and the
environment expires within the hour, LethAL **refuses to start** unless overridden by a flag. An
environment that expires mid-run does not merely fail: the in-flight call becomes
`in-flight-unknown` and durably quarantines the tier key, which then needs an operator
`clear-quarantine`. Refusing costs a re-run; not refusing costs a manual recovery.

## Files

| file | responsibility |
|---|---|
| `packages/runner/src/env-tool.ts` (new) | `EnvToolClient`: config types, validation, template render, spawn, JSON-path read, `EnvToolError`, redaction. No BC or session knowledge. |
| `packages/runner/src/env-tool-session.ts` (new) | Lifecycle: create-or-take `envId`, resolve, symbols, prepublish, control verify/publish, teardown, crash-state file. Returns a resolved `BcDevConfigSection` + `ActivationConfig`, once per process. |
| `packages/runner/src/env-tool-publisher.ts` (new) | Publishes through the tool; same contract as `ContainerDeployer.publish`, plus the hash-at-read variant for control/prepublish apps. |
| `packages/runner/src/publisher.ts` (modify) | Extract the publish contract `ContainerDeployer` already satisfies into an interface, so `BcDevDeployment` names the interface rather than the class. Rename-scale change. |
| `packages/runner/src/bcdev-backend.ts` (modify) | Coverage mode as a constructor input (default `"procedure"`); `status()` via `HarnessVerifier` in `"none"` mode; `mcpCommand` optional there. |
| `packages/runner/src/cli.ts` (modify) | `envTool` in `LethalConfigFile`, its validator, `--keep-env`, `.env` loading, single resolution feeding `buildBackend` / `leaseSessionFor` / `resourceIdentityFor`, teardown in the existing `finally`. |
| `packages/runner/itest/envtool.itest.ts` (new) | Env-gated live gate (below). |

## Testing

**Unit** — a fake spawn driven by call counters, never wall-clock ordering (project convention):

- validation rejects: unknown `{placeholder}`; unreferenced `vars` across all declared blocks; a
  `vars` key shadowing a LethAL placeholder; a `vars` value referencing another `vars` entry; a
  field declared in both `reads` and the `bcdev` section; the same `reads` key produced twice;
  create-mode with no `publishApps`
- an unset `${VAR}` throws naming variable and field
- each read failure mode throws with key, path and command
- an empty resolved value throws
- a block whose `reads` include `password` never echoes stdout — asserted on the error string of a
  deliberately non-JSON stdout
- resolution runs exactly once even though three seams consume it — asserted by call counter
- `deleteEnv` fires only for a created env; never for a config-supplied one; never under
  `--keep-env`; never after a quarantine; a failing `deleteEnv` leaves the exit code untouched
- publish verifies the digest, serializes per `envId`, and a publish-failed + verify-accepted pair
  aborts as `anomalous`
- expiry within the hour refuses to start

**Live gate** — `itest:envtool`, env-gated (`LETHAL_ITEST_ENVTOOL=1`), skipping cleanly with exit 0
when unset. Runs the existing `sandbox-app` fixture end to end against a real Continia environment,
dumps the per-mutant table before asserting, and freezes a per-mutant baseline
(`envtool.baseline.json`) on first run, exactly like `itest:bcdev` and `itest:tables`.

Expected: **3 killed / 10 survived / 3 no-coverage** if the bc-dev-mcp probe passes;
**3 / 13 / 0** if it does not and coverage falls back to `"none"` — the same numbers al-runner
produces, and for the same structural reason, though not because the two backends are equivalent:
the fenced path keeps `asserterror` fidelity that al-runner lacks (R7).

## Risks and open questions

1. **bc-dev-mcp against a Continia environment is unproven.** Task 1 is that probe; its result
   selects the coverage mode and decides whether the three backend changes above are needed.
2. **`LethAL Control` must publish to a Continia environment and answer OData.** `HarnessVerifier`
   already checks exactly this. If it cannot, the fence is unavailable there and this feature stops
   at "provision and publish" — no mutation runs.
3. **R1 (fenced-path write permissions) applies unchanged.** A test that writes to its own tables
   hits the same permission failure on a Continia environment as on a container.
4. **R2 (single-tenant containers) is unenforceable in-band** and equally unenforceable here: the
   harness cannot enumerate tenants. Whether Continia environments are guaranteed single-tenant is
   a question for their operators.
5. **Does a Continia environment's base URL survive `env stop` / `start`?** If a restart can move
   it, a long session holding a resolved `baseUrl` would keep calling a dead endpoint. Unknown;
   worth one probe alongside Task 1.
6. **Does republishing `lethal-control.app` over an identical installed version re-run
   install/upgrade and move `serverGeneration`?** The verify-before-publish rule in step 6 makes
   this mostly moot, but the answer decides whether "mostly" is "entirely".
7. **Cost and duration.** Ephemeral mode creates a real environment per run; `env create` duration
   against the 900 s default timeout is unmeasured. Reuse is the default for this reason.

**Settled during review** (recorded so they are not re-asked): `continia env users --json` does
return plaintext passwords and `env get --json` does return `url`, so the worked example's dot
paths are real; `continia publish` relays BC's `Message`, so version-conflict recovery works
through it; `continia publish` hardcodes `tenant=default`, which is the expected `tenant` value for
these environments.

## Exit criteria

1. The bc-dev-mcp probe is run and its result recorded, with the coverage mode chosen from it. If
   the fallback is taken, the three backend changes are implemented and the coverage mode is
   visible in `capabilities()`.
2. A run against a config-supplied `envId` completes end to end and produces the expected verdict
   table, frozen in `envtool.baseline.json`.
3. A run with no `envId` creates an environment, publishes `publishApps` and the control app,
   completes, and deletes the environment; the created id is present in `~/.lethal/env-state/`
   while the run is in flight and gone after a clean finish.
4. `--keep-env` and the quarantine path both demonstrably skip deletion, and a failing `deleteEnv`
   leaves the report and exit code untouched.
5. Every failure mode in the execution-contract table throws with its named fields — proven by unit
   test, not by inspection.
6. No secret appears in any error string, log line or echoed command — including the parse-failure
   path of a credential-bearing block.
7. No tool-specific code exists in LethAL: the entire Continia integration is the config example in
   this document.
