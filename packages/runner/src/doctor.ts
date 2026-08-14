import { describeAlRunnerCache } from "./al-runner-cache";
import type { AlRunnerCacheReport } from "./al-runner-cache";
import { compareAppVersions } from "./app-version";
import { MIN_CONTROL_VERSION } from "./harness";
import type { LeaseSnapshot } from "./harness";

/**
 * R109: `lethal doctor` — a read-only pass over every pre-flight refusal `lethal run` would
 * otherwise discover ONE AT A TIME across several slow round-trips (config load, provision,
 * generate, deploy — each burning real time before the next problem even surfaces). This module
 * runs every check and reports them all at once; it composes existing refusal-producing machinery
 * (imported above, and threaded in via `DoctorDeps` below) rather than reimplementing any of it —
 * see cli.ts's `buildDoctorDeps` for what each dependency closure actually calls.
 *
 * What this does NOT check, and why: the per-file publish ceiling (`publish-ceiling.ts`) needs a
 * generated mutation manifest to have per-file guard counts to consult at all, and baseline test
 * health needs an actual run against the target. Both are genuine gaps, not oversights — a doctor
 * report that implied it checked everything `run` might refuse on would be a worse failure mode
 * than one that says plainly what it left out (see `cli.ts`'s `DOCTOR_NOT_CHECKED` caveat text,
 * printed on every `lethal doctor` invocation).
 *
 * The `lease` check has a history worth keeping. Review round 1 REMOVED it: its wiring had no way
 * to answer "clear" honestly, so it always returned "clear" and could structurally never fail —
 * counted as a pass in a report a user reads specifically to learn whether a lease is stuck. A
 * check that cannot fail is not a weak check, it is a false one. It is back (R110) only because
 * `HarnessInfo` now reports `leaseOwner`/`leaseOpKind`/`leaseExpiresAt` from a read-only accessor
 * on the control app, so the check observes something real. Probing by ACQUIRING is still out of
 * the question here — `TryAcquire` mutates on grant, and every probe in this module is non-mutating
 * by contract.
 */

/** One check's outcome. `detail` is always populated — on success it says what was observed
 *  (never just "ok"), because a doctor report a reader cannot act on without re-deriving the raw
 *  value has failed at the one thing it exists for. */
export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
  readonly ok: boolean;
}

/**
 * The read-only probes `runDoctor` composes into a report. Each is a single async call that
 * RETURNS its raw finding (never throws to signal a normal negative result — "Stopped", a stale
 * version, a missing tool path are all well-formed RETURN values, not exceptions) — mirroring this
 * project's existing split between a well-formed refusal and a transport/contract failure (see
 * e.g. `LeaseUnavailableError`'s doc comment in lease.ts). A THROW is still handled (see `runCheck`
 * below): a genuine transport failure (connection refused, DNS, timeout) is exactly as reportable
 * as a well-formed "not ready" answer, just via the other channel — neither one may abort the rest
 * of the report.
 *
 * Every implementation MUST be non-mutating: no acquire, no publish, no quarantine write, no
 * `ClearActive`. `lethal doctor` exists to be safe to run at any time, including against an
 * environment a real session currently holds.
 */
