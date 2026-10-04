# R389 probe: can another app run a test-app codeunit it receives in a Variant?

Status: **phase 1 done (design, offline compile, pre-commitment). Not yet run live.** The results
section is filled in after phase 2.

- Question, routes, compile results and expected outcomes: `PRECOMMITMENT.md` (written before
  any live run; do not edit it after the run, add results here instead).
- `external/`: the other app ("LethAL R389 Probe External", ids 91500-91529).
- `tests/`: the test app ("LethAL R389 Probe Tests", ids 91530-91559).
- `refused/R1-implicit.al.txt`: the routes that do not compile, with their exact diagnostics.
- `out/`: compiled `.app` files (gitignored).

## Build (offline)

From the repo root, inside the kraken container (`LETHAL_ALC_DIR` is set):

```bash
cd scripts/r389-probe
PC=../../fixtures/sandbox-hang-tests/.alpackages
$LETHAL_ALC_DIR/alc /project:external /packagecachepath:$PC /out:out/external.app
$LETHAL_ALC_DIR/alc /project:tests "/packagecachepath:$PC;out" /out:out/tests.app
```

Both must end with 0 errors and 0 warnings.

## Phase 2 steps (live, Cronus28)

Credentials come ONLY from the gitignored `fixtures/sandbox-hang/lethal.config.local.json`
(`bcdev.server` = `http://Cronus28`, instance `BC`, company `CRONUS Danmark A/S`). Never put a
user name or password on a command line.

1. **Publish, external first, then tests**, over the dev endpoint with `altool publishapp`, the
   same way `packages/runner/src/publisher.ts` (`ContainerDeployer`) does it:
   argv `altool publishapp <app> --server http://Cronus28 --serverinstance BC --environmenttype OnPrem
   --authentication UserPassword --schemaupdatemode ForceSync --tenant default`, with the user name
   and password passed as the ENVIRONMENT variables `BC_SERVER_USERNAME` / `BC_SERVER_PASSWORD`
   (altool has no flag for them). Do it from a short bun script that reads the config file and
   spawns altool with that env, so no secret reaches the transcript. `$LETHAL_ALC_DIR/altool` is
   the Linux altool. Record altool's stdout (it names the server build on some failures).
2. **Check the endpoint**: `bcdev_status` (bc-dev MCP) with `server: http://Cronus28`,
   `serverInstance: BC`, `port: 7049`, `tenant: default`. Record the BC build it reports.
   The bc-dev MCP takes credentials only from `BC_DEV_USER` / `BC_DEV_PASSWORD` in ITS process
   environment, not as tool parameters (see `scripts/probe-continia-env.ts`). If the session's
   bc-dev MCP was not started with them, spawn the server from the config's `bcdev.mcpCommand`
   with those two env vars set from the config, through the MCP SDK client, exactly as
   `scripts/probe-continia-env.ts` does, and call the same tools there.
3. **Run the tests**: `bcdev_test_run` with `codeunits: [{ id: 91532 }]`, the same connection
   parameters, `company: "CRONUS Danmark A/S"`, `coverage: "none"`. `bcdev_test_discover` on
   `scripts/r389-probe/tests` already finds codeunit 91532 with all 21 methods (checked offline).
   LethAL's own harness is the wrong tool here: it runs tests through the `LethAL Control` app's
   mutant runner, which needs a LethAL-instrumented target.
4. **Read the outcome per test from its failure text** (every test is expected to fail; see
   `PRECOMMITMENT.md`). Fill in the table below, compare each row with the pre-committed
   expectation, and apply the decision rule there.
5. **Do not unpublish** (host-only). List both apps (names, ids, versions in `PRECOMMITMENT.md`)
   for the owner's cleanup: tests app first, then external.

## Results

(Filled in after phase 2: container, BC build, date, one row per test with its verbatim failure
text, and the decision.)
