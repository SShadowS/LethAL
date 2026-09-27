// Repro 02 client. One call per run, long timeout, then a wedge check.
//
//   bun client.ts --test OpenPlainPage      # control first: expected to return fast with NotSupportedException
//   bun client.ts --test OpenTriggerPage    # the arm that hung in the incident
//
// Options: --timeout-ms 600000
import { arg, call, healthy, log, probeHealth, settingsFromEnv } from "../common";

const SERVICE = "NstRepro02";
const settings = settingsFromEnv();
const testMethod = arg("test", "OpenTriggerPage");
const timeoutMs = Number(arg("timeout-ms", "600000"));

log({ calling: `${SERVICE}_RunTest`, testMethod, timeoutMs });
const r = await call(settings, SERVICE, "RunTest", { testMethod }, timeoutMs);
const returned = r.status !== undefined && r.error === undefined;
log({ testMethod, returned, ...r });
const health = await probeHealth(settings, SERVICE);
log({ check: "health", healthy: healthy(health), ...health });
log({
  next: "Check the service tier state by hand (see README step 5): Get-Service 'MicrosoftDynamicsNavServer$BC' inside the container. StopPending = the incident state.",
});
process.exit(0);
