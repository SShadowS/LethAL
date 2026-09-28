// Shared settings and health probes for the four repro clients. No LethAL imports.
//
// Nothing is read at import time and there is no default server: every request is built from a
// `Settings` the caller made, so a client cannot quietly probe a server it did not name (R289).
// The clients build theirs with `settingsFromEnv()`:
//   --url or BC_URL  base URL of the server tier, e.g. http://<container>:7048/BC (required)
//   BC_USER          user name (NavUserPassword / basic auth)
//   BC_PASSWORD      password
//   BC_COMPANY       default "CRONUS Danmark A/S"
//   BC_TENANT        default "default"

export interface Settings {
  /** Server tier base URL, no trailing slash, e.g. http://Cronus284:7048/BC */
  baseUrl: string;
  /** The `authorization` header value. */
  auth: string;
  /** `?company=..&tenant=..` */
  query: string;
}

export function settingsFor(opts: {
  url: string;
  user: string;
  password: string;
  company?: string;
  tenant?: string;
}): Settings {
  if (opts.url === "") throw new Error("settingsFor: url is empty");
  if (opts.user === "" || opts.password === "")
    throw new Error("settingsFor: user and password are required");
  const company = opts.company ?? "CRONUS Danmark A/S";
  const tenant = opts.tenant ?? "default";
  return {
    baseUrl: opts.url.replace(/\/+$/, ""),
    auth: `Basic ${Buffer.from(`${opts.user}:${opts.password}`).toString("base64")}`,
    query: `?company=${encodeURIComponent(company)}&tenant=${encodeURIComponent(tenant)}`,
  };
}

/** The repro clients' settings: `--url` or `BC_URL`, and fail when neither is set. */
export function settingsFromEnv(): Settings {
  const url = arg("url", process.env.BC_URL ?? "");
  if (url === "") throw new Error("set --url or BC_URL (no default server)");
  const user = process.env.BC_USER ?? "";
  const password = process.env.BC_PASSWORD ?? "";
  if (user === "" || password === "") throw new Error("set BC_USER and BC_PASSWORD");
  return settingsFor({
    url,
    user,
    password,
    ...(process.env.BC_COMPANY !== undefined ? { company: process.env.BC_COMPANY } : {}),
    ...(process.env.BC_TENANT !== undefined ? { tenant: process.env.BC_TENANT } : {}),
  });
}

/** Full URL of an unbound OData V4 action: <base>/ODataV4/<Service>_<Action>?company=..&tenant=.. */
export const actionUrl = (s: Settings, service: string, action: string) =>
  `${s.baseUrl}/ODataV4/${service}_${action}${s.query}`;

export interface CallOutcome {
  status?: number;
  headersMs?: number;
  ms: number;
  bytes?: number;
  value?: string;
  error?: string;
}

/** POST an action with fetch. `signal` lets a caller abort it; `timeoutMs` bounds it otherwise. */
export async function call(
  s: Settings,
  service: string,
  action: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CallOutcome> {
  const t0 = performance.now();
  const out: CallOutcome = { ms: 0 };
  const signals = [AbortSignal.timeout(timeoutMs), ...(signal !== undefined ? [signal] : [])];
  try {
    const res = await fetch(actionUrl(s, service, action), {
      method: "POST",
      headers: {
        authorization: s.auth,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any(signals),
    });
    out.status = res.status;
    out.headersMs = Math.round(performance.now() - t0);
    const text = await res.text();
    out.bytes = Buffer.byteLength(text);
    try {
      const v = (JSON.parse(text) as { value?: unknown }).value;
      out.value = typeof v === "string" ? v : text.slice(0, 500);
    } catch {
      out.value = text.slice(0, 500);
    }
  } catch (err) {
    out.error = String(err);
  }
  out.ms = Math.round(performance.now() - t0);
  return out;
}

/** The wedge check: $metadata (touches no table) and the app's trivial Ping action, 30 s each. */
export async function probeHealth(
  s: Settings,
  service: string,
): Promise<{ metadata: CallOutcome; ping: CallOutcome }> {
  const t0 = performance.now();
  const metadata: CallOutcome = { ms: 0 };
  try {
    const res = await fetch(`${s.baseUrl}/ODataV4/$metadata${s.query}`, {
      headers: { authorization: s.auth },
      signal: AbortSignal.timeout(30_000),
    });
    metadata.status = res.status;
    metadata.bytes = (await res.arrayBuffer()).byteLength;
  } catch (err) {
    metadata.error = String(err);
  }
  metadata.ms = Math.round(performance.now() - t0);
  const ping = await call(s, service, "Ping", {}, 30_000);
  return { metadata, ping };
}

export const healthy = (h: { metadata: CallOutcome; ping: CallOutcome }) =>
  h.metadata.status === 200 && h.ping.status === 200;

export const log = (obj: Record<string, unknown>) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), ...obj }));

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reads `--name value` from argv, else the default. */
export function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v ?? dflt;
}
