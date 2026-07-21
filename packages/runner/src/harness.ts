import type { ActivationConfig, FetchFn } from "./activation";

/**
 * The `LethAL Control` extension's own app id and the protocol version this client speaks. A
 * session must verify the deployed harness matches BEFORE any execution (spec §8) — running
 * against a missing, wrong-identity, or incompatible control surface would silently corrupt
 * every verdict.
 */
export const CONTROL_APP_ID = "5e7a1c00-1111-4c00-8c00-1e7a1c000701";
const MIN_PROTOCOL_VERSION = 1;

export class HarnessVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessVerificationError";
  }
}

interface HarnessInfo {
  readonly appId?: unknown;
  readonly protocolVersion?: unknown;
  readonly isolationModes?: unknown;
  readonly testTypes?: unknown;
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

  async verify(): Promise<void> {
    const info = await this.fetchHarnessInfo();

    if (info.appId !== CONTROL_APP_ID) {
      throw new HarnessVerificationError(
        `HarnessInfo reported appId ${JSON.stringify(info.appId)}, expected the LethAL Control app ${CONTROL_APP_ID}`,
      );
    }
    // Forward-compatible: a newer harness (5C-B protocol v2, which only adds lease-token
    // validation on top of the same activate+run+clear) still runs a 5C-A client's empty-lease
    // calls. An OLDER/unknown protocol cannot be trusted.
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
        body: "{}",
        signal: controller.signal,
      });
    } catch (err) {
      throw new HarnessVerificationError(`HarnessInfo unreachable: ${String(err)}`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw new HarnessVerificationError(`HarnessInfo failed: HTTP ${res.status}`);
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
