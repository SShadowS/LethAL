import type { ActivationConfig, FetchFn } from "./activation";

/**
 * The `LethAL Control` extension's own app id and the protocol version this client speaks. A
 * session must verify the deployed harness matches BEFORE any execution (spec §8) — running
 * against a missing, wrong-identity, or incompatible control surface would silently corrupt
 * every verdict.
 */
export const CONTROL_APP_ID = "5e7a1c00-1111-4c00-8c00-1e7a1c000701";
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

export class HarnessVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessVerificationError";
  }
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
  readonly protocolVersion?: unknown;
  readonly serverGeneration?: unknown;
  readonly tenantCountReachable?: unknown;
  readonly tenantCount?: unknown;
  readonly isolationModes?: unknown;
  readonly testTypes?: unknown;
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
 * Verifies the deployed `LethAL Control` harness via its `HarnessInfo` OData action before any
 * execution: the expected control app id, a compatible protocol version, and the isolation
 * mode / test type 5C-A relies on (Codeunit isolation, codeunit tests). Anything missing,
 * unreachable, or incompatible fails the session LOUDLY (spec §8) — never a silent degrade to
 * running against an unverified surface.
 */
export class HarnessVerifier {
  constructor(
    private readonly cfg: ActivationConfig,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  async verify(): Promise<HarnessDetails> {
    const info = await this.fetchHarnessInfo();

    if (info.appId !== CONTROL_APP_ID) {
      throw new HarnessVerificationError(
        `HarnessInfo reported appId ${JSON.stringify(info.appId)}, expected the LethAL Control app ${CONTROL_APP_ID}`,
      );
    }
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

  private async fetchHarnessInfo(): Promise<HarnessInfo> {
    const params = new URLSearchParams({ company: this.cfg.company });
    if (this.cfg.tenant !== undefined) params.set("tenant", this.cfg.tenant);
    const url = `${this.cfg.baseUrl}/ODataV4/LethALControl_HarnessInfo?${params.toString()}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? 30_000);
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
        signal: controller.signal,
      });
    } catch (err) {
      throw new HarnessVerificationError(`HarnessInfo unreachable: ${String(err)}`);
    } finally {
      clearTimeout(timer);
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
      if (isStaleControlAppRejection(res.status, bodyText)) {
        throw new HarnessVerificationError(
          `HarnessInfo failed: HTTP ${res.status}: ${bodyText}\nThis looks like a STALE locally-built lethal-control.app, not a protocol bug: extensions/lethal-control/lethal-control.app is gitignored (every machine builds its own), and a build older than its AL source still publishes and still answers HarnessInfo — it just rejects the newer 'clientProtocol' argument this client sends, because BC validates the request shape against the OLD action signature before HarnessInfo's own logic runs. Fix: rebuild extensions/lethal-control and republish it.`,
        );
      }
      throw new HarnessVerificationError(
        `HarnessInfo failed: HTTP ${res.status}${bodyText ? `: ${bodyText}` : ""}`,
      );
    }
    let value: unknown;
    try {
      value = ((await res.json()) as { value?: unknown }).value;
    } catch {
      value = undefined;
    }
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

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
