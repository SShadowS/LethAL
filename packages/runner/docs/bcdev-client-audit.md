# The bcdev-client audit (PR-479, round 1)

Every non-test line under `packages/*` and `scripts/` that names the backend kinds, decided once. A test
(`packages/runner/tests/bcdev-client-audit.test.ts`) reads this table and fails if a site is added or removed
without a row here.

**What counts as a site:** a line that holds `"bcdev"`, `"al-runner-v3"`, `isBcdev(`, `isBcServer(`, `isBcServerName(`,
`isBcdevClient(`, `isLocalRunner(`, `backendSessionKind`, `BackendKind` or `BCDEV_CLIENT`. Comment lines, `*.test.ts`,
`tests/`, `itest/` and `native/` are not scanned, with one exception: `packages/runner/itest/baseline-guard.ts` is
production code (the stage-baseline guard) and is scanned.

**How the test matches rows to lines:** a row names a file and an excerpt. A site belongs to the FIRST row of its file
(in table order) whose excerpt is a substring of the site's line, so a specific row goes above a general one. A row's
count must equal the number of sites it claims. An unclaimed site, or a count that differs, fails the test.

**Decisions:**
- `same-as-bcdev`: the client backend takes the bcdev path (it is a BC server run).
- `refuse:<name>`: the client backend is refused here, by that name.
- `new-arm`: code written for the client backend in this round (or a place that now has a client value).
- `off`: a bcdev-only feature that is switched off for a client run (it has no meaning there).
- `unreachable`: text, a type, an import, or a branch a client run cannot reach.

