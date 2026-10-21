# R389 probe: can another app run a test-app codeunit it receives in a Variant?

Status: **phase 2 done on Cronus284 (2026-10-04). See Results at the end.**

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

Run 2026-10-04 on **Cronus284** (NOT Cronus28; the phase-2 steps above name Cronus28 but the
lease was on Cronus284). Server reports `runtimeVersion 17.0` (BC 28.x; the repo's notes give
Cronus284 application 28.4.53241.53758, not re-read this run). Both apps published with `altool
publishapp` (external first, then tests), exit 0 each, no version refusal. Tests ran with
`bcdev_test_run` (codeunit 91532, coverage none): 21 tests, 21 failed as designed, plus one
synthetic result with an empty method name that repeats S1's text (platform artefact of the hub
run; ignore). Raw output was kept outside the repo.

Controls: C0 MARK, R3 MARK, so the run is **valid**. `is` controls (Integer, NonImplementer) both
say `false`, so `is` is a real type test.

| Test | Observed | Predicted | Match |
|---|---|---|---|
| C0_IfaceDirect | MARK (Ping via C0) | MARK | yes |
| R1c_As_FromIface | MARK (Ping via R1c) | MARK | yes |
| R1c_As_FromCodeunit | MARK (Ping via R1c) | MARK (less sure) | yes |
| R1d_IsThenAs_FromIface | MARK (via R1d) | MARK | yes |
| R1d_IsThenAs_FromCodeunit | MARK (via R1d) | MARK | yes |
| R1d_Control_Integer | MEASURED `V is ...` = false | MEASURED false | yes |
| R1d_Control_NonImplementer | MEASURED `V is ...` = false | MEASURED false | yes |
| R2a_RunVariantAsId | `Unable to convert from ...Codeunit91530 to System.Int32.` | conversion error, no MARK | yes |
| R2b_..._FromCodeunit | same Int32 conversion error | IsCodeunit true, then R2a error | yes |
| R2b_..._FromIface | same Int32 conversion error (so IsCodeunit was true) | unknown | recorded |
| R2c_RunVariantTry | same Int32 conversion error, uncaught | uncaught error | yes |
| R2d_RunWithVariantAsRecord | `Unable to convert from ...Codeunit91530 to ...INavRecordHandle.` | platform record error | yes |
| R3_HandBackByEvent | MARK (test-app subscriber) | MARK | yes |
| R4a_UnrelatedCodeunitVar | `The requested operation is not supported.` | type-mismatch error, no MARK | yes (refused) |
| R4b_UnrelatedCodeunitVarRun | `The requested operation is not supported.` | refused, no MARK | yes (refused) |
| R4c_Format_FromCodeunit | MEASURED `Format(V) = [91530]` | some text | yes, but the text is the id |
| R4c_Format_FromIface | MEASURED `Format(V) = [91530]` | some text | yes, but the text is the id |
| **R4d_FormatEvaluateRun** | **MARK (ran the mock's OnRun)** | `MEASURED ... does not evaluate to an Integer` | **NO** |
| R4e_RecordRefGetTable | `Unable to convert ...Codeunit91530 to ...INavRecordHandle.` | platform error | yes |
| R4f_VariantChainToIface | MARK (via R1c) | same as R1c_As_FromCodeunit | yes |
| S1_RunById | MARK (mock OnRun) | MARK | yes |

**S1:** `Codeunit.Run(<integer id>)` from the external app ran the test-app mock's `OnRun`.

**Surprise:** `Format(V)` on a Variant holding a codeunit returns its object ID (`91530`), not a
name. So external code can turn a Variant into an id with no test-app name (R4d), then
`Codeunit.Run(id)` runs the mock. The pre-commitment missed this.

**Verdict per the decision rule: SEND THE PLAN TO REVIEW (build the safe version). R389 does
NOT close as a ruling.** Routes that let external code run a Variant-held test-app codeunit
without test-app code: R1c, R1d (cast or `is`+cast to the shared interface, either way the
Variant was built), and R4d (`Format` then `Evaluate` then `Codeunit.Run`). R2*, R4a, R4b, R4e
are refused at run time. S1 shows an integer id handed out is equally enough. The pre-committed
expectation (R1c and R1d MARK) held; R4d is an additional route found.
