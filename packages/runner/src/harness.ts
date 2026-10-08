import type { ActivationConfig, FetchFn } from "./activation";
import { compareAppVersions } from "./app-version";
import { BcAnswerUnreadError, bcFetch, readJsonBody, withDeadline } from "./bc-fetch";

/**
 * The `LethAL Control` extension's own app id and the protocol version this client speaks. A
 * session must verify the deployed harness matches BEFORE any execution (spec §8) — running
 * against a missing, wrong-identity, or incompatible control surface would silently corrupt
 * every verdict.
 */
export const CONTROL_APP_ID = "5e7a1c00-1111-4c00-8c00-1e7a1c000701";

/**
 * Returns a copy of `appJson` with the `LethAL Control` app declared as a dependency, adding it
 * only if absent. The delegating selector `schemata/project.ts` writes into every instrumented
 * target always references `Codeunit "LC Control State"` (`schemata/selector.ts`'s doc comment),
 * which `alc` resolves by unqualified name across a declared dependency on this app — never
 * implied merely by the symbol's presence in the package cache. Every caller that compiles an
 * instrumented target from outside the shared, dependency-free `instrumentedDir`
 * (`BcDevMcpBackend.stageForCompile`'s throwaway sibling copy; `scripts/campaign/compile-only.ts`'s
 * own private temp dir) needs this same injection, so it lives here as the one place both agree
 * with.
 *
 * The `id`/`some` guard is idempotent: re-running this against an app.json that already declares
 * the dependency (a re-staged copy, or a caller's app.json that already lists it by hand) must
 * not append a second copy — `alc` treats two dependency entries for the same app id as a real
 * conflict, not a harmless duplicate.
 *
 * `version: "1.0.0.0"` is a FLOOR, not a pin: AL resolves a dependency's declared version as a
 * minimum the actual symbol package must meet or exceed, so this stays below every real `LethAL
 * Control` build (`MIN_CONTROL_VERSION` above tracks the actual minimum this client accepts at
 * runtime — a separate, stricter check made against the deployed harness, not against `alc`).
 */
export function injectControlDependency(
  appJson: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const deps = Array.isArray(appJson.dependencies)
    ? (appJson.dependencies as ReadonlyArray<Record<string, unknown>>)
    : [];
  if (deps.some((d) => d.id === CONTROL_APP_ID)) {
    return { ...appJson, dependencies: deps };
  }
  return {
    ...appJson,
    dependencies: [
      ...deps,
      { id: CONTROL_APP_ID, name: "LethAL Control", publisher: "LethAL", version: "1.0.0.0" },
    ],
  };
}

/**
 * Layer 5C-B1 (design §7): protocol v2 is incompatible BY CONSTRUCTION in both directions.
 * `HarnessInfo` takes a REQUIRED `clientProtocol` argument on the v2 server, so a v1 client
 * (which posts `{}`) cannot reach a valid v2 payload at all; and this client refuses any
 * `protocolVersion < 2`, so a v2 client cannot run against a v1 server. Both failures land
 * before any publish, because `verify()` is required and unconditional at the top of
 * `BcDevMcpBackend.deploy()` and again in `runSession`'s lease acquisition.
 */
export const CLIENT_PROTOCOL_VERSION = 2;
const MIN_PROTOCOL_VERSION = 2;

/**
 * R28: the oldest `LethAL Control` BUILD this client will run against, checked against the version
 * the deployed harness reports for ITSELF (`semver`, read from `NavApp.GetCurrentModuleInfo` —
 * see `ControlApi.CurrentAppVersion`).
 *
 * Why this exists when `MIN_PROTOCOL_VERSION` already does: the protocol version only moves when
 * the WIRE CONTRACT breaks, and most staleness does not break it. A control app several builds
 * behind still answers every v2 call correctly, and then fails on whatever it happens to lack —
 * a 404 on an endpoint it never had (the permission canary, measured 2026-07-26), or BC's own
 * "clientProtocol is not a valid parameter" 400 for a build older still. Each of those is a
 * different-looking failure for one cause, which is exactly what R28 was filed for.
 *
 * Kept in LOCKSTEP with `extensions/lethal-control/app.json`'s `version`: raising this constant
 * without bumping that file makes a freshly built control app fail its own gate. Pinned by a test.
 */
export const MIN_CONTROL_VERSION = "1.0.0.20";

/**
 * R20: the harness could not be AUTHENTICATED — HTTP 401/403 — as distinct from "the control app is
 * missing or the wrong build".
 *
 * Extends `Error` DIRECTLY, never `HarnessVerificationError`, and that is the entire point:
 * `env-tool-session` treats a `HarnessVerificationError` as "the control app is missing" and
 * responds by REPUBLISHING it. Republishing runs `LethAL Control`'s install/upgrade codeunits, and
 * the machine-global lease lives in that app's own tables — so a transient 401 against a shared
 * long-lived environment would disturb a concurrent session's lease and serverGeneration to fix a
 * problem a republish cannot fix. `MultiTenantContainerError` is separated from the same catch for
 * the same reason.
 *
 * Plausible trigger, not hypothetical: a freshly created environment whose admin user 401s briefly
 * right after start.
 */
export class HarnessAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessAuthError";
  }
}