export interface DoctorDeps {
  /** The reused environment's raw, vendor-worded status (e.g. "Running", "Stopped") — same
   *  read `envTool.requireStatus` consults (env-tool-session.ts); or
   *  `ENV_STATUS_REACHABLE_NO_VENDOR_STATUS` when no vendor status concept applies (a directly-
   *  configured container, or an envTool config with no `requireStatus` declared) — see that
   *  constant's doc comment for why this must be a distinct sentinel, never an invented "Running".
   *
   *  Absent (not merely a dep that throws) for a CREATE-MODE envTool config — final review: there
   *  is no environment to probe yet (it does not exist until `lethal run` provisions one), and the
   *  only "raw signal" a create-mode resolve can produce is an internal placeholder-substitution
   *  error (`{envId}` has no value before creation), which read as a bug in the user's config. An
   *  absent dep is how `runDoctor` skips a check ENTIRELY (see below) rather than reporting a
   *  confusing failure for a question that has no answer yet — `cli.ts`'s `buildDoctorDeps` routes
   *  the reason into a caveat instead. */
  readonly envStatus?: () => Promise<string>;
  /** The local durable quarantine record for this tier: `"clear"` when absent, otherwise its
   *  detail — the same record `runSession`'s quarantine consult (orchestrator.ts) reads via
   *  `QuarantineStore.read`. Absent for a create-mode envTool config — same reasoning as
   *  `envStatus`: there is no tier identity (server/serverInstance) to key a quarantine record on
   *  until a real environment exists. */
  readonly quarantine?: () => Promise<string>;
  /** The deployed `LethAL Control` app's raw reported `semver` (R28's `HarnessInfo.semver`) —
   *  NOT pre-compared; `runDoctor` does that itself against `MIN_CONTROL_VERSION` via the same
   *  `compareAppVersions` `HarnessVerifier.checkControlVersion` uses (harness.ts), so the two
   *  never drift onto different comparison rules. Absent for a create-mode envTool config — same
   *  reasoning as `envStatus`: no control app is published anywhere yet to ask. */
  readonly controlVersion?: () => Promise<string>;
  /** R110: the deployed lease, read WITHOUT taking it (`HarnessVerifier.fetchLease`). Absent for a
   *  create-mode envTool config — same reasoning as `envStatus`: no control app exists to ask yet.
   *
   *  This check was WITHDRAWN once before. Its first implementation had no way to answer honestly,
   *  so it returned `"clear"` unconditionally — a check that could not fail on any input, rendered
   *  as `[ok]`, and confidently green in exactly the stranded-lease scenario the recovery tooling
   *  exists for. It is back only because `HarnessInfo` now reports the holder. */
  readonly lease?: () => Promise<LeaseSnapshot>;
  /** Resolved `alc`/`altool` paths (`defaultAlToolPaths`/`resolveAlToolPaths`, publisher.ts/
   *  cli.ts) — an empty string means "not found". Whether an empty `altool` is a FAILURE depends
   *  on `DoctorConfig.altoolRequired` — see that field. Present in create mode too: resolving a
   *  local compiler/publisher path needs no environment to exist.
   *
   *  ABSENT on an al-runner-only project (R146), and that is measured rather than assumed.
   *  `buildBackend`'s al-runner branch returns before `defaultAlToolPaths`/`resolveAlToolPaths` are
   *  reached at all, and LethAL's own `ArtifactCompiler` is constructed only on the bcdev branch —
   *  al-runner compiles the bundle with its own compiler. Checking `alc` there would fail configs
   *  `lethal run --backend al-runner` accepts, which is the stricter-than-`run` drift R21 and R34
   *  already caught twice. */
  readonly toolPaths?: () => Promise<{ readonly alc: string; readonly altool: string }>;
  /**
   * R146: al-runner's own `--version` probe — `AlRunnerBackend.status()`, the SAME call `runSession`
   * makes before a session starts, which refuses a binary that is not v2 because this adapter's
   * v2-only argv pointed at v1 produces WRONG VERDICTS rather than an error.
   *
   * Present whenever the config declares an `alRunner` section, on an al-runner-only project and on
   * a bcdev project that also names one. Absent otherwise: a config that never mentions al-runner
   * has no binary to ask about, and inventing one to report on would be the opposite of the
   * `lease` lesson two fields up but the same mistake.
   */
  readonly alRunner?: () => Promise<{ readonly ok: boolean; readonly details: string }>;
  /**
   * R131: al-runner's artifact cache, READ. Supplied on every path `buildDoctorDeps` produces —
   * reading a local directory needs no environment to exist — but OPTIONAL on the type since R146,
   * because every other dep is and singling this one out as mandatory was arbitrary rather than
   * meaningful. What stops "all deps optional" becoming "a report of nothing, rendered green" is
   * `runDoctor`'s refusal when the deps produce no checks at all.
   *
   * Its check can never be `ok: false`, and that is a deliberate exception to the lesson `lease`
   * carries three fields above. `lease` shipped as a check that structurally could not fail while
   * CLAIMING a safety property, which is a false green. This one claims nothing: it reports a size
   * and names which builds al-runner will not select again. R131 ruled that deleting from a cache
   * another tool owns is not LethAL's to do, so there is no threshold here that would be a fault.
   */
  readonly alRunnerCache?: () => Promise<AlRunnerCacheReport>;
}

