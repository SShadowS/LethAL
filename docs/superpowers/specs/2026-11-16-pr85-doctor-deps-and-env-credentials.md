# PR-85 pre-commitment: doctor checks dependencies on the server (R1087), and credentials from named environment variables (R1086)

Coord PR-85 (2026-11-16). Both come from the DO pilot's friction log (PR-67, PR-84). Neither changes a verdict.

## R1087: `lethal doctor` reads each dependency's installed version on the server

**Today.** Doctor checks the target app's direct `dependencies` against `bcdev.packageCachePath` (`checkDependencies`). It asks
the server only whether the test app is installed (`checkTestApp`, through `HarnessVerifier.fetchExtensionInstalled`). A
server whose installed dependency is missing or older is first seen as a failed publish after the compile. The DO pilot met
this on bc3 (dependencies at 30.0 required, 28.5 installed).

**New check `server-dependencies`** (bcdev only; read-only):
- **Inputs:** the target's `app.json` (from `--project`) and the test app's (from `--tests`), each one's `dependencies`
  (`id`, `name`, `publisher`, `version`). The test app's dependency on the target itself is skipped, because LethAL publishes
  the target.
- **Per distinct dependency id:** one read, `HarnessVerifier.fetchInstalledVersions(id)`. That is read by id, never a list of
  all extensions (R433). It is the same reader `checkTestApp` and the run already use.
- **Result per dependency:**
  - ok: an installed version at or above the `version` in `app.json`, compared part by part as numbers;
  - **missing:** no installed version;
  - **too old:** every installed version is below it.
  Each is printed with its name, publisher, id, required version and installed versions.
- **The check** fails when any dependency is missing or too old, naming each. It passes when all are present and new enough.
  It is skipped with a reason when there is no `--project`, no server section (an `envTool` config, or no `bcdev`), or the
  server cannot be read. A read error fails the check, naming the id; it is never treated as "missing".
- **Not checked, and said so in the check's detail:** the dependencies of those dependencies, and the implicit `application`
  and `platform` ones (`checkDependencies`' existing note), which the server's own build answers.
- **JSON** (`doctor --json`): the check appears like the others, with a per-dependency list, so a CI step can read it.

## R1086: credentials from named environment variables

**Today.** The `bcdev` section requires `username` and `password` in the JSON, plus the same two in `env.BC_DEV_USER` and
`env.BC_DEV_PASSWORD`, which bc-dev-mcp reads. A team with a secrets file, or a CI, types the password into JSON.

**New optional field** `bcdev.credentialsEnv: { "username": "<VAR>", "password": "<VAR>" }`:
- **When present,** `username` and `password` are read from those environment variables when the config is loaded
  (`validateBcDevConfig`, with the environment passed in, so it stays a pure, testable function). The section then gets
  `username`, `password`, `env.BC_DEV_USER` and `env.BC_DEV_PASSWORD` set from them, so every reader (bc-dev-mcp's spawn,
  altool, the harness) is unchanged.
- **Refused, by name,** each in a message that names the field or the VARIABLE, never a value:
  - `credentialsEnv` together with `username`, `password`, `env.BC_DEV_USER` or `env.BC_DEV_PASSWORD` in the JSON
    (ambiguous: which wins would be a guess);
  - a variable name that is missing, empty, or not a valid environment variable name;
  - a variable that is not set, or is set but empty, in the environment.
- **Never logged.**
  - The values are never written to a report, an event, the `--json` envelope, an error message, doctor's output, or the
    store.
  - Doctor shows `credentialsEnv`'s variable NAMES and whether each is set, never a value.
  - Test: a canary secret in the variables, then every output surface of a run, doctor and the refusals is scanned. The canary
    must not appear in any of them.
- **`envTool` configs:** these resolve credentials through their tool (R-envtool) and ignore `credentialsEnv`. Ignoring
  silently would be a trap, so a config with both is refused by name.
- **`lethal init`** gains `--credentials-env <USER_VAR>,<PASS_VAR>`. It writes `credentialsEnv` instead of the
  username/password placeholders and the `env` credential pair.
- **Docs:** README Quick start step 1, `docs/using-lethal-from-an-agent.md` (with the contract test for the new flag), and the
  CI templates (`docs/ci/`), which switch to `credentialsEnv` with the CI's secret variables.

## Tests, red both ways (fakes only; no server)
- R1087:
  - each outcome (ok, missing, too old, a read error, skipped);
  - the version comparison (`10.0` > `9.0`; equal is ok);
  - the target-dependency skip in the test app;
  - one read per distinct id, and never a list call (a call counter on the fake verifier).
- R1086:
  - the resolution;
  - each refusal (each names the variable and holds no value);
  - the canary scan;
  - `init --credentials-env`;
  - the contract test, for the documented flag and field.
- Each rule reverted shows its test red.

## Predictions
- No gate figure moves: gates do not use doctor's new check, and their configs keep plain credentials.
- No report schema change.