export class HarnessVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessVerificationError";
  }
}

/**
 * R433: a request for BC's automation `extensions` list that is not filtered by exactly one app id
 * (a bare GUID). Unfiltered, or filtered by publisher, that list never answered on Cronus28 (BC
 * 28.4, 2026-10-04: the socket closed after about 166 s, three times) and the service tier then
 * stopped answering until an owner restart; by id it answered in 39-49 ms. `fetchApiRows` throws
 * this BEFORE any request is sent. Extends `Error` DIRECTLY, never `HarnessVerificationError`: it is
 * a caller-contract violation inside LethAL, not a statement about the server, and nothing may
 * read it as "the control app is missing".
 */
export class UnfilteredExtensionsQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnfilteredExtensionsQueryError";
  }
}

/** A bare GUID, 8-4-4-4-12 hex digits: no braces, no quotes, no surrounding space. */
const GUID_PATTERN = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const GUID_RE = new RegExp(`^${GUID_PATTERN}$`);
/** The ONLY `$filter` an `extensions` request may carry (R433). JS `$` without the `m` flag matches
 *  only at the very end, so a trailing newline or a second clause does not pass. */
const EXTENSIONS_FILTER_RE = new RegExp(`^id eq ${GUID_PATTERN}$`);

/** Every `%XX` escape replaced by its character, repeated until nothing changes (so `%2565` ends as
 *  `e`). Lenient: a malformed escape stays as written and never throws. */
function decodePercentEscapes(path: string): { text: string; leftover: boolean } {
  let cur = path;
  for (let i = 0; i < 16; i++) {
    const next = cur.replace(/%([0-9a-fA-F]{2})/g, (_m, h: string) =>
      String.fromCharCode(Number.parseInt(h, 16)),
    );
    if (next === cur) return { text: cur, leftover: false };
    cur = next;
  }
  // R438: after the last round, a `%XX` still in the text means it was nested too deep to read.
  return { text: cur, leftover: /%[0-9a-fA-F]{2}/.test(cur) };
}

/** R433: throws unless an `extensions` request is filtered by exactly one GUID. Any path naming
 *  `extensions` in any case counts (an encoded slash included); the path itself may carry no
 *  query or fragment, and the query must be exactly one `$filter: "id eq <GUID>"` plus at most one
 *  `tenant` equal to `tenant`, the configured one. `query` is a LIST (R-441 review): a map would
 *  keep one of two `$filter`s while the URL sends both. */
export function refuseUnfilteredExtensionsQuery(
  path: string,
  query: readonly (readonly [string, string])[],
  tenant: string | undefined,
): void {
  const refuse = (): never => {
    throw new UnfilteredExtensionsQueryError(
      `refusing to send an automation extensions query not filtered by exactly one app id: path ${JSON.stringify(path)}, query ${JSON.stringify(query)}. Only \`$filter=id eq <GUID>\` is allowed — an unfiltered or publisher-filtered extensions list hung BC 28.4 and took the service tier down (R433).`,
    );
  };
  const pathDecoded = decodePercentEscapes(path);
  const decoded = pathDecoded.text;
  const queryDecoded = query.flatMap(([k, v]) => [
    decodePercentEscapes(k),
    decodePercentEscapes(v),
  ]);
  // R438: text still encoded after the last round cannot be read, so it is refused.
  if ([pathDecoded, ...queryDecoded].some((p) => p.leftover)) refuse();
  if (!/extensions/i.test(decoded)) {
    // R438: a key or value naming extensions counts on any path, not only on the path itself.
    if (queryDecoded.some((p) => /extensions/i.test(p.text))) refuse();
    return;
  }
  const tenants = query.filter(([k]) => k === "tenant");
  const [only, ...more] = query.filter(([k]) => k !== "tenant");
  const ok =
    !/[?#&]/.test(decoded) &&
    only !== undefined &&
    more.length === 0 &&
    only[0] === "$filter" &&
    EXTENSIONS_FILTER_RE.test(only[1]) &&
    tenants.length <= 1 &&
    tenants.every(([, v]) => v === tenant);
  if (!ok) refuse();
}

/**
 * Design §7's single-tenant gate: app publication is service-instance-wide, so a per-tenant
 * lease cannot fence two tenants publishing to one container — 5C-B1 refuses such a container
 * outright, before any publish. Extends `Error` DIRECTLY (never `HarnessVerificationError`) so
 * `instanceof` can never cross-match the two: this is a supported-configuration refusal, not
 * evidence that the harness itself is missing/incompatible.
 *
 * NOTE (honest scope): today's server reports `tenantCountReachable: false` — AL genuinely
 * cannot enumerate tenants from an extension (see `ControlApi.HarnessInfo`'s doc comment,
 * checked against the System Application 28.0 symbols: codeunit 417 exposes only the CURRENT
 * tenant). This error is therefore only ever thrown by the branch that has a REAL count to
 * judge; when the count is unreachable the gate is reported as unenforced (see
 * `HarnessDetails.tenantGate`) rather than faked into a pass.
 */
export class MultiTenantContainerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MultiTenantContainerError";
  }
}

