# R-705 / R706 pre-commitment (DRAFT 2, after the Opus review): #5700's HTTP refusal text, hub path vs web-service path

Status: draft, written with NO server call and NO lease. Nothing here has run.
Item: `docs/roadmap/R706.md`. Earlier probe: `docs/measurements/r639/` (probe in `scripts/r639-bc-probe/`).
Upstream: aldevtools/BusinessCentral.AL.Runner #5700.

## 1. The question

An unhandled `HttpClient.Get('http://localhost:1/x')` fails on bc1 (web-service session, runner 130450) with
`BC_HTTP_INTERNAL_TEXT` (r639): "The request was blocked by the runtime to prevent accidental use of production
services." al-runner v3 says "...the connecting endpoint violates security requirements..." (`HttpRequest:Security`).
Upstream reads the "security" text on Windows and on its BC-on-Linux CI "through the test runner hub". Which text does
the hub path give on our server, next to the web-service path, in the same stretch of work?

## 2. The two paths

- **Hub path (called the "client path" in R706).** bc-dev-mcp's `bcdev_test_run`, which calls the dev endpoint's
  `TestRunnerHub` (SignalR `RunTests`). BC runs the test in a **Web Client** session with `GuiAllowed=Yes`.
  Evidence for the session kind: r661 (`docs/measurements/r661/README.md`, bc3): the hub's test session showed in
  `Active Session` as `Web Client`. This probe does NOT re-read the session kind: a sub-second HTTP test cannot be
  caught in `Active Session`. Evidence that the hub works on bc1: the hub leg of `itest:bcdev-wrapped`, proven on
  bc1-bc3 (R604). r661 itself was bc3.
- **Web-service path.** LethAL Control `RunMutant`, baseline (`mutantId ""`), runner 130450, as r639.
- Neither is client services (WebSocket, page 130455, `Run-TestsInBcContainer`). That route is host-only and no client
  port is in `docs/gates/servers.md`. This probe never claims it.

Two hypotheses, UNMEASURED here and not to be stated as findings:
- H1: BcContainerHelper's `Run-TestsInBcContainer` and AL-Go may use runner 130450, the same runner as our web-service
  path. If so, a user's CI could read the same text as our web-service path.
- H2: "blocked" may be the default `TestHttpRequestPolicy` being enforced under a runner codeunit.
The hub may also use another runner and has `GuiAllowed=Yes`, so a difference is "session kind or runner" (the
callstacks say which runner), never "session kind" alone.

## 3. Server, build, lease

- **Server `bc1`** (r639 measured there). One server, one lease, lane bugs.
- **Lease**: only after a heavy slot is free and the server's go is in hand. `kraken coord lease bc1 bugs`, heartbeat
  every 60 s, by `scripts/r706-client-probe/run-probe.sh` (section 9). Check `/coord/machine/out-of-use/bc1.md` first.
- **Build**: Base, System Application and the platform, all read by id, must equal 28.4.53241.56590. LethAL Control
  version is recorded (r639 had 1.0.0.23). Any difference: STOP before the publish.
- No other call to bc1 outside the lease.

## 4. The probe apps: r639's exact bytes

