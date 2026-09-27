// R289 probe P1 sidecar: polls three calls beside the real itest:hang gate and writes one NDJSON
// line per call. See README.md in this folder and
// docs/superpowers/specs/2026-09-27-r289-probe-precommitment.md section 3 and its ADDENDUM.
//
//   bun scripts/r289-probe/sidecar.ts --container Cronus284 \
//     --config fixtures/sandbox-hang/lethal.config.cronus284.json \
//     --user <sidecar-only BC user> --password <its password> --out <file> \
//     [--stop-file <path>] [--seconds <n>]
//
// The sidecar authenticates as its OWN BC user, never the gate config's: pass --user/--password, or
// --creds <gitignored json file with {"user":..,"password":..}>. It refuses to start if that user
// equals the gate config's bcdev.username. It never runs more than MAX_CONCURRENT requests of its
// own at once (pickProbesToRun below; see sidecar.test.ts). The host check against the gate config
// is unchanged.
//
// It runs until --stop-file exists, --seconds pass, or it is killed. Every line is appended as it
// happens, so a kill loses at most the calls still open.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { odataBaseUrl } from "../../packages/runner/src/cli";
import { actionUrl, arg, call, settingsFor } from "../../repro/nst-wedges/common";
import type { Settings } from "../../repro/nst-wedges/common";

const INTERVAL_MS = 2_000;
const TIMEOUT_MS = 10_000;
export const MAX_CONCURRENT = 2;

interface BcdevConfig {
  server?: string;
  serverInstance?: string;
  username?: string;
  company?: string;
  tenant?: string;
}

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

/**
 * Which idle probes to start this tick, in `names` order starting at `startAt` (round-robin, so a
 * cap tighter than the probe count does not starve the same probe every tick): skip one whose
 * previous call is still open, then fill up to `maxConcurrent` TOTAL in flight (counting `inFlight`
 * already-running calls). The rest wait for a later tick. Pure: no I/O, no clock.
 */
export function pickProbesToRun(
  names: readonly string[],
  open: ReadonlySet<string>,
  inFlight: number,
  maxConcurrent: number,
  startAt = 0,
): string[] {
  const picked: string[] = [];
  let count = inFlight;
  const n = names.length;
  for (let i = 0; i < n; i++) {
    const name = names[(startAt + i) % n];
    if (name === undefined || open.has(name) || count >= maxConcurrent) continue;
    picked.push(name);
    count++;
  }
  return picked;
}

if (import.meta.main) {
  const container = arg("container", "");
  const configPath = arg("config", "");
  const out = arg("out", "");
  const stopFile = arg("stop-file", "");
  const seconds = Number(arg("seconds", "0"));
  const credsPath = arg("creds", "");
  let user = arg("user", "");
  let password = arg("password", "");
  if (container === "" || configPath === "" || out === "") {
    throw new Error(
      "usage: sidecar.ts --container <name> --config <lethal.config.*.json> --out <file> " +
        "--user <sidecar BC user> --password <its password> (or --creds <gitignored json file>)",
    );
  }
  if (credsPath !== "") {
    const creds = JSON.parse(readFileSync(credsPath, "utf8")) as {
      user?: string;
      password?: string;
    };
    if (creds.user !== undefined) user = creds.user;
    if (creds.password !== undefined) password = creds.password;
  }
  if (user === "" || password === "") {
    throw new Error(
      "usage: the sidecar needs its OWN BC user, never the gate config's: pass --user/--password " +
        'or --creds <gitignored json file with {"user":..,"password":..}>',
    );
  }

  const bcdev = (JSON.parse(readFileSync(configPath, "utf8")) as { bcdev?: BcdevConfig }).bcdev;
  if (bcdev?.server === undefined || bcdev.serverInstance === undefined) {
    throw new Error(`${configPath}: bcdev.server and bcdev.serverInstance are required`);
  }
  if (bcdev.username !== undefined && bcdev.username === user) {
    throw new Error(
      `refusing: --user ${user} is the gate config's own bcdev.username in ${configPath}; the sidecar must authenticate as a separate BC user`,
    );
  }
  // The same base URL hang.itest.ts builds: odataBaseUrl(server, serverInstance), baseUrl unused.
  const base = odataBaseUrl(bcdev.server, bcdev.serverInstance);
  const host = new URL(base).hostname;
  if (host.toLowerCase() !== container.toLowerCase()) {
    throw new Error(
      `refusing: config ${configPath} points at ${host}, not --container ${container}`,
    );
  }
  const settings: Settings = settingsFor({
    url: base,
    user,
    password,
    ...(bcdev.company !== undefined ? { company: bcdev.company } : {}),
    ...(bcdev.tenant !== undefined ? { tenant: bcdev.tenant } : {}),
  });
  const tenantQuery = `?tenant=${encodeURIComponent(bcdev.tenant ?? "default")}`;

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

  async function action(
    probe: string,
    name: string,
    body: Record<string, unknown>,
  ): Promise<Sample> {
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
  const names = Object.keys(probes);

  write({
    start: Date.now(),
    container,
    config: configPath,
    base,
    sidecarUser: user,
    maxConcurrent: MAX_CONCURRENT,
    renewLeaseUrl: actionUrl(settings, "LethALControl", "RenewLease"),
  });
  const open = new Set<string>();
  const inflight = new Set<Promise<void>>();
  const startedAt = Date.now();
  const done = () =>
    (stopFile !== "" && existsSync(stopFile)) ||
    (seconds > 0 && Date.now() - startedAt >= seconds * 1000);

  let tickIndex = 0;
  while (!done()) {
    const tick = Date.now();
    const toRun = new Set(pickProbesToRun(names, open, open.size, MAX_CONCURRENT, tickIndex));
    tickIndex++;
    for (const [name, run] of Object.entries(probes)) {
      if (open.has(name)) {
        write({ probe: name, sentAt: tick, skipped: "previous still open" });
        continue;
      }
      if (!toRun.has(name)) {
        write({ probe: name, sentAt: tick, skipped: "concurrency cap" });
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
}