/**
 * R2: the single-tenant gate's "unenforced" warning used to print on EVERY `verify()` call — a
 * single gate run calls it four times (deploy, lease acquire, and again per worker/session step),
 * which trains a reader to scroll past it. Module-scope, not per-instance: a fresh
 * `HarnessVerifier` is constructed at several of those call sites, so an instance-level flag
 * would not have deduplicated across them. Deliberately process-lifetime, never reset — the text
 * itself is unchanged, only how often it prints.
 */
let singleTenantWarningPrinted = false;

/**
 * Test-only: resets the once-per-process latch so each test starts from a clean slate. No
 * production caller ever calls this — the entire point of the latch is that it stays flipped for
 * the life of the process.
 */
export function resetSingleTenantWarningForTests(): void {
  singleTenantWarningPrinted = false;
}

/**
 * R25: `extensions/lethal-control/lethal-control.app` is gitignored, so it is a LOCAL build every
 * machine makes for itself. A build older than its AL source still publishes and still answers
 * `HarnessInfo` — it just rejects the newer `clientProtocol` argument this client always sends,
 * because BC's OData layer validates the request shape against the OLD action signature before
 * `HarnessInfo`'s own body ever runs. That surfaces as a generic-looking
 * `HTTP 400: The parameter 'clientProtocol' ... is not a valid parameter for the operation
 * 'LethALControl_HarnessInfo'`, which reads like a protocol/API bug — the real cause is a stale
 * local build. Detected narrowly (400 plus BOTH markers) so an unrelated 400 is never
 * misdiagnosed as this.
 */
function isStaleControlAppRejection(status: number, bodyText: string): boolean {
  return (
    status === 400 && /clientProtocol/i.test(bodyText) && /not a valid parameter/i.test(bodyText)
  );
}

interface HarnessInfo {
  readonly appId?: unknown;
  /** The deployed control app's own four-part version (R28). See `MIN_CONTROL_VERSION`. */
  readonly semver?: unknown;
  readonly protocolVersion?: unknown;
  readonly serverGeneration?: unknown;
  readonly tenantCountReachable?: unknown;
  readonly tenantCount?: unknown;
  readonly isolationModes?: unknown;
  readonly testTypes?: unknown;
  /** R110's read-only lease peek. Absent on any control app older than 1.0.0.15. */
  readonly leaseOwner?: unknown;
  readonly leaseOpKind?: unknown;
  readonly leaseExpiresAt?: unknown;
  readonly leaseTokenPresent?: unknown;
}

/**
 * R110: who holds the machine-global lease, read WITHOUT taking it.
 *
 * `TryAcquire` mutates on grant (epoch++, token, `Commit`), so probing by acquiring was never an
 * option for a read-only caller — and `HarnessInfo` returned no holder, op kind or expiry at all.
 * The measured consequence: `lethal doctor` could not check the lease, and its first
 * implementation shipped a `lease` check hardcoded to "clear" — a check that could not fail on any
 * input, rendered as `[ok]`, and confidently green in exactly the stranded-lease scenario the
 * recovery tooling exists for. It was withdrawn into doctor's "not checked" list rather than
 * shipped.
 */
export interface LeaseSnapshot {
  /**
   * Who holds it — or who LAST held it. **Not a held-or-not signal**, measured live on Cronus281:
   * `TryRelease` clears the token, the expiry and the client nonce but deliberately leaves `Owner`
   * populated, so a cleanly released lease still names its previous holder. Reading a non-empty
   * owner as "held" reports every healthy container as stuck, forever.
   */
  readonly owner: string;
  /** Whether a live lease credential exists. This, with `opKind`, is what actually answers "is
   *  this tier held?". The token ITSELF is never transmitted — handing out the lease credential
   *  would let any caller impersonate the holder. */
  readonly tokenPresent: boolean;
  /** `none` / `publish` / `run` — the option's own member names, formatted by AL. */
  readonly opKind: string;
  /** ISO-8601, or empty when the field is unset. Empty is NOT "expired": it is "no instant
   *  recorded", and the two must not collapse. */
  readonly expiresAt: string;
}

/**
 * What a successful `verify()` learned. Returned (rather than discarded) because two of these
 * facts are load-bearing elsewhere:
 *   - `serverGeneration` is the ONLY value `AcquireLease` accepts as `expectedGeneration`
 *     (design §4 step 1 refuses any mismatch as `generation-changed`), and no other endpoint
 *     returns it unless an acquire is already GRANTED — so a session must read it here, before
 *     it can acquire at all.
 *   - `tenantGate` records whether design §7's single-tenant check was actually ENFORCED
 *     ("enforced") or could not be evaluated ("unenforced") — never silently conflated.
 */
export interface HarnessDetails {
  readonly protocolVersion: number;
  readonly serverGeneration: string;
  readonly tenantGate: "enforced" | "unenforced";
}

/**
 * Parses R110's lease fields out of a raw `HarnessInfo` body.
 *
 * Refuses rather than defaulting. A control app older than `MIN_CONTROL_VERSION` does not carry
 * these fields, and substituting `""` for a missing `leaseOwner` would render as "nothing holds
 * the lease" — which is the exact false-green the withdrawn doctor check was withdrawn for,
 * rebuilt one layer down.
 */
