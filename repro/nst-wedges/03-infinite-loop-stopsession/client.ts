// Repro 03 client. Starts the looping call, waits, then ends it with StopSession from a second call.
//
//   bun client.ts --mode hold    # keep the looping request open during the stop (LethAL's normal path)
//   bun client.ts --mode abort   # abort the looping request client-side first, then stop
//
// Options: --budget-ms 20000  --max-ms 120000
//
// Did the session end? Two independent signals:
//   1. hold mode: the held StartLoop request ends with HTTP 408 naming the StopSession call.
//   2. both modes: after the loop's own bound (--max-ms) has passed, LoopState.finished must still be
//      false. true means the loop ran to its bound: the stop did not take.
import { arg, call, healthy, log, probeHealth, settingsFromEnv, sleep } from "../common";

const SERVICE = "NstRepro03";
const settings = settingsFromEnv();
const mode = arg("mode", "abort");
if (mode !== "hold" && mode !== "abort") throw new Error("--mode must be hold or abort");
const budgetMs = Number(arg("budget-ms", "20000"));
const maxMs = Number(arg("max-ms", "120000"));
const runId = crypto.randomUUID();

const t0 = performance.now();
const abort = new AbortController();
const held = call(settings, SERVICE, "StartLoop", { runId, maxMs }, maxMs + 120_000, abort.signal);

// Wait until the looping session has recorded its id under this run's id.
let sessionId = 0;
while (sessionId === 0 && performance.now() - t0 < 30_000) {
  await sleep(500);
  const s = await call(settings, SERVICE, "LoopState", {}, 30_000);
  if (s.value === undefined) continue;
  try {
    const st = JSON.parse(s.value) as { runId?: string; sessionId?: number };
    if (st.runId === runId && typeof st.sessionId === "number") sessionId = st.sessionId;
  } catch {
    log({ loopStateNotJson: s.value.slice(0, 200) });
  }
}
log({ loopSessionId: sessionId });
if (sessionId === 0) {
  log({ abortReason: "looping session never recorded its id" });
  abort.abort();
  process.exit(1);
}

await sleep(Math.max(0, budgetMs - (performance.now() - t0)));
if (mode === "abort") {
  abort.abort();
  log({ clientAborted: true, atMs: Math.round(performance.now() - t0) });
  await sleep(2000);
}

const stop = await call(settings, SERVICE, "StopLoop", { targetSessionId: sessionId }, 60_000);
log({ stop });

if (mode === "hold") {
  const h = await Promise.race([held, sleep(60_000).then(() => undefined)]);
  log({
    heldRequest: h ?? "still open 60 s after StopSession",
    expected: "HTTP 408 naming the StopSession call",
  });
}

// Wait past the loop's own bound, then read Finished.
const waitMs = maxMs + 10_000 - (performance.now() - t0);
if (waitMs > 0) {
  log({
    waitingMs: Math.round(waitMs),
    why: "past the loop's own bound, so Finished tells whether it ran out its clock",
  });
  await sleep(waitMs);
}
const final = await call(settings, SERVICE, "LoopState", {}, 30_000);
log({
  finalState: final.value ?? final.error,
  sessionEnded: final.value?.includes('"finished":false'),
});

const health = await probeHealth(settings, SERVICE);
log({ check: "health", healthy: healthy(health), ...health });
abort.abort();
process.exit(0);
