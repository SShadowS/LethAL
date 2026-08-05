import { compareAppVersions } from "./app-version";
import { MIN_CONTROL_VERSION } from "./harness";

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
 * RETURNS its raw finding (never throws to signal a normal negative result — "Stopped", "held by
 * X", a stale version, a missing tool path are all well-formed RETURN values, not exceptions) —
 * mirroring this project's existing split between a well-formed refusal and a transport/contract
 * failure (see e.g. `LeaseUnavailableError`'s doc comment in lease.ts). A THROW is still handled
 * (see `runCheck` below): a genuine transport failure (connection refused, DNS, timeout) is
 * exactly as reportable as a well-formed "not ready" answer, just via the other channel — neither
 * one may abort the rest of the report.
 *
 * Every implementation MUST be non-mutating: no acquire, no publish, no quarantine write, no
 * `ClearActive`. `lethal doctor` exists to be safe to run at any time, including against an
 * environment a real session currently holds.
 */
export interface DoctorDeps {
  /** The reused environment's raw, vendor-worded status (e.g. "Running", "Stopped") — same
   *  read `envTool.requireStatus` consults (env-tool-session.ts), or an equivalent reachability
   *  read for a directly-configured container. */
  readonly envStatus: () => Promise<string>;
  /** The machine-global lease/op-marker's raw state: `"clear"` when nothing is held, otherwise a
   *  string naming what is (a holder, an in-flight op). See cli.ts's `buildDoctorDeps` for the
   *  honest limitation: today's control app exposes no read-only peek at this, so the real
   *  wiring reports what it can prove without acquiring. */
  readonly leaseState: () => Promise<string>;
  /** The local durable quarantine record for this tier: `"clear"` when absent, otherwise its
   *  detail — the same record `runSession`'s quarantine consult (orchestrator.ts) reads via
   *  `QuarantineStore.read`. */
  readonly quarantine: () => Promise<string>;
  /** The deployed `LethAL Control` app's raw reported `semver` (R28's `HarnessInfo.semver`) —
   *  NOT pre-compared; `runDoctor` does that itself against `MIN_CONTROL_VERSION` via the same
   *  `compareAppVersions` `HarnessVerifier.checkControlVersion` uses (harness.ts), so the two
   *  never drift onto different comparison rules. */
  readonly controlVersion: () => Promise<string>;
  /** Resolved `alc`/`altool` paths (`defaultAlToolPaths`/`resolveAlToolPaths`, publisher.ts/
   *  cli.ts) — an empty string means "not found". */
  readonly toolPaths: () => Promise<{ readonly alc: string; readonly altool: string }>;
}

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
   * and the value every fixture and live gate in this repo actually uses.
   */
  readonly envReady?: string;
}

const DEFAULT_ENV_READY = "Running";

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

function checkLease(state: string): DoctorCheck {
  // "clear" means "no LOCAL evidence of a problem", never "verified clear" — see `DoctorDeps`'s
  // doc comment: no read-only peek at the machine-global lease/op-marker row exists today, and
  // doctor must not acquire one just to check. Said here, not only in a caveat elsewhere, so a
  // reader who sees only this one line still gets the honest claim.
  return state === "clear"
    ? { name: "lease", ok: true, detail: "no local evidence of a held lease/op-marker" }
    : { name: "lease", ok: false, detail: state };
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

function checkToolPaths(paths: { readonly alc: string; readonly altool: string }): DoctorCheck {
  const missing = [
    ...(paths.alc === "" ? ["alc"] : []),
    ...(paths.altool === "" ? ["altool"] : []),
  ];
  return missing.length === 0
    ? { name: "tool-paths", ok: true, detail: `alc: ${paths.alc}, altool: ${paths.altool}` }
    : {
        name: "tool-paths",
        ok: false,
        detail: `missing: ${missing.join(", ")} — install the AL Language VS Code extension, or set bcdev.alcPath/altoolPath`,
      };
}

/**
 * Runs EVERY check before reporting — never stops at the first failure. That is the entire point
 * over `lethal run`'s own pre-flight refusals, which each fire (correctly) but one at a time,
 * across however many slow round-trips it takes a user to fix one problem and discover the next.
 * Read-only: nothing here calls a mutating dependency, and nothing here retries a dep that
 * answered — see `DoctorDeps`'s doc comment.
 */
export async function runDoctor(cfg: DoctorConfig, deps: DoctorDeps): Promise<DoctorReport> {
  const envReady = cfg.envReady ?? DEFAULT_ENV_READY;
  const checks = await Promise.all([
    runCheck("environment", async () => checkEnvironment(await deps.envStatus(), envReady)),
    runCheck("lease", async () => checkLease(await deps.leaseState())),
    runCheck("quarantine", async () => checkQuarantine(await deps.quarantine())),
    runCheck("control-version", async () => checkControlVersion(await deps.controlVersion())),
    runCheck("tool-paths", async () => checkToolPaths(await deps.toolPaths())),
  ]);
  return { checks, ok: checks.every((c) => c.ok) };
}
