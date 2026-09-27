// R289 probe P1 sidecar: polls four calls beside the real itest:hang gate and writes one NDJSON
// line per call. See README.md in this folder and
// docs/superpowers/specs/2026-09-27-r289-probe-precommitment.md section 3.
//
//   bun scripts/r289-probe/sidecar.ts --container Cronus284 \
//     --config fixtures/sandbox-hang/lethal.config.cronus284.json --out <file> \
//     [--stop-file <path>] [--seconds <n>]
//
// It runs until --stop-file exists, --seconds pass, or it is killed. Every line is appended as it
// happens, so a kill loses at most the calls still open.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { odataBaseUrl } from "../../packages/runner/src/cli";
import { actionUrl, arg, call, settingsFor } from "../../repro/nst-wedges/common";
import type { Settings } from "../../repro/nst-wedges/common";

const INTERVAL_MS = 2_000;
const TIMEOUT_MS = 10_000;

const container = arg("container", "");
const configPath = arg("config", "");
const out = arg("out", "");
const stopFile = arg("stop-file", "");
const seconds = Number(arg("seconds", "0"));
if (container === "" || configPath === "" || out === "") {
  throw new Error(
    "usage: sidecar.ts --container <name> --config <lethal.config.*.json> --out <file>",
  );
}

interface BcdevConfig {
  server?: string;
  serverInstance?: string;
  username?: string;
  password?: string;
  company?: string;
  tenant?: string;
}
const bcdev = (JSON.parse(readFileSync(configPath, "utf8")) as { bcdev?: BcdevConfig }).bcdev;
if (bcdev?.server === undefined || bcdev.serverInstance === undefined) {
  throw new Error(`${configPath}: bcdev.server and bcdev.serverInstance are required`);
}
// The same base URL hang.itest.ts builds: odataBaseUrl(server, serverInstance), baseUrl unused.
const base = odataBaseUrl(bcdev.server, bcdev.serverInstance);
const host = new URL(base).hostname;
if (host.toLowerCase() !== container.toLowerCase()) {
  throw new Error(`refusing: config ${configPath} points at ${host}, not --container ${container}`);
}
const settings: Settings = settingsFor({
  url: base,
  user: bcdev.username ?? "",
  password: bcdev.password ?? "",
  ...(bcdev.company !== undefined ? { company: bcdev.company } : {}),
  ...(bcdev.tenant !== undefined ? { tenant: bcdev.tenant } : {}),
});
const tenantQuery = `?tenant=${encodeURIComponent(bcdev.tenant ?? "default")}`;

interface Sample {
  probe: string;
  sentAt: number;
  endAt: number;
  ms: number;
  status?: number;
  error?: string;
  timedOut: boolean;
  value?: string;
}

const write = (obj: Record<string, unknown>) => appendFileSync(out, `${JSON.stringify(obj)}\n`);

async function get(probe: string, url: string): Promise<Sample> {
  const sentAt = Date.now();
  const s: Sample = { probe, sentAt, endAt: 0, ms: 0, timedOut: false };
  try {
    const res = await fetch(url, {
      headers: { authorization: settings.auth, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    s.status = res.status;
    await res.arrayBuffer();
  } catch (err) {
    s.error = String(err);
    s.timedOut = s.error.includes("TimeoutError");
  }
  s.endAt = Date.now();
  s.ms = s.endAt - sentAt;
  return s;
}

async function action(probe: string, name: string, body: Record<string, unknown>): Promise<Sample> {
  const sentAt = Date.now();
  const r = await call(settings, "LethALControl", name, body, TIMEOUT_MS);
  const endAt = Date.now();
  const s: Sample = { probe, sentAt, endAt, ms: endAt - sentAt, timedOut: false };
  if (r.status !== undefined) s.status = r.status;
  if (r.error !== undefined) {
    s.error = r.error;
    s.timedOut = r.error.includes("TimeoutError");
  }
  if (r.value !== undefined) s.value = r.value.slice(0, 200);
  return s;
}

const probes: Record<string, () => Promise<Sample>> = {
  metadata: () => get("metadata", `${settings.baseUrl}/ODataV4/$metadata${tenantQuery}`),
  company: () => get("company", `${settings.baseUrl}/ODataV4/Company${tenantQuery}`),
  registeredArtifact: () =>
    action("registeredArtifact", "RegisteredArtifact", {
      targetAppId: "00000000-0000-0000-0000-000000000000",
    }),
  // TryRenew takes the LC Lease lock and changes nothing on a mismatch: a lock probe.
  renewLease: () =>
    action("renewLease", "RenewLease", {
      epoch: -1,
      token: "r289-probe",
      generation: "r289-probe",
      ttlSeconds: 60,
    }),
};

write({
  start: Date.now(),
  container,
  config: configPath,
  base,
  renewLeaseUrl: actionUrl(settings, "LethALControl", "RenewLease"),
});
const open = new Set<string>();
const inflight = new Set<Promise<void>>();
const startedAt = Date.now();
const done = () =>
  (stopFile !== "" && existsSync(stopFile)) ||
  (seconds > 0 && Date.now() - startedAt >= seconds * 1000);

while (!done()) {
  const tick = Date.now();
  for (const [name, run] of Object.entries(probes)) {
    if (open.has(name)) {
      write({ probe: name, sentAt: tick, skipped: "previous still open" });
      continue;
    }
    open.add(name);
    const p = run().then((s) => {
      open.delete(name);
      write({ ...s });
    });
    inflight.add(p);
    void p.finally(() => inflight.delete(p));
  }
  await Bun.sleep(Math.max(0, tick + INTERVAL_MS - Date.now()));
}
await Promise.all(inflight);
write({ stop: Date.now() });
