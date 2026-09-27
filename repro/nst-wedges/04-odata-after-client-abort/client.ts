// Repro 04 client. Fires K slow calls, aborts each one client-side, then checks whether OData still
// answers.
//
//   bun client.ts
//
// Options: --calls 5  --slow-ms 120000  --abort-after-ms 10000  --checks 5  --check-every-ms 60000
import { arg, call, healthy, log, probeHealth, sleep } from "../common";

const SERVICE = "NstRepro04";
const calls = Number(arg("calls", "5"));
const slowMs = Number(arg("slow-ms", "120000"));
const abortAfterMs = Number(arg("abort-after-ms", "10000"));
const checks = Number(arg("checks", "5"));
const checkEveryMs = Number(arg("check-every-ms", "60000"));

const before = await probeHealth(SERVICE);
log({ check: "before", healthy: healthy(before), ...before });

// Each call is aborted by the client while the server is still running it (Slow runs slowMs).
for (let i = 1; i <= calls; i++) {
  const r = await call(SERVICE, "Slow", { ms: slowMs }, abortAfterMs);
  log({ call: i, slowMs, abortAfterMs, ...r });
}

// Then watch whether OData answers, for a while, since the aborted calls may still be running.
for (let c = 1; c <= checks; c++) {
  const h = await probeHealth(SERVICE);
  log({ check: c, healthy: healthy(h), ...h });
  if (c < checks) await sleep(checkEveryMs);
}
process.exit(0);