- Publish the r639 builds from `/work/lethal-wt/r639/scripts/r639-bc-probe/build/`, with these full sha256 values
  (from `docs/measurements/r639/bc1-probe.json`, checked against `sha256sum` of `target.app` and `tests.app` there):
  - target (`target.app`): `7c46f5f75efa2bab59a557394f39008ebe9549b1625a03b4976fccaa0e4d0060`
  - tests (`tests.app`): `2b1138ace6bd2e7aa903fc3bd8cba2ed9a57e1ed6bd5e2f3c15222203595cd5a`

  The driver copies both into the evidence folder `/coord/handoff/R-705/probe/apps/`, checks each sha256 against the
  pre-committed full value above, and REFUSES on a mismatch. It NEVER recompiles. `TestHttpRequestPolicy` is absent
  (r639's sources have none).
- Test codeunits: 92911 `HttpGetRaw` (prints `Error('MEASURED [%1] [%2]', GetLastErrorText(), GetLastErrorCode())`) and
  92910 `HttpGet` (the unhandled call as #5700 reports it).
- Both app ids read absent by id before the publish (never a list, R433).

## 5. Order and what is saved

1. Guards (section 9), build read, apps absent, op marker read; publish target, then tests.
2. Run 1: web-service path (92911, 92910), then hub path (92911, 92910).
3. Run 2: hub path first, then web-service path (same methods), so an order effect shows.
4. Removal (in `finally`): tests app first, then target; uninstall, unpublish, read each back absent.
5. Op marker read again; classify; write `readings.json`.

Saved under `/coord/handoff/R-705/probe/`:
- `ws-run1.json`, `ws-run2.json`: the WHOLE web-service verdict, uncut;
- `hub-run1.json`, `hub-run2.json`: the WHOLE JSON payload of bc-dev-mcp's `bcdev_test_run`, uncut (called directly,
  not through `BcDevMcpBackend`, with `coverage: "none"`; this also settles whether the hub returns a test's text
  without a coverage mode);
- `readings.json`, `drive.log`, `apps/`, and a README naming the server, build, harness commit and runner.
A copy of `readings.json` and the README go to `docs/measurements/r706/` after a check that no AL source text is in them.

## 6. Classification: exact match, one rule for both paths

Two constants, each compared byte for byte (no trim, no case folding, no prefix match), both fixed here BEFORE the run:
- `BLOCKED` = `BC_HTTP_INTERNAL_TEXT` in `packages/runner/src/al-runner-v3-contract.ts` (r639, bc1):
  "The request was blocked by the runtime to prevent accidental use of production services."
- `SECURITY` = the message of v3's one-shot row for the unhandled localhost call (leg C's `refusal-row-shape` line in
  `/work/tools/al-runner-v3/failed/v3.0.0-alpha.5@6eddda0bc744b5397dc11c5edc34fc841d065e47/gate.log`, line 22), which is
  also the text upstream reports in #5700 (`HttpRequest:Security`; `gh issue view 5700 -R aldevtools/BusinessCentral.AL.Runner --comments`
  quotes "...the connecting endpoint violates security requirements..."). The repo holds this string only as a test
  literal (`EDGE_TEXT` in `packages/runner/tests/al-runner-v3-contract.test.ts`), not as a source constant. It is one
  line:
  "There was an error while executing the HTTP request, the connecting endpoint violates security requirements. Make sure you are connecting to a valid endpoint."

Per method per run, the **reading** is the first line of the failure text with the test framework's own prefix removed
(92911: the `[%1]` of its `MEASURED` line; 92910: the first line of the failure message). It is `BLOCKED` if equal to
the `BLOCKED` constant, `SECURITY` if equal to the `SECURITY` constant, else `OTHER` (kept raw). It is `NONE` for a hub
call with no text (isError, skipped, no result, timeout). The same rule applies on both paths. The **path class** of a
path in one run is the reading of 92911 and 92910 if they agree; if they disagree it is `SPLIT`.

When code and text disagree (text `BLOCKED` with a code other than `HttpRequest`, or the reverse), the class follows
the TEXT and the code is reported.

The **outcome** is assigned from the table below, top to bottom, first row that fits. Every case has a row.

| # | Condition | Outcome |
|---|---|---|
| 1 | any `SPLIT` path class, or run 1 and run 2 disagree on a path | **Unsettled.** `unlike-bc` stays. No extra attempt in this lease. |
| 2 | hub class `NONE` in any run | **Hub unmeasured.** `unlike-bc` stays. The web-service reading is recorded as an r639 reproduction (if it is not `BLOCKED`, it is reported as a contradiction of r639). |
| 3 | hub `SECURITY`, web-service `BLOCKED`, every run | **Outcome A** (section 7). |
| 4 | both `BLOCKED`, every run | **v3 is wrong.** `unlike-bc` stays. Upstream is told. |
| 5 | both `SECURITY`, every run | The web-service result contradicts r639: **no conclusion on #5700.** `unlike-bc` stays. File an item "bc1 changed since r639". |
| 6 | hub `BLOCKED`, web-service `SECURITY`, every run | **Unexplained.** `unlike-bc` stays. Report it. |
| 7 | any path class `OTHER` (a third text) | **Record the text.** `unlike-bc` stays. |

(Row 7 is checked before rows 3-6 when a third text appears; rows 3-6 only see `BLOCKED`/`SECURITY` classes.)

## 7. What each outcome means