export function parseLeaseSnapshot(info: {
  readonly leaseOwner?: unknown;
  readonly leaseOpKind?: unknown;
  readonly leaseExpiresAt?: unknown;
  readonly leaseTokenPresent?: unknown;
}): LeaseSnapshot {
  const { leaseOwner, leaseOpKind, leaseExpiresAt, leaseTokenPresent } = info;
  if (
    typeof leaseOwner !== "string" ||
    typeof leaseOpKind !== "string" ||
    typeof leaseExpiresAt !== "string" ||
    typeof leaseTokenPresent !== "boolean"
  ) {
    throw new HarnessVerificationError(
      `HarnessInfo did not report the lease (leaseOwner ${JSON.stringify(leaseOwner)}, leaseOpKind ${JSON.stringify(leaseOpKind)}, leaseExpiresAt ${JSON.stringify(leaseExpiresAt)}) — the read-only lease peek needs LethAL Control ${MIN_CONTROL_VERSION} or newer (R110). Fix: rebuild extensions/lethal-control and republish it to this container.`,
    );
  }
  if (leaseOpKind === "") {
    throw new HarnessVerificationError(
      "HarnessInfo reported an EMPTY leaseOpKind — the option always formats to one of none/publish/run, so an empty value means the field was not populated rather than that no operation is in flight",
    );
  }
  return {
    owner: leaseOwner,
    opKind: leaseOpKind,
    expiresAt: leaseExpiresAt,
    tokenPresent: leaseTokenPresent,
  };
}

/**
 * Verifies the deployed `LethAL Control` harness via its `HarnessInfo` OData action before any
 * execution: the expected control app id, a compatible protocol version, and the isolation
 * mode / test type 5C-A relies on (Codeunit isolation, codeunit tests). Anything missing,
 * unreachable, or incompatible fails the session LOUDLY (spec §8) — never a silent degrade to
 * running against an unverified surface.
 */
export class HarnessVerifier {
  constructor(
    private readonly cfg: ActivationConfig,
    private readonly fetchFn: FetchFn = bcFetch,
  ) {}

  /**
   * R109: reads the deployed control app's raw `semver`, WITHOUT `verify()`'s other gates
   * (appId identity, protocol version, isolation/test-type capabilities, the single-tenant
   * check) — `lethal doctor`'s control-version check reports that ONE concern independently, so
   * an appId mismatch or a tenant-gate warning does not get folded into "control-version" under a
   * name that would mislead a reader about which of several unrelated things is actually wrong.
   * Reuses `fetchHarnessInfo()` (the same OData call and error handling `verify()` itself uses —
   * stale-build detection, auth-vs-missing distinction, all of it) rather than a second HTTP call
   * with its own, possibly-drifted error handling.
   */
  async fetchControlVersion(): Promise<string> {
    const info = await this.fetchHarnessInfo();
    if (typeof info.semver !== "string" || info.semver === "") {
      throw new HarnessVerificationError(
        `HarnessInfo did not report a LethAL Control version (semver ${JSON.stringify(info.semver)}) — protocol v2 must report the deployed control app's own version, as a string, so a stale build can be dated (this client requires ${MIN_CONTROL_VERSION}). Fix: rebuild extensions/lethal-control and republish it to this container.`,
      );
    }
    return info.semver;
  }

  /**
   * R109 review round 1 (Minor): pure reachability — calls `fetchHarnessInfo()` and discards the
   * parsed result entirely, reusing its transport/error handling (auth-vs-missing, stale-build
   * detection) without interpreting the response CONTENT at all. `lethal doctor`'s environment
   * check uses this for a directly-configured container, which has no separate "status" concept
   * of its own — HarnessInfo answering IS the readiness signal there. Deliberately narrower than
   * both `verify()` (appId/protocol/isolation/tenant gates) and `fetchControlVersion()` (semver
   * presence): a response missing any of those would otherwise surface under the name
   * "environment", mis-attributing a different check's concern — the same failure class
   * `fetchControlVersion()` was added to avoid for control-version specifically.
   */
  async checkReachable(): Promise<void> {
    await this.fetchHarnessInfo();
  }

  /**
   * R110: the lease, read WITHOUT taking it. Reuses `fetchHarnessInfo()` — the same OData call and
   * the same auth-vs-missing / stale-build error handling `verify()` and `fetchControlVersion()`
   * use — rather than a second HTTP path with its own, possibly-drifted handling, for the same
   * reason `fetchControlVersion` was written that way.
   *
   * Reports ONE concern, like `fetchControlVersion` and unlike `verify()`: an appId mismatch or a
   * tenant-gate warning must not be folded into a check named "lease".
   */
  async fetchLease(): Promise<LeaseSnapshot> {
    return parseLeaseSnapshot(await this.fetchHarnessInfo());
  }

  /**
   * R195: the company names this server reports, from BC's own `api/v2.0/companies`. Read-only,
   * and independent of the control app: it answers on a server where LethAL Control was never
   * published, which is what lets `lethal doctor` say "the company you named does not exist,
   * these do" BEFORE the control-version check fails with BC's 404 for the same reason. Measured
   * 2026-09-02: a config named `CRONUS Danmark A/S` against a sandbox holding `CRONUS UK Ltd.`, and
   * the operator found the real names by calling exactly this endpoint by hand.
   *
   * The company parameter is deliberately NOT sent: this endpoint lists across companies, and
   * sending a company that does not exist would fail the very call meant to say so.
   */
  async fetchCompanies(): Promise<readonly string[]> {
    const names: string[] = [];
    for (const row of await this.fetchApiRows("api/v2.0/companies", "companies list")) {
      const name = (row as { name?: unknown }).name;
      if (typeof name !== "string") {
        throw new HarnessVerificationError(
          `companies list returned a row without a string \`name\`: ${JSON.stringify(row).slice(0, 200)}`,
        );
      }
      names.push(name);
    }
    return names;
  }