| file | excerpt | count | decision | why |
|---|---|---|---|---|
| packages/runner/scripts/probe-r63-hub-payload.ts | BcDevLocalConfig["bcdev"] | 1 | unreachable | a probe script's config key |
| packages/runner/src/al-runner-coverage.ts | { kind: "bcdev" } | 1 | same-as-bcdev | v3 coverage build symbols: alc's set |
| packages/runner/src/al-runner-v3-backend.ts | kind: "al-runner-v3", | 1 | unreachable | the v3 backend's own capabilities |
| packages/runner/src/backend.ts | export type BackendKind | 1 | new-arm | the kind gains bcdev-client |
| packages/runner/src/backend.ts | export const BCDEV_CLIENT | 1 | new-arm | the one place the name is written |
| packages/runner/src/backend.ts | export function isBcdevClient( | 1 | new-arm | the client predicate |
| packages/runner/src/backend.ts | return kind === BCDEV_CLIENT; | 1 | new-arm | the client predicate |
| packages/runner/src/backend.ts | export function isBcdev( | 1 | new-arm | stays headless-only, as the spec says |
| packages/runner/src/backend.ts | return kind === "bcdev"; | 1 | new-arm | stays headless-only, as the spec says |
| packages/runner/src/backend.ts | export function isBcServer( | 1 | new-arm | true for bcdev and bcdev-client |
| packages/runner/src/backend.ts | return kind === "bcdev" \|\| kind === BCDEV_CLIENT; | 1 | new-arm | true for bcdev and bcdev-client |
| packages/runner/src/backend.ts | export function isBcServerName( | 1 | new-arm | the same, for a stored or reported name |
| packages/runner/src/backend.ts | return name === "bcdev" \|\| name === BCDEV_CLIENT; | 1 | new-arm | the same, for a stored or reported name |
| packages/runner/src/backend.ts | export function isLocalRunner( | 1 | same-as-bcdev | the client is not a local runner |
| packages/runner/src/backend.ts | return kind === "al-runner-v3"; | 1 | same-as-bcdev | the client is not a local runner |
| packages/runner/src/backend.ts | readonly kind: BackendKind; | 1 | new-arm | a capability's kind may be bcdev-client |
| packages/runner/src/bcdev-backend.ts | import { BCDEV_CLIENT } | 1 | new-arm | import |
| packages/runner/src/bcdev-backend.ts | kind: this.cfg.clientMode === true ? BCDEV_CLIENT : "bcdev" | 1 | new-arm | the built backend reports its own kind; coverage "none" beside it |
| packages/runner/src/campaign-freeze.ts | report.backend === "al-runner-v3" | 1 | same-as-bcdev | v3 freeze stays refused; a client stage records its backend (baseline-guard) |
| packages/runner/src/campaign-subcommands.ts | import { type BackendKind, type CoverageMode, isBcdevClient } | 1 | new-arm | import |
| packages/runner/src/campaign-subcommands.ts | isBcdevClient(ran as BackendKind) | 1 | refuse:bcdev-client-never-mixed | `campaign anchors`: a stage's anchors are pre-committed against a headless run's coverage, so a client report is refused |
| packages/runner/src/changed-line-survivors.ts | import { BCDEV_CLIENT } | 1 | new-arm | import |
| packages/runner/src/changed-line-survivors.ts | const v3 = report.backend === "al-runner-v3" | 1 | same-as-bcdev | only v3 puts a survivor apart |
| packages/runner/src/changed-line-survivors.ts | report.backend === BCDEV_CLIENT | 1 | new-arm | the survivor list carries the client-no-coverage text |
| packages/runner/src/client-mode.ts | "bcdev" section has no | 1 | unreachable | an error text |
| packages/runner/src/confirm.ts | import { type BackendKind, isBcdev } | 1 | same-as-bcdev | import |
| packages/runner/src/confirm.ts | r.backend !== "al-runner-v3" | 1 | refuse:ConfirmInputNotV3Error | a client report is not a --confirm-from input |
| packages/runner/src/confirm.ts | type ConfirmationMeasuredBy | 1 | unreachable | a type |
| packages/runner/src/confirm.ts | !isBcdev(bc.backend as BackendKind) | 1 | refuse:ConfirmMergeBcNotBcdevError | a client report is not the BC side of a merge |
| packages/runner/src/confirm.ts | measuredBy: "al-runner-v3" | 2 | unreachable | a confirmation row's label |
| packages/runner/src/confirm.ts | measuredBy: "bcdev" | 1 | unreachable | a confirmation row's label |
| packages/runner/src/confirm.ts | m.measuredBy === "bcdev" | 2 | unreachable | a confirmation row's label |
| packages/runner/src/confirm.ts | m.measuredBy === "al-runner-v3" | 1 | unreachable | a confirmation row's label |
| packages/runner/src/doctor.ts | runCheck("al-runner-v3" | 1 | unreachable | the v3 check |
| packages/runner/src/doctor.ts | name: "al-runner-v3" | 1 | unreachable | the v3 check |
| packages/runner/src/events.ts | BackendKind, | 1 | same-as-bcdev | import |
| packages/runner/src/events.ts | readonly kind?: BackendKind; | 1 | same-as-bcdev | a type |
| packages/runner/src/events.ts | readonly backendSessionKind: "client" | 1 | new-arm | the value "client" is now reachable on a BC server run |
| packages/runner/src/explain.ts | report.backend === "al-runner-v3" \|\| isBcServerName(report.backend) | 1 | same-as-bcdev | a bcdev-client report with survivors and no list says so |
| packages/runner/src/line-map.ts | import { BCDEV_CLIENT } | 1 | new-arm | import |
| packages/runner/src/line-map.ts | case "bcdev": | 1 | same-as-bcdev | the BC shape rule |
| packages/runner/src/line-map.ts | case BCDEV_CLIENT: | 1 | same-as-bcdev | the BC shape rule |
| packages/runner/src/line-map.ts | case "al-runner-v3": | 1 | same-as-bcdev | the v3 rule |
| packages/runner/src/mutation-elements.ts | import { BCDEV_CLIENT } | 1 | new-arm | import |
| packages/runner/src/mutation-elements.ts | report.backend === BCDEV_CLIENT | 2 | new-arm | the elements page carries the client-no-coverage text on each survivor |
| packages/runner/src/not-run-survivors.ts | isBcServerName(r.backend) | 2 | same-as-bcdev | BC wording, no nearby tag |
| packages/runner/src/not-run-survivors.ts | isBcServerName(scope.backend) | 1 | same-as-bcdev | BC wording |
| packages/runner/src/preprocessor-symbols.ts | import type { BackendKind } | 1 | same-as-bcdev | import |
| packages/runner/src/preprocessor-symbols.ts | export type BuildBackend | 1 | new-arm | the build backend may be a client run |
| packages/runner/src/report-fold.ts | readonly backendSessionKind | 1 | new-arm | accumulator type |
| packages/runner/src/report-fold.ts | backendSessionKind: e.backendSessionKind | 1 | new-arm | accumulator copy |
| packages/runner/src/report-fold.ts | isBcServer(statics.caps.kind) | 1 | same-as-bcdev | the BC list of tests not run at baseline |
| packages/runner/src/report.ts | if (caps.kind === "al-runner-v3") { | 1 | same-as-bcdev | the v3 execution context |
| packages/runner/src/report.ts | if (isBcdevClient(caps.kind)) { | 1 | new-arm | a client execution context (unmeasured) |
| packages/runner/src/report.ts | runnerBuild !== undefined && caps.kind === "al-runner-v3" | 1 | same-as-bcdev | v3 build stamp |
| packages/runner/src/report.ts | if (isBcdevClient(input.caps.kind)) caveats.push | 1 | new-arm | the client-no-coverage caveat, on every bcdev-client report |
| packages/runner/src/report.ts | input.caps.kind === "al-runner-v3" \|\| isBcServer(input.caps.kind) | 1 | same-as-bcdev | notRunAtBaseline is filled |
| packages/runner/src/report.ts | isBcdev(input.caps.kind) && | 1 | unreachable | needs coverage other than none; a client run has none |
| packages/runner/src/report.ts | sessionKind.backendSessionKind !== | 1 | new-arm | session-kind-mismatch follows the client kind |
| packages/runner/src/session-kind.ts | export function backendSessionKind( | 1 | new-arm | returns "client" for bcdev-client |
| packages/runner/src/store.ts | import { BCDEV_CLIENT } | 1 | new-arm | import |
| packages/runner/src/store.ts | const v3 = "al-runner-v3"; | 1 | same-as-bcdev | the lending rule for v3 |
| packages/runner/src/store.ts | run.backend === BCDEV_CLIENT && session === undefined | 1 | refuse:lend-no-session | with no session a client run lends nothing |
| packages/runner/src/store.ts | ran on ${BCDEV_CLIENT} and this caller | 1 | refuse:lend-no-session | the refusal text |
| packages/runner/src/store.ts | (run.backend === BCDEV_CLIENT \|\| session.backend === BCDEV_CLIENT) | 1 | refuse:lend-client-equality | an equality arm on kind |
| packages/runner/src/store.ts | a ${BCDEV_CLIENT} verdict | 1 | refuse:lend-client-equality | the refusal text |
| packages/runner/src/store.ts | q.backend === "al-runner-v3" | 1 | same-as-bcdev | resume lookup: only v3 names a build; a client name matches only a client run |
| packages/runner/src/store.ts | BCDEV_CLIENT, | 1 | refuse:snapshot-backend | findBaselineSnapshot's backend predicate |
| packages/runner/src/verify.ts | { kind: "bcdev" }, | 1 | unreachable | `lethal verify` builds its own headless backend |
| packages/runner/src/orchestrator.ts | BackendKind, | 1 | same-as-bcdev | import |
| packages/runner/src/orchestrator.ts | backendSessionKind, | 1 | same-as-bcdev | import |
| packages/runner/src/orchestrator.ts | options.backend ?? { kind: "bcdev" } | 1 | same-as-bcdev | default of an option; headless |
| packages/runner/src/orchestrator.ts | isBcdevClient(row.backend as BackendKind) | 1 | refuse:bcdev-client-never-mixed | --resume-run across the client line |
| packages/runner/src/orchestrator.ts | isBcServer(caps.kind) && lease === undefined | 1 | same-as-bcdev | a lease is required |
| packages/runner/src/orchestrator.ts | isBcServer(a.caps.kind) && | 1 | same-as-bcdev | quarantine consult |
| packages/runner/src/orchestrator.ts | } else if (isBcServer(a.caps.kind)) { | 1 | same-as-bcdev | quarantine safety net |
| packages/runner/src/orchestrator.ts | ...(isBcServer(caps.kind) && | 1 | same-as-bcdev | a row whose body never ran |
| packages/runner/src/orchestrator.ts | isBcServer(caps.kind) && contributed | 1 | same-as-bcdev | an unattested artifact quarantines (round 2 attests through rows) |
| packages/runner/src/orchestrator.ts | cfg.killLedger === false && !isBcdev(caps.kind) | 1 | refuse:kill-ledger-flag-backend | --no-kill-ledger is refused on a client run |
| packages/runner/src/orchestrator.ts | if (isBcdevClient(caps.kind)) { | 3 | new-arm | the experimental gate, never-mixed and flag refusals; the /cs and version preflight; the client-ran-testpage-unscored warning |
| packages/runner/src/orchestrator.ts | isBcdevClient(cfg.backend.capabilities().kind) | 1 | refuse:bcdev-client-refused-named-mutants | S3: runNamedMutants has no client preflight or refusals |
| packages/runner/src/orchestrator.ts | cfg.excludeTests.length > 0 && !isBcdev(caps.kind) | 1 | refuse:exclude-test | the client refusal comes first (bcdev-client-refused-exclude-test) |
| packages/runner/src/orchestrator.ts | if (caps.kind === "al-runner-v3" && workers > 1) | 1 | same-as-bcdev | v3 lanes |
| packages/runner/src/orchestrator.ts | caps.kind === "al-runner-v3" | 1 | new-arm | the collapse is gone: a client run stores its own name |
| packages/runner/src/orchestrator.ts | ? { kind: "al-runner-v3" } | 1 | same-as-bcdev | the v3 build backend |
| packages/runner/src/orchestrator.ts | isLocalRunner( | 9 | same-as-bcdev | the client is not a local runner |
| packages/runner/src/orchestrator.ts | const companyWrites = isBcServer(caps.kind) | 1 | same-as-bcdev | the company-write scan runs for both BC kinds |
| packages/runner/src/orchestrator.ts | isBcdevClient(caps.kind) && companyWrites.length > 0 | 1 | refuse:bcdev-client-refused-client-company-writes | S5: a client run leaves no method out, so company-write methods are refused unless --keep-company-tests (--tests-only still drops whole codeunits) |
| packages/runner/src/orchestrator.ts | sessionKindSensitiveTests(testModel, tests, !isBcdev(caps.kind)) | 1 | new-arm | S5: a client run takes the TestPage and unreadable-source reasons too; only headless bcdev is handlers-only |
| packages/runner/src/orchestrator.ts | backendSessionKind: backendSessionKind({ | 1 | new-arm | the event's session kind |
| packages/runner/src/orchestrator.ts | bcdev: isBcdev(caps.kind), | 1 | new-arm | headless flag |
| packages/runner/src/orchestrator.ts | client: isBcdevClient(caps.kind), | 1 | new-arm | the client flag: backendSessionKind says "client" |
| packages/runner/src/orchestrator.ts | testPageScan: ReadonlyMap<string, string> = isBcServer(caps.kind) | 1 | same-as-bcdev | the TestPage scan runs for both BC kinds |
| packages/runner/src/orchestrator.ts | testPageRefused: ReadonlyMap<string, string> = isBcdevClient(caps.kind) | 1 | new-arm | S5: a client run refuses no TestPage test; they run and are named client-ran-testpage-unscored |
| packages/runner/src/orchestrator.ts | !isBcServer(caps.kind) && (await testAppInstallsPermissionsMock | 1 | same-as-bcdev | BC refuses its own |
| packages/runner/src/orchestrator.ts | isBcServer(caps.kind) ? undefined : readAppVersionBestEffort | 1 | same-as-bcdev | app version is the server's |
| packages/runner/src/orchestrator.ts | const largeMethods = isBcServer(caps.kind) | 1 | same-as-bcdev | large-method warning |
| packages/runner/src/orchestrator.ts | isBcServer(backendName) | 2 | same-as-bcdev | BC shape rule for wrapped files |
| packages/runner/src/orchestrator.ts | isBcdev(backendName) && cfg.stopHungSessions | 1 | refuse:bcdev-client-refused-stop-hung-sessions | S4: the flag is refused on a client run up front, so this headless warning is never reached |
| packages/runner/src/orchestrator.ts | if (isBcServer(caps.kind)) assertMethodGuards | 1 | same-as-bcdev | guard limit per call |
| packages/runner/src/orchestrator.ts | isBcdev(caps.kind) && baselineTimeoutMs | 1 | off | the stop grace does not apply: a client run sends no stop |
| packages/runner/src/orchestrator.ts | if (isBcServer(caps.kind) && workers > 1) | 1 | refuse:workers | one session at a time on one tier |
| packages/runner/src/orchestrator.ts | killLedgerOff: cfg.killLedger === false \|\| isBcdevClient(caps.kind) | 1 | off | R197's ledger and R1174's re-walk are off on a client run |
| packages/runner/src/orchestrator.ts | if (isBcdevClient(scope.caps.kind)) return scoreClientBatch(scope, input); | 1 | new-arm | round 3b: a client batch is scored from whole-codeunit client ops (`scoreClientBatch`); headless scoreBatch is unchanged below it |
| packages/runner/src/orchestrator.ts | isBcdevClient(caps.kind) ? { clientUnscored: | 1 | new-arm | round 3b: the TestPage methods a client run runs but never scores |
| packages/runner/src/orchestrator.ts | dependents !== null && isBcServer(caps.kind) | 1 | same-as-bcdev | object-clash check before publish |
| packages/runner/src/orchestrator.ts | isBcdev(caps.kind) && backend.stopsHungSessions | 1 | off | a client run sends no stop |
| packages/runner/src/orchestrator.ts | isBcServer(scope.caps.kind) && !attestation.clean | 1 | same-as-bcdev | an unattested probe is an error |
| packages/runner/src/orchestrator.ts | backend.capabilities().kind !== "al-runner-v3" | 1 | same-as-bcdev | v3-only branch |
| packages/runner/src/orchestrator.ts | isBcdev(args.backend.capabilities().kind) | 1 | off | R1174's re-walk is off on a client run |
| packages/runner/src/orchestrator.ts | if (kind !== "al-runner-v3") return undefined; | 1 | same-as-bcdev | no runner build on a client run |
| packages/runner/src/orchestrator.ts | isBcdev(caps.kind) | 1 | off | the --no-kill-ledger fingerprint pair is bcdev-only; a client run is off by kind |
| packages/runner/src/cli.ts | import type { BackendKind, BackendStatus | 1 | same-as-bcdev | import |
| packages/runner/src/cli.ts | function parseBackendKind( | 1 | new-arm | parses the name; the gate is where the backend is built |
| packages/runner/src/cli.ts | missing required --backend | 1 | unreachable | an error text |
| packages/runner/src/cli.ts | raw !== "bcdev" && raw !== "al-runner-v3" | 1 | new-arm | accepts the name; never turns it on |
| packages/runner/src/cli.ts | unknown --backend | 1 | unreachable | an error text |
| packages/runner/src/cli.ts | readonly backendKind | 4 | same-as-bcdev | a field type |
| packages/runner/src/cli.ts | other commands read it from the config file | 1 | unreachable | help text |
| packages/runner/src/cli.ts | isBcdevClient(parseBackendKind(values.backend)) | 1 | refuse:bcdev-client-refused-dry-run | a dry run previews a headless build |
| packages/runner/src/cli.ts | isBcServer(backendArg) && workers > 1 | 1 | refuse:workers | the server's active-mutant record is single |
| packages/runner/src/cli.ts | isLocalRunner(backendArg) | 2 | same-as-bcdev | keep-env and allow-expiring-env |
| packages/runner/src/cli.ts | backendArg !== "al-runner-v3" | 1 | same-as-bcdev | --isolate-tests is v3 only; a client run refuses |
| packages/runner/src/cli.ts | !isBcdev(backendArg) | 1 | refuse:ConfirmBackendNotBcdevError | --confirm-from needs headless bcdev |
| packages/runner/src/cli.ts | if (backendArg === "al-runner-v3") { | 1 | same-as-bcdev | v3 platform check |
| packages/runner/src/cli.ts | "bcdev" section | 12 | unreachable | config error texts |
| packages/runner/src/cli.ts | parsed.backendKind !== "al-runner-v3" | 3 | same-as-bcdev | v3-only config |
| packages/runner/src/cli.ts | parsed.backendKind === "al-runner-v3" | 3 | same-as-bcdev | v3 branches |
| packages/runner/src/cli.ts | parsed.backendKind !== undefined && isBcdevClient(parsed.backendKind) | 1 | refuse:bcdev-client-refused-init | S4: lethal init writes no config for the experimental backend |
| packages/runner/src/cli.ts | isBcdevClient(parsed.backendKind) && configFile.envTool | 1 | refuse:bcdev-client-refused-env-tool | an env tool provisions a server /cs does not know |
| packages/runner/src/cli.ts | parsed.backendKind !== "bcdev" \|\| configFile.envTool | 1 | same-as-bcdev | env-tool session is headless-only (a client run refuses above) |
| packages/runner/src/cli.ts | join(scratchDir, "al-runner-v3") | 1 | unreachable | v3 scratch folder |
| packages/runner/src/cli.ts | isBcdevClient(parsed.backendKind) && parsed.experimentalClientMode | 1 | new-arm | THE experimental gate, where the backend is built |
| packages/runner/src/cli.ts | isBcdevClient(parsed.backendKind), | 1 | new-arm | the backend is built in client mode |
| packages/runner/src/cli.ts | !isBcServer(parsed.backendKind)) return {} | 3 | same-as-bcdev | lease, permission canary and resource identity |
| packages/runner/src/cli.ts | backendKind === "bcdev" ? [head | 1 | unreachable | the dry run's note; a client dry run is refused |
| packages/runner/src/cli.ts | backendKind: BackendKind \| undefined, | 2 | same-as-bcdev | a parameter type |
| packages/runner/src/cli.ts | isLocalRunner(backendKind) | 1 | same-as-bcdev | the client is not a local runner |
| packages/runner/src/cli.ts | isLocalRunner(parsed.backendKind) | 1 | same-as-bcdev | env-tool warning |
| packages/runner/src/cli.ts | paths.backendKind === "bcdev" | 1 | unreachable | the dry run builds a headless listing |
| packages/runner/src/cli.ts | backend = { kind: "bcdev" }; | 1 | unreachable | the dry run builds a headless listing |
| packages/runner/src/cli.ts | paths.backendKind === "al-runner-v3" | 1 | unreachable | the dry run's v3 listing |
| packages/runner/src/cli.ts | backend = { kind: "al-runner-v3" }; | 1 | unreachable | the dry run's v3 listing |
| packages/runner/src/cli.ts | isBcdev(paths.backendKind) | 1 | unreachable | the dry run (a client dry run is refused) |
| packages/runner/src/cli.ts | given.backendKind === "bcdev" && configStop | 1 | off | the config's standing yes for the stop: a client run sends no stop |
| packages/runner/src/cli.ts | isBcServer(parsed.backendKind) | 2 | same-as-bcdev | dependency package dirs, restore notice |
| packages/runner/src/cli.ts | lethal doctor found no "bcdev" | 1 | unreachable | an error text |
| packages/runner/src/cli.ts | backendKind: "bcdev", | 1 | unreachable | `lethal verify` builds headless |
| packages/runner/src/cli.ts | Pick<LethalConfigFile, "bcdev" \| "alRunnerV3"> | 1 | unreachable | a type |
| packages/runner/src/cli.ts | if (backendKind === "al-runner-v3") { | 1 | same-as-bcdev | v3 branch |
| packages/runner/itest/baseline-guard.ts | import { BCDEV_CLIENT } | 1 | new-arm | import |
| packages/runner/itest/baseline-guard.ts | ?? "bcdev" | 2 | same-as-bcdev | a stage or report with no backend field is read as a headless one |
| packages/runner/itest/baseline-guard.ts | frozen !== BCDEV_CLIENT && ran !== BCDEV_CLIENT | 1 | refuse:bcdev-client-never-mixed | a stage frozen on one side of the client line is never compared with a report from the other |
| packages/runner/itest/baseline-guard.ts | bcdev-client-never-mixed: ${what} | 1 | refuse:bcdev-client-never-mixed | the refusal text |
| scripts/agentflow/gate-table.ts | legs: [ | 6 | unreachable | gate leg names |
| scripts/agentflow/gate-table.ts | "bcdev", | 3 | unreachable | gate leg names |
| scripts/bc-v3-join.ts | import { BCDEV_CLIENT } | 1 | new-arm | import |
| scripts/bc-v3-join.ts | r.backend === BCDEV_CLIENT | 1 | refuse:bc-v3-join-client | a client report is refused on either side |
| scripts/bc-v3-join.ts | a report ran on ${BCDEV_CLIENT} | 1 | refuse:bc-v3-join-client | the refusal text |
| scripts/gift-card-refreeze.ts | "bcdev", | 1 | unreachable | a fixed argument: headless |
| scripts/probe-5cb1.ts | no "bcdev" object | 1 | unreachable | an error text |
| scripts/probe-r1-permissions.ts | top-level "bcdev" object | 1 | unreachable | an error text |
| scripts/r371-reach-measure/dep-download.ts | backendKind: "bcdev" | 1 | unreachable | a fixed headless build |
| scripts/r546-bucket.ts | byKey(bcMutants, "bcdev") | 1 | unreachable | a label |
| scripts/r546-bucket.ts | bcReport.backend !== "bcdev" | 1 | refuse:r546-not-bcdev | a client report is already refused |
| scripts/r572-flag-census.ts | { kind: "bcdev" } | 1 | same-as-bcdev | alc's symbol set |
| scripts/r594/compare.ts | oracle.backend !== "bcdev" | 1 | refuse:r594-not-bcdev | a client report is already refused on either side |
| scripts/r668-batch-app-check.ts | {"bcdev":{"password" | 1 | unreachable | a test config |
| scripts/r689-probe/drive.ts | "bcdev", | 1 | unreachable | a fixed argument: headless |
| scripts/r737/reach.ts | { kind: "bcdev" } | 1 | same-as-bcdev | alc's symbol set |
| scripts/r738-probe/drive.ts | "bcdev", | 1 | unreachable | a fixed argument: headless |
| scripts/r740-probe/drive.ts | "bcdev", | 1 | unreachable | a fixed argument: headless |
| scripts/r741-probe/drive.ts | "bcdev", | 1 | unreachable | a fixed argument: headless |
| scripts/refusal-ledger.ts | named?.backend !== "al-runner-v3" | 1 | same-as-bcdev | v3-only tool |
| scripts/refusal-ledger.ts | r.backend !== "al-runner-v3" | 1 | same-as-bcdev | v3-only tool |
| scripts/triage-baseline.ts | "al-runner-v3", | 2 | unreachable | a fixed argument |
| scripts/v3-timing.ts | "al-runner-v3", | 1 | unreachable | a fixed argument |

## Undecided sites

None. Sites the spec does not settle, and what this table chose:
- The report's execution context (`GuiAllowed`, `ClientType`) for a client run is written as assumed, not measured (no driver yet).
- `lethal verify` is headless-only and builds its own backend, so a client run never reaches it. No refusal was added.
- A client run switches no method off (round 3, S5). Company-write methods are refused by name unless `--keep-company-tests`;
  TestPage methods run and are named `client-ran-testpage-unscored`; session-kind-sensitive tests take the client session
  kind. `--tests-only` stays allowed: it drops whole codeunits, so no method inside a kept one is switched off.
- A stage baseline now records the report's backend. A stage with no backend field is read as a headless one.