/**
 * Sentinel `DoctorDeps.envStatus()` returns meaning "reachability confirmed, but this backend has
 * no vendor status word to compare" — a directly-configured container (no separate "status"
 * concept at all), or an envTool config with no `requireStatus` declared (R34: "configs that
 * declare no expectation are untouched" — `validateEnvToolConfig`'s own doc comment).
 * `checkEnvironment` treats this as an unconditional pass with an HONEST detail, rather than
 * comparing it against `envReady` (which would either invent a match against a status nothing
 * reported, review round 1's Minor finding, or a false mismatch against a default meant for a
 * different scenario).
 */
export const ENV_STATUS_REACHABLE_NO_VENDOR_STATUS = "reachable (no vendor status reported)";

/**
 * What `runDoctor` itself needs to INTERPRET a raw signal — deliberately NOT a copy of
 * `lethal run`'s config surface. Everything needed to OBTAIN a raw signal (server/instance
 * identity, credentials, resolved tool paths) lives in the closures a caller builds `DoctorDeps`
 * from, built from the SAME validated config `run` uses (`validateBcDevConfig` et al. — see
 * cli.ts's `buildDoctorDeps`), so a config `run` would reject fails doctor's config-building step
 * too rather than silently reporting green on it. Keeping this type this narrow is what makes
 * that possible: there is no second, hand-copied shape here to drift out of sync with `run`'s.
 */
export interface DoctorConfig {
  /**
   * The status a REUSED environment must report before LethAL will use it — same field, same
   * config-driven philosophy as `envTool.requireStatus.equals` (R34, env-tool.ts): LethAL
   * hardcodes no vendor's status vocabulary ("Running"/"Active"/"Started"/…), so a project whose
   * tool reports something else can say so here. Absent means `"Running"`, the common default
   * and the value every fixture and live gate in this repo actually uses. Irrelevant whenever
   * `envStatus()` returns `ENV_STATUS_REACHABLE_NO_VENDOR_STATUS` — see that constant.
   */
  readonly envReady?: string;
  /**
   * Review round 1 (Important): whether a missing `altool` fails the `tool-paths` check. Default
   * `true` (a directly-configured container spawns altool via `ContainerDeployer` — `deployerFor`,
   * cli.ts). An env-tool-configured project publishes through the tool instead and never spawns
   * altool at all (`buildBackend`'s `envToolDeploy !== undefined` branch in cli.ts, and R21's
   * comment there) — `run` does not require it, so doctor must not be stricter than `run` and fail
   * a config `run` accepts. `cli.ts`'s `buildDoctorDeps` derives this from
   * `configFile.envTool !== undefined`.
   */
  readonly altoolRequired?: boolean;
  /** Injected so the lease check's expiry comparison is testable without wall-clock timing —
   *  CLAUDE.md's rule for phase-ordering assertions, applied to a clock. Defaults to now. */
  readonly now?: Date;
}

const DEFAULT_ENV_READY = "Running";
const DEFAULT_ALTOOL_REQUIRED = true;

/** Runs one probe and turns a THROW into the same shape a well-formed negative answer would
 *  produce — the boundary that makes a transport failure in one check unable to take down the
 *  rest of the report (see `DoctorDeps`'s doc comment on the two failure channels). */