  /**
   * Issue #23: whether an app id is INSTALLED in the configured company, from BC's automation API
   * (`companies(<id>)/extensions`). Measured 2026-09-25 on Cronus283 (BC 28.4): the filter by app
   * id returns one row per published version with `isInstalled`, and `[]` for an id that is not
   * published. A published-but-uninstalled row counts as absent, since tests cannot run from it.
   * Read-only; the company id comes from the same companies list `fetchCompanies` reads.
   */
  async fetchExtensionInstalled(appId: string): Promise<{
    readonly installed: boolean;
    readonly versions: readonly string[];
  }> {
    const rows = await this.fetchExtensionRows(appId);
    return {
      installed: rows.some((r) => r.isInstalled === true),
      versions: rows.map(
        (r) =>
          `${r.versionMajor}.${r.versionMinor}.${r.versionBuild}.${r.versionRevision}${r.isInstalled === true ? "" : " (published, not installed)"}`,
      ),
    };
  }

  /**
   * R-385: the versions of `appId`'s INSTALLED rows in the configured company, read by id (R433).
   * A published-but-not-installed row is left out: tests cannot run from it. Usually one version;
   * the caller decides what none or two mean. A row whose `isInstalled` is not a boolean, or whose
   * version parts are not numbers, throws: an unreadable row must not read as "not installed".
   */
  async fetchInstalledVersions(appId: string): Promise<readonly string[]> {
    const out: string[] = [];
    for (const r of await this.fetchExtensionRows(appId)) {
      const parts = [r.versionMajor, r.versionMinor, r.versionBuild, r.versionRevision];
      if (typeof r.isInstalled !== "boolean" || !parts.every((p) => typeof p === "number")) {
        throw new HarnessVerificationError(
          `extensions list returned a malformed row for app ${appId}: ${JSON.stringify(r).slice(0, 200)}`,
        );
      }
      if (r.isInstalled) out.push(parts.join("."));
    }
    return out;
  }

  /** The configured company's id, looked up once per verifier (only a found id is kept). */
  private companyId: string | undefined;

  /**
   * R433: the ONLY code that builds the automation `extensions` path. It refuses an `appId` that is
   * not a bare GUID before any request, and always sends `$filter=id eq <guid>`; `fetchApiRows`
   * refuses anything else again, at run time.
   */
  private async fetchExtensionRows(appId: string): Promise<
    readonly {
      isInstalled?: unknown;
      versionMajor?: unknown;
      versionMinor?: unknown;
      versionBuild?: unknown;
      versionRevision?: unknown;
    }[]
  > {
    if (!GUID_RE.test(appId)) {
      throw new HarnessVerificationError(
        `app id ${JSON.stringify(appId)} is not a GUID; the extensions list is read only by one app id (R433)`,
      );
    }
    if (this.companyId === undefined) {
      const companies = await this.fetchApiRows("api/v2.0/companies", "companies list");
      const wanted = this.cfg.company.trim().toLowerCase();
      const company = companies.find(
        (r) =>
          String((r as { name?: unknown }).name)
            .trim()
            .toLowerCase() === wanted,
      ) as { id?: unknown } | undefined;
      if (typeof company?.id !== "string") {
        throw new HarnessVerificationError(
          `company ${JSON.stringify(this.cfg.company)} is not in this server's companies list`,
        );
      }
      this.companyId = company.id;
    }
    return (await this.fetchApiRows(
      `api/microsoft/automation/v2.0/companies(${this.companyId})/extensions`,
      "extensions list",
      { $filter: `id eq ${appId}` },
    )) as readonly {
      isInstalled?: unknown;
      versionMajor?: unknown;
      versionMinor?: unknown;
      versionBuild?: unknown;
      versionRevision?: unknown;
    }[];
  }

  /** One GET against a BC API list endpoint, returning its `value` rows. The company parameter is
   *  never sent: these endpoints address the company in the path, or list across companies.
   *  R506: the bound spans the headers AND the body; an unread body throws, never an empty value. */
  private fetchApiRows(
    path: string,
    what: string,
    extra: Readonly<Record<string, string>> = {},
  ): Promise<readonly unknown[]> {
    const ms = this.cfg.timeoutMs ?? 30_000;
    return withDeadline(
      ms,
      what,
      (signal) => this.readApiRows(path, what, extra, signal, ms),
      (m, kind) => new BcAnswerUnreadError(m, kind),
    );
  }

