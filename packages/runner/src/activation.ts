export type FetchFn = typeof fetch;

export interface ActivationConfig {
  readonly baseUrl: string;
  readonly company: string;
  readonly username: string;
  readonly password: string;
}

export class MutationControlClient {
  constructor(
    private readonly cfg: ActivationConfig,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  private async post(action: string, body?: Record<string, unknown>): Promise<unknown> {
    const url = `${this.cfg.baseUrl}/ODataV4/MutationControl_${action}?company=${encodeURIComponent(this.cfg.company)}`;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${this.cfg.username}:${this.cfg.password}`)}`,
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`MutationControl_${action} failed: HTTP ${res.status}`);
    return res.json().catch(() => ({}));
  }

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
