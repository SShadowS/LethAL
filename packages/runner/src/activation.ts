export type FetchFn = typeof fetch;

export interface ActivationConfig {
  readonly baseUrl: string;
  readonly company: string;
  readonly username: string;
  readonly password: string;
  // Verified against a real BC server (2026-07-18): OData Basic-auth calls without a `tenant`
  // query param fail with a generic 401 "user could not be authenticated or authorized" even
  // for a valid username/password — including on this container, which only has one tenant
  // ("default"). Adding `?tenant=default` (or whatever the real tenant is) turns the same
  // request into a 200. bc-dev-mcp's dev-service connection doesn't need this (it defaults
  // to "default" internally for OnPrem — see resolveConnection in bc-dev-mcp), but raw OData
  // calls apparently do.
  readonly tenant?: string;
  // Observed directly against a real BC server (2026-07-18): the OData/web-service pipeline
  // can wedge and stop answering ANY request (even unrelated ones, like a plain entity read)
  // for an extended period, with no HTTP response ever arriving — `fetch()` has no default
  // timeout, so without one this call (and activateWithRetry's single retry) would hang the
  // whole session forever rather than surfacing a retryable/session-aborting error.
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Shapes and sends one authenticated OData POST against the `MutationControl_*` unbound
 * actions/functions on the target BC server — base URL, `company`/`tenant` query params, Basic
 * auth, and a manual abort-based timeout. Shared by `MutationControlClient` (SetActive/
 * ClearActive) and `DeploymentVerifier` (Identity) so this request-shaping exists exactly once.
 */
export async function postOData(
  cfg: ActivationConfig,
  fetchFn: FetchFn,
  action: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const params = new URLSearchParams({ company: cfg.company });
  if (cfg.tenant !== undefined) params.set("tenant", cfg.tenant);
  const url = `${cfg.baseUrl}/ODataV4/MutationControl_${action}?${params.toString()}`;
  // NOTE: AbortSignal.timeout() is unreliable in this Bun/Windows environment — verified
  // directly (2026-07-18): its "abort" event never fired even 20s after a 50ms timeout, in
  // isolation, with nothing else running. A manual AbortController + setTimeout (confirmed
  // working the same way) is used instead.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${cfg.username}:${cfg.password}`)}`,
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`MutationControl_${action} failed: HTTP ${res.status}`);
    return await res.json().catch(() => ({}));
  } finally {
    clearTimeout(timer);
  }
}

export class MutationControlClient {
  constructor(
    private readonly cfg: ActivationConfig,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  private post(action: string, body?: Record<string, unknown>): Promise<unknown> {
    return postOData(this.cfg, this.fetchFn, action, body);
  }

  // The `{ mutantId }` body key (camelCase) is CONFIRMED correct against a real BC server
  // (2026-07-18) — sending the raw AL parameter name instead (`{ MutantId }`, matching
  // `SetActive(MutantId: Text)`'s declaration exactly) gets rejected immediately by OData's
  // parameter binding with "not a valid parameter for the operation", while `mutantId` is
  // accepted and reaches the codeunit. The `{ value: ... }` echo shape could not be fully
  // re-confirmed after that: an earlier client-timed-out call while testing left a lock on
  // the "Mutation Active" table that never cleared, hanging every subsequent call that
  // reaches the codeunit's `Insert`/`Commit` (regardless of parameter name) for the rest of
  // the session — a real BC session artifact, not a code defect (see the integration-fixes
  // report). Left as originally assumed, matching standard OData v4 scalar-action-return
  // convention.
  async setActive(mutantId: string): Promise<void> {
    const payload = (await this.post("SetActive", { mutantId })) as { value?: string };
    if (payload.value !== mutantId) {
      throw new Error(`activation echo mismatch: sent ${mutantId}, got ${String(payload.value)}`);
    }
  }

  async clearActive(): Promise<void> {
    await this.post("ClearActive");
  }
}