  private async readApiRows(
    path: string,
    what: string,
    extra: Readonly<Record<string, string>>,
    signal: AbortSignal,
    ms: number,
  ): Promise<readonly unknown[]> {
    // R433: before the URL is built, so a refused query never reaches the network.
    // `extra` comes from a caller, so no tenant is allowed in it: the configured one is added below.
    refuseUnfilteredExtensionsQuery(path, Object.entries(extra), undefined);
    const params = new URLSearchParams(extra);
    if (this.cfg.tenant !== undefined) params.set("tenant", this.cfg.tenant);
    const query = params.size > 0 ? `?${params.toString()}` : "";
    // R441: fetch's URL parser drops tab, CR and LF, so check the parsed URL and send exactly that.
    const sent = new URL(`${this.cfg.baseUrl}/${path}${query}`);
    refuseUnfilteredExtensionsQuery(sent.pathname, [...sent.searchParams], this.cfg.tenant);
    const url = sent.href;
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: "GET",
        headers: {
          authorization: `Basic ${btoa(`${this.cfg.username}:${this.cfg.password}`)}`,
          accept: "application/json",
        },
        // R-496 review: a followed redirect would send a request the guard above never saw.
        redirect: "manual",
        signal,
      });
    } catch (err) {
      if (err instanceof UnfilteredExtensionsQueryError) throw err;
      // R506: our own abort is a timeout, never "unreachable".
      if (signal.aborted) {
        throw new BcAnswerUnreadError(
          `${what} gave no answer within ${ms} ms: ${String(err)}`,
          "timeout",
        );
      }
      throw new HarnessVerificationError(`${what} unreachable: ${String(err)}`);
    }
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      // Never followed. A destination the guard refuses throws the guard's own error, so it
      // propagates like any refused extensions query; any other redirect fails as a transport error.
      const location = res.headers.get("location");
      if (location !== null) {
        const dest = new URL(location, sent);
        refuseUnfilteredExtensionsQuery(dest.pathname, [...dest.searchParams], this.cfg.tenant);
      }
      throw new HarnessVerificationError(
        `${what} failed: HTTP ${res.status} redirect to ${JSON.stringify(location)} was not followed; BC API lists are read only at the URL the guard checked (R-496)`,
      );
    }
    if (!res.ok) {
      let bodyText = "";
      try {
        bodyText = await res.text();
      } catch {
        // best-effort, as fetchHarnessInfo does
      }
      if (res.status === 401 || res.status === 403) {
        throw new HarnessAuthError(
          `${what} failed: HTTP ${res.status}${bodyText ? `: ${bodyText}` : ""} — an authentication failure; the request never reached the API.`,
        );
      }
      throw new HarnessVerificationError(
        `${what} failed: HTTP ${res.status}${bodyText ? `: ${bodyText}` : ""}`,
      );
    }
    const value = odataValue(
      await readJsonBody(res, signal, what, ms, (m, kind) => new BcAnswerUnreadError(m, kind)),
    );
    if (!Array.isArray(value)) {
      throw new HarnessVerificationError(`${what} returned no \`value\` array`);
    }
    return value;
  }

  async verify(): Promise<HarnessDetails> {
    const info = await this.fetchHarnessInfo();

    if (info.appId !== CONTROL_APP_ID) {
      throw new HarnessVerificationError(
        `HarnessInfo reported appId ${JSON.stringify(info.appId)}, expected the LethAL Control app ${CONTROL_APP_ID}`,
      );
    }
    // R28: dated BEFORE the capability checks below. A build too old to have an endpoint this
    // client calls passes every one of them and then 404s later, at whichever action happens to
    // need it first — so the version is what turns a scattering of unrelated-looking failures
    // into one statement with one fix.
    this.checkControlVersion(info);
    // Layer 5C-B1 (design §7): v2 or newer only. v1's "forward-compatible, a 5C-A client's
    // empty-lease calls still run" allowance is GONE — a v1 server has no lease fence at all, so
    // every RunMutant this client sends would be unfenced and could interleave with another
    // session's publish. Fails here, before any publish.
    if (typeof info.protocolVersion !== "number" || info.protocolVersion < MIN_PROTOCOL_VERSION) {
      throw new HarnessVerificationError(
        `HarnessInfo protocolVersion ${JSON.stringify(info.protocolVersion)} is below the minimum this client speaks (${MIN_PROTOCOL_VERSION})`,
      );
    }
    if (!asStringArray(info.isolationModes).includes("Codeunit")) {
      throw new HarnessVerificationError(
        `HarnessInfo isolationModes ${JSON.stringify(info.isolationModes)} does not include the required "Codeunit"`,
      );
    }
    if (!asStringArray(info.testTypes).includes("codeunit")) {
      throw new HarnessVerificationError(
        `HarnessInfo testTypes ${JSON.stringify(info.testTypes)} does not include the required "codeunit"`,
      );
    }
    // v2 contract: a 32-hex server generation, minted per NST incarnation. Required — a session
    // cannot acquire the lease without echoing it (design §4), and accepting a missing/blank one
    // here would push an empty-string `expectedGeneration` onto the wire, where it could only
    // ever match an equally-empty stored value (the empty-vs-empty false match this project
    // treats as its signature bug).
    if (typeof info.serverGeneration !== "string" || info.serverGeneration === "") {
      throw new HarnessVerificationError(
        `HarnessInfo serverGeneration ${JSON.stringify(info.serverGeneration)} is missing or empty — protocol v2 must report it (design §4/§7); AcquireLease cannot be fenced without it`,
      );
    }
    return {
      protocolVersion: info.protocolVersion,
      serverGeneration: info.serverGeneration,
      tenantGate: this.checkSingleTenant(info),
    };
  }

  /**
   * R28: refuses a `LethAL Control` build older than this client requires, and refuses just as
   * loudly a payload whose version cannot be read at all.
   *
   * The three outcomes are deliberately distinct, and NONE of them is "probably fine":
   *   - below `MIN_CONTROL_VERSION` — names both versions and the rebuild. A control app built
   *     before R28 reports the hardcoded `'1.0.0.0'` whatever its app.json said, so it lands here
   *     too, which is the point: that literal is precisely the build that could not be dated.
   *   - absent or non-string — the harness did not report a version. That is a caller-contract
   *     violation (protocol v2 must report one), not evidence of a current build, and defaulting
   *     it to "new enough" would restore exactly the blind spot R28 closed.
   *   - present but unparseable — same refusal, different sentence, carrying the parse error so
   *     the operator sees WHAT the server sent rather than being told it was "invalid".
   *
   * Compared with `compareAppVersions`, never `<` on the strings: this client's minimum has a
   * single-digit revision and a real build's is routinely multi-digit, so a string compare would
   * read `"1.0.0.10"` as OLDER than `"1.0.0.7"` and reject the newest builds first.
   */
  private checkControlVersion(info: HarnessInfo): void {
    if (typeof info.semver !== "string" || info.semver === "") {
      throw new HarnessVerificationError(
        `HarnessInfo did not report a LethAL Control version (semver ${JSON.stringify(info.semver)}) — protocol v2 must report the deployed control app's own version, as a string, so a stale build can be dated (this client requires ${MIN_CONTROL_VERSION}). Refusing to assume an unreported version is current. Fix: rebuild extensions/lethal-control and republish it to this container.`,
      );
    }
    let older: boolean;
    try {
      older = compareAppVersions(info.semver, MIN_CONTROL_VERSION) < 0;
    } catch (err) {
      throw new HarnessVerificationError(
        `HarnessInfo reported LethAL Control version ${JSON.stringify(info.semver)}, which is not a parseable BC four-part version (major.minor.build.revision): ${String(err)}. Refusing to treat an unreadable version as new enough — this client requires ${MIN_CONTROL_VERSION}. Fix: rebuild extensions/lethal-control and republish it to this container.`,
      );
    }
    if (older) {
      throw new HarnessVerificationError(
        `The deployed LethAL Control app reports version ${info.semver}, older than the ${MIN_CONTROL_VERSION} this client requires — your control app predates this client. extensions/lethal-control/lethal-control.app is gitignored, so it is a LOCAL build every machine makes for itself and no pull refreshes it. Fix: rebuild extensions/lethal-control and republish it to this container. (A build from before this check reports a hardcoded "1.0.0.0" whatever its app.json says, so that exact value means "older than ${MIN_CONTROL_VERSION}", not necessarily the very first build.)`,
      );
    }
  }

  /**
   * Design §7's pre-publish single-tenant gate, implemented against what the server can actually
   * substantiate — no more.
   *
   * `tenantCountReachable: true` (a hypothetical future server that CAN count tenants): the count
   * is authoritative, so `> 1` refuses the container before any publish, and a non-numeric count
   * alongside a `true` flag is a contract violation and throws.
   *
   * `tenantCountReachable: false` (what the shipped 1.0.0.2 harness reports, and the only value
   * seen live): the gate is NOT enforced and must not pretend otherwise. AL cannot enumerate
   * tenants from an extension at all, so there is nothing here to check — this warns, once per
   * verify, naming the out-of-band command that WOULD enforce it, and reports `"unenforced"` to
   * the caller. Emitting a silent pass would be strictly worse: the whole point of the gate is
   * that publication is service-instance-wide, so a second tenant on the same container is
   * outside this layer's lease entirely.
   */
  private checkSingleTenant(info: HarnessInfo): "enforced" | "unenforced" {
    if (typeof info.tenantCountReachable !== "boolean") {
      throw new HarnessVerificationError(
        `HarnessInfo tenantCountReachable ${JSON.stringify(info.tenantCountReachable)} is not a boolean — protocol v2 must report it (design §7)`,
      );
    }
    if (!info.tenantCountReachable) {
      // R2: print this at most once per process. `verify()` runs several times in a single
      // session (deploy, lease acquire, ...) — measured 2026-07-26: a single gate run printed
      // this four times, which trains a reader to scroll past it rather than act on it.
      if (!singleTenantWarningPrinted) {
        singleTenantWarningPrinted = true;
        console.warn(
          "HarnessVerifier: design §7's single-tenant container gate is NOT ENFORCED — the harness " +
            "reports tenantCountReachable:false (AL cannot enumerate tenants from an extension; " +
            "System Application codeunit 417 exposes only the current tenant). A second tenant " +
            "publishing to this same service instance is NOT fenced by the 5C-B1 lease, because app " +
            "publication is service-instance-wide. Verify single-tenancy out of band before running " +
            "against a shared container: Get-BcContainerTenants / Get-NAVTenant.",
        );
      }
      return "unenforced";
    }
    if (typeof info.tenantCount !== "number") {
      throw new HarnessVerificationError(
        `HarnessInfo reported tenantCountReachable:true but tenantCount ${JSON.stringify(info.tenantCount)} is not a number — refusing to gate a publish on an unreadable count (design §7)`,
      );
    }
    if (info.tenantCount > 1) {
      throw new MultiTenantContainerError(
        `HarnessInfo reports ${info.tenantCount} tenants on this service instance — 5C-B1 refuses a multi-tenant/shared-publication container: app publication is service-instance-wide, so a per-tenant lease cannot fence two tenants publishing to one container (design §7)`,
      );
    }
    return "enforced";
  }

  /** R506: the bound spans the headers AND the body; an unread body throws, never an empty
   *  value. A timeout or an unreadable 2xx is `BcAnswerUnreadError`, never
   *  `HarnessVerificationError`, so it is never read as "the control app is missing". */
  private fetchHarnessInfo(): Promise<HarnessInfo> {
    const ms = this.cfg.timeoutMs ?? 30_000;
    return withDeadline(
      ms,
      "HarnessInfo",
      (signal) => this.readHarnessInfo(signal, ms),
      (m, kind) => new BcAnswerUnreadError(m, kind),
    );
  }

  private async readHarnessInfo(signal: AbortSignal, ms: number): Promise<HarnessInfo> {
    const params = new URLSearchParams({ company: this.cfg.company });
    if (this.cfg.tenant !== undefined) params.set("tenant", this.cfg.tenant);
    const url = `${this.cfg.baseUrl}/ODataV4/LethALControl_HarnessInfo?${params.toString()}`;

    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`${this.cfg.username}:${this.cfg.password}`)}`,
          "content-type": "application/json",
        },
        // design §7: `clientProtocol` is a REQUIRED v2 argument. A v1 client posts `{}` and is
        // refused by the OData layer before HarnessInfo's own check ever runs — that asymmetry
        // is what makes v1↔v2 incompatible by construction, so this key must always be sent.
        body: JSON.stringify({ clientProtocol: CLIENT_PROTOCOL_VERSION }),
        signal,
      });
    } catch (err) {
      // R-496: a redirect to an unfiltered extensions list, refused by `bcFetch`, stays itself.
      if (err instanceof UnfilteredExtensionsQueryError) throw err;
      // R506: our own abort is a timeout, never "unreachable" (which would republish).
      if (signal.aborted) {
        throw new BcAnswerUnreadError(
          `HarnessInfo gave no answer within ${ms} ms: ${String(err)}`,
          "timeout",
        );
      }
      throw new HarnessVerificationError(`HarnessInfo unreachable: ${String(err)}`);
    }
    if (!res.ok) {
      // R25: read the body BEFORE throwing — BC's own rejection text is the only evidence that
      // distinguishes a stale local control-app build from a real protocol/transport failure, and
      // it must never be discarded even when this isn't that specific shape.
      let bodyText = "";
      try {
        bodyText = await res.text();
      } catch {
        // best-effort — fall through with an empty body rather than losing the status entirely
      }
      // R20: checked BEFORE the stale-build shape. A 401/403 says nothing about WHICH build is
      // deployed — the request never reached `HarnessInfo`'s own logic — so it must not be
      // answered by republishing the control app.
      if (res.status === 401 || res.status === 403) {
        throw new HarnessAuthError(
          `HarnessInfo failed: HTTP ${res.status}${bodyText ? `: ${bodyText}` : ""}