async function runCheck(name: string, fn: () => Promise<DoctorCheck>): Promise<DoctorCheck> {
  try {
    return await fn();
  } catch (err) {
    return { name, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

function checkEnvironment(status: string, expected: string): DoctorCheck {
  if (status === ENV_STATUS_REACHABLE_NO_VENDOR_STATUS) {
    return { name: "environment", ok: true, detail: status };
  }
  if (status === expected) {
    return { name: "environment", ok: true, detail: `reports ${JSON.stringify(status)}` };
  }
  return {
    name: "environment",
    ok: false,
    // R34's exact shape (env-tool-session.ts): name what was reported, name what was required,
    // and say what to do about it — LethAL will not start an environment it does not own.
    detail: `reports status ${JSON.stringify(status)}, not ${JSON.stringify(expected)} — LethAL will not start an environment it does not own: start it yourself, wait until it reports ${JSON.stringify(expected)}, then re-run.`,
  };
}

/**
 * R110. A HELD lease is reported as NOT ok, and that is deliberate even though a lease held by a
 * live concurrent session is not a fault: `lethal doctor` is reached for when something is already
 * wrong, and "somebody holds this tier" is the single most useful thing it can say then. The detail
 * carries who, which operation, and whether the lease has already EXPIRED — an expired holder is an
 * orphan and the recovery command is named right there, while a live one usually means "wait".
 *
 * Green requires BOTH halves: no owner AND no operation in flight. Either alone can be true while
 * the tier is genuinely busy — an op marker with no owner is the shape a killed session leaves
 * behind, which is exactly what this exists to surface.
 */
function checkLease(lease: LeaseSnapshot, now: Date): DoctorCheck {
  // `tokenPresent` and `opKind`, NOT `owner`. Measured live on Cronus281 the first time this
  // check ran against a real container: `TryRelease` clears the token, the expiry and the client
  // nonce but deliberately LEAVES `Owner` populated, so a cleanly released lease still names its
  // previous holder — an owner-keyed check reported a perfectly healthy tier as held, right after
  // a green gate. That is the false-alarm direction, and it is as useless as the false-green the
  // withdrawn check had.
  if (!lease.tokenPresent && lease.opKind === "none") {
    const last = lease.owner === "" ? "" : `; last held by ${lease.owner}`;
    return {
      name: "lease",
      ok: true,
      detail: `no lease held (no live token, op kind none${last})`,
    };
  }
  const owner = lease.owner === "" ? "(no owner recorded)" : lease.owner;
  const expiry = Date.parse(lease.expiresAt);
  const expired = !Number.isNaN(expiry) && expiry < now.getTime();
  const when =
    lease.expiresAt === ""
      ? ", no expiry recorded"
      : `, expires ${lease.expiresAt}${expired ? " — ALREADY EXPIRED" : ""}`;
  const advice = expired
    ? "The holder is past its expiry, so this is an orphaned lease: recover it with `lethal force-reset-lease --server <url> --instance <name> --config <path>`."
    : "If no session is actually running, recover it with `lethal force-reset-lease --server <url> --instance <name> --config <path>`.";
  const credential = lease.tokenPresent ? "live token" : "no live token";
  return {
    name: "lease",
    ok: false,
    detail: `held by ${owner} (${credential}, op kind ${lease.opKind}${when}). ${advice}`,
  };
}

function checkQuarantine(state: string): DoctorCheck {
  return state === "clear"
    ? { name: "quarantine", ok: true, detail: "tier is not quarantined" }
    : { name: "quarantine", ok: false, detail: state };
}

/** Reuses `compareAppVersions`/`MIN_CONTROL_VERSION` (R28's actual comparison, harness.ts) rather
 *  than re-deriving "is this version new enough" a second way — see that module's
 *  `checkControlVersion` for the throwing counterpart this mirrors, non-throwing. */
function checkControlVersion(semver: string): DoctorCheck {
  let cmp: number;
  try {
    cmp = compareAppVersions(semver, MIN_CONTROL_VERSION);
  } catch (err) {
    return {
      name: "control-version",
      ok: false,
      detail: `LethAL Control reported an unparseable version ${JSON.stringify(semver)}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return cmp >= 0
    ? { name: "control-version", ok: true, detail: `${semver} (>= ${MIN_CONTROL_VERSION})` }
    : {
        name: "control-version",
        ok: false,
        detail: `${semver} is older than the ${MIN_CONTROL_VERSION} this client requires — rebuild extensions/lethal-control and republish it to this container`,
      };
}

function checkToolPaths(
  paths: { readonly alc: string; readonly altool: string },
  altoolRequired: boolean,
): DoctorCheck {
  const missing = [
    ...(paths.alc === "" ? ["alc"] : []),
    ...(altoolRequired && paths.altool === "" ? ["altool"] : []),
  ];
  if (missing.length > 0) {
    return {
      name: "tool-paths",
      ok: false,
      detail: `missing: ${missing.join(", ")} — install the AL Language VS Code extension, or set bcdev.alcPath/altoolPath`,
    };
  }
  const altoolDetail =
    paths.altool !== "" ? paths.altool : "(not required — env-tool publish route)";
  return {
    name: "tool-paths",
    ok: true,
    detail: `alc: ${paths.alc}, altool: ${altoolDetail}`,
  };
}

/**
 * R146. A straight pass-through of `AlRunnerBackend.status()`, whose `details` already says what was
 * observed on both branches: the version line the binary reported, or the refusal naming what it
 * reported and what this adapter needs. Nothing is re-derived here, so doctor and `runSession`
 * cannot come to different conclusions about the same binary.
 *
 * This check CAN fail, which is what separates it from the withdrawn lease check R110 records. A
 * missing binary fails it, and so does a v1 one — and v1 matters more than "not installed", because
 * this adapter's v2-only argv pointed at v1 produces wrong verdicts rather than an error.
 */
function checkAlRunner(status: { readonly ok: boolean; readonly details: string }): DoctorCheck {
  return { name: "al-runner", ok: status.ok, detail: status.details };
}

/**
 * Runs EVERY AVAILABLE check before reporting — never stops at the first failure. That is the
 * entire point over `lethal run`'s own pre-flight refusals, which each fire (correctly) but one at
 * a time, across however many slow round-trips it takes a user to fix one problem and discover the
 * next. Read-only: nothing here calls a mutating dependency, and nothing here retries a dep that
 * answered — see `DoctorDeps`'s doc comment.
 *
 * "Available" — final review: `envStatus`/`quarantine`/`controlVersion` are each OPTIONAL on
 * `DoctorDeps`, and a check whose dep is absent is skipped entirely (never run, never reported —
 * not even as a failure), for a create-mode envTool config where none of the three has an answer
 * yet (see each dep's own doc comment). `tool-paths` is never conditional — resolving a local
 * `alc`/`altool` path needs no environment to exist, in any mode.
 */
export async function runDoctor(cfg: DoctorConfig, deps: DoctorDeps): Promise<DoctorReport> {
  const envReady = cfg.envReady ?? DEFAULT_ENV_READY;
  const altoolRequired = cfg.altoolRequired ?? DEFAULT_ALTOOL_REQUIRED;
  const { envStatus, quarantine, controlVersion, lease, toolPaths, alRunner, alRunnerCache } = deps;
  const checkPromises: Promise<DoctorCheck>[] = [];
  if (envStatus !== undefined) {
    checkPromises.push(
      runCheck("environment", async () => checkEnvironment(await envStatus(), envReady)),
    );
  }
  if (quarantine !== undefined) {
    checkPromises.push(runCheck("quarantine", async () => checkQuarantine(await quarantine())));
  }
  if (controlVersion !== undefined) {
    checkPromises.push(
      runCheck("control-version", async () => checkControlVersion(await controlVersion())),
    );
  }
  if (lease !== undefined) {
    const now = cfg.now ?? new Date();
    checkPromises.push(runCheck("lease", async () => checkLease(await lease(), now)));
  }
  // R146: FIRST among the local checks, because on an al-runner-only project it is the one that
  // can actually refuse, and a reader scanning the report should meet it before the informational
  // cache line.
  if (alRunner !== undefined) {
    checkPromises.push(runCheck("al-runner", async () => checkAlRunner(await alRunner())));
  }
  if (toolPaths !== undefined) {
    checkPromises.push(
      runCheck("tool-paths", async () => checkToolPaths(await toolPaths(), altoolRequired)),
    );
  }
  if (alRunnerCache !== undefined) {
    // R131 — informational by construction; see `DoctorDeps.alRunnerCache` for why it cannot fail.
    checkPromises.push(
      runCheck("al-runner-cache", async () => ({
        name: "al-runner-cache",
        ok: true,
        detail: describeAlRunnerCache(await alRunnerCache()),
      })),
    );
  }
  // R146. `checks.every(...)` on an empty array is `true`, so a deps object with nothing in it would
  // print "ok: every check passed" having checked nothing at all — empty-vs-empty agreement, this
  // project's signature bug, landing in the one command whose whole job is to say whether things
  // are healthy. Every dep is now optional, so this is reachable by a future config shape rather
  // than being a theoretical guard.
  if (checkPromises.length === 0) {
    throw new Error(
      "runDoctor: the DoctorDeps handed in contain no checks at all, so there is nothing to report. " +
        'An empty report would render as "ok: every check passed" having verified nothing (R146).',
    );
  }
  const checks = await Promise.all(checkPromises);
  return { checks, ok: checks.every((c) => c.ok) };
}
