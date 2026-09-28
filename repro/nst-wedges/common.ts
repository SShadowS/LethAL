// Shared settings and health probes for the four repro clients. No LethAL imports.
//
// Settings come from the environment so no credential is ever written into this folder:
//   BC_URL      base URL of the server tier, default http://Cronus28:7048/BC
//   BC_USER     user name (NavUserPassword / basic auth)
//   BC_PASSWORD password
//   BC_COMPANY  default "CRONUS Danmark A/S"
//   BC_TENANT   default "default"

export const BC_URL = (process.env.BC_URL ?? "http://Cronus28:7048/BC").replace(/\/$/, "");
const user = process.env.BC_USER ?? "";
const pass = process.env.BC_PASSWORD ?? "";
if (user === "" || pass === "") throw new Error("set BC_USER and BC_PASSWORD");
export const AUTH = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
const company = process.env.BC_COMPANY ?? "CRONUS Danmark A/S";
const tenant = process.env.BC_TENANT ?? "default";
export const QUERY = `?company=${encodeURIComponent(company)}&tenant=${encodeURIComponent(tenant)}`;

/** Full URL of an unbound OData V4 action: <base>/ODataV4/<Service>_<Action>?company=..&tenant=.. */
export const actionUrl = (service: string, action: string) =>
  `${BC_URL}/ODataV4/${service}_${action}${QUERY}`;

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
    const res = await fetch(actionUrl(service, action), {
      method: "POST",
      headers: {
        authorization: AUTH,
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
  service: string,
): Promise<{ metadata: CallOutcome; ping: CallOutcome }> {
  const t0 = performance.now();
  const metadata: CallOutcome = { ms: 0 };
  try {
    const res = await fetch(`${BC_URL}/ODataV4/$metadata${QUERY}`, {
      headers: { authorization: AUTH },
      signal: AbortSignal.timeout(30_000),
    });
    metadata.status = res.status;
    metadata.bytes = (await res.arrayBuffer()).byteLength;
  } catch (err) {
    metadata.error = String(err);
  }
  metadata.ms = Math.round(performance.now() - t0);
  const ping = await call(service, "Ping", {}, 30_000);
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