This is an AUTHENTICATION failure, not a missing or stale control app: the request was rejected before HarnessInfo ran, so it says nothing about which build is deployed. Check the configured bcdev username/password/tenant and that the user exists on this server. LethAL deliberately does NOT republish the control app for this — republishing runs its install/upgrade codeunits and would disturb a concurrent session's lease.`,
        );
      }
      if (isStaleControlAppRejection(res.status, bodyText)) {
        throw new HarnessVerificationError(
          `HarnessInfo failed: HTTP ${res.status}: ${bodyText}\nThis looks like a STALE locally-built lethal-control.app, not a protocol bug: extensions/lethal-control/lethal-control.app is gitignored (every machine builds its own), and a build older than its AL source still publishes and still answers HarnessInfo — it just rejects the newer 'clientProtocol' argument this client sends, because BC validates the request shape against the OLD action signature before HarnessInfo's own logic runs. Fix: rebuild extensions/lethal-control and republish it.`,
        );
      }
      throw new HarnessVerificationError(
        `HarnessInfo failed: HTTP ${res.status}${bodyText ? `: ${bodyText}` : ""}`,
      );
    }
    const value = odataValue(
      await readJsonBody(
        res,
        signal,
        "HarnessInfo",
        ms,
        (m, kind) => new BcAnswerUnreadError(m, kind),
      ),
    );
    if (typeof value !== "string") {
      throw new HarnessVerificationError("HarnessInfo returned no string `value`");
    }
    try {
      return JSON.parse(value) as HarnessInfo;
    } catch {
      throw new HarnessVerificationError(`HarnessInfo value is not JSON: ${value}`);
    }
  }
}

/** A parsed body's OData `value`, or `undefined` when the body is not an object. */
function odataValue(body: unknown): unknown {
  return typeof body === "object" && body !== null
    ? (body as { value?: unknown }).value
    : undefined;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