**Outcome A (row 3)** replaces R706's first bullet, reworded after review. BC gives two texts depending on the path
(session kind or runner), and v3 matches the hub path. This alone does NOT meet ruling (a) and does NOT add the
"security" text as a second `gone` text. Which path v3 must match (the hub, a user's VS Code, or the runner 130450 path
that H1 says a BcContainerHelper or AL-Go CI may use) is an owner ruling plus a roadmap item. The harness question (the
authoritative bcdev backend runs tests in a session whose texts differ from the hub's) is a separate item. H1 and H2
stay unmeasured hypotheses.

Other outcomes, from R706, kept as written:
- Both paths read `BLOCKED` (row 4): v3 is wrong; `unlike-bc` stays and upstream is told.
- If upstream first closes #5700 as a BC-on-Linux image difference: that does NOT lift the ruling, because our oracles
  bc1-bc3 are BC on Linux. It becomes an owner ruling plus a roadmap item.
- If a later build writes `BC_HTTP_INTERNAL_TEXT`, the fact reads `gone` (held): a normal re-pre-commitment.

Predictions (stated before the run): web-service `BLOCKED`, high confidence (r639). Hub: no better than 50/50.

## 8. STOP rule, and the hub overrun

- No publish, no removal: build differs; an app hash differs from the pre-committed value; either app id not read
  absent; bc1 out of use or not held by lane bugs. A build or hash stop is exit 3 (nothing was published).
- **Hub overrun** (a hub call outlives its budget, 60 s): close the bc-dev-mcp child, then poll `Active Session`
  (bounded, 120 s) until the hub's test session is gone. Make NO other call to bc1 before that. If it is gone, the hub
  is unmeasured for that pass (class `NONE`, row 2). If it is not gone within the bound: HOLD, no removal, exit 5.
  One overrun means the hub is unmeasured for that pass. NEVER make a second hub call while one may still be running.
- A removal that cannot be read back absent: exit 5, HOLD the lease (no release), tell the owner.
- Exit codes: 0 ran and removed; 1 a step failed (apps removed); 2 a guard refused; 3 STOP before publish; 5 HOLD
  (removal not read absent, or an overrun not gone).

## 9. Driver and wrapper requirements (for the builder)

Both files are committed BEFORE the run, together: `scripts/r706-client-probe/drive.ts` and
`scripts/r706-client-probe/run-probe.sh`. Copy `scripts/r661-hub-probe/run-probe.sh` and `r639-bc-probe/drive.ts`.

**The wrapper `run-probe.sh`:**
- refuses if `/coord/machine/out-of-use/bc1.md` exists;
- refuses if `git status --porcelain -- scripts/r706-client-probe` is not empty (probe sources committed);
- takes the lease (`kraken coord lease bc1 bugs`), records the token, heartbeats every 60 s;
- runs the driver in the foreground;
- releases the lease only on driver exit 0, 1, 2 or 3; any other exit (5, a signal, the OOM killer) goes to HOLD: keep
  and heartbeat the lease, mark bc1 out of use, as r661's wrapper does.

**The driver `drive.ts`:**
- refuses (exit 2) unless `kraken coord holder bc1` names lane bugs and no out-of-use marker exists;
- reads the login only inside the script, never prints it;
- reads Base, System Application and the platform by id and requires 28.4.53241.56590; records the LethAL Control
  version; STOPs (exit 3) before publishing on any difference;
- reads both app ids absent by id, never by list (R433);
- puts a timeout on every call;
- runs web-service calls under the control-app lease, and reads the op marker before and after;
- uses one bc-dev-mcp child per hub call, closed in `finally`; the hub call is `bcdev_test_run` directly with
  `coverage: "none"` (section 5); overrun handling as section 8;
- runs the removal in `finally`: tests app first, then target, each read back absent;
- computes the outcome IN CODE from the section 6 table; `readings.json` holds every run's reading, path class and the
  outcome row;
- records in `readings.json`: the harness commit; bc-dev-mcp commit 8371d0b and that `dist/` was built from it (check
  `git -C /work/src/bc-dev-mcp rev-parse HEAD`, and that `dist/index.js` is newer than that commit's sources); both app
  sha256s; the coverage mode `none`; the runner on each callstack; the raw first lines and codes.
- has a small unit test `scripts/r706-client-probe/classify.test.ts` of the classifier and the outcome table: one case
  per table row 1-7, plus the none case (no hub text), the mixed case (92910 and 92911 disagree), run 1 versus run 2
  disagreement, and "code and text disagree". Each case asserts the exact outcome row, not only "not A". Red-check it:
  break one row's condition and see its case go red.

## 10. What stays on bc1

As after r639: the probe table's schema may remain as a ghost, and one row in LethAL Control's artifact registry for
the target `d371a89d-...` (updated, never added). Nothing else.

## 11. What this does NOT settle, and what is not done

- It does not measure a CI that uses client services (WebSocket, page 130455), nor H1 or H2. A `SECURITY` text on the
  hub is evidence about the hub path upstream names, not about BcContainerHelper's route.
- It does not measure Windows BC. One server, one build; bc2/bc3 are not read.
- **Not done: the `TestHttpRequestPolicy` diagnostic arm** (a probe with the property set, to test H2). It is outside
  R706's conditions (the property must be absent). File it as its own item if the outcome makes H2 matter.
