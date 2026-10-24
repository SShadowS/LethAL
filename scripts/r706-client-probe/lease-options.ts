import { MAX_TTL_SECONDS } from "../../packages/runner/src/lease";

/**
 * The control-app lease the web-service pass takes: the runner's own bound (MAX_TTL_SECONDS, 15 s)
 * and its ttl/3 heartbeat (orchestrator.ts, design section 6). Refuses a ttl the server would refuse.
 */
export function leaseOptions(ttlSeconds: number = MAX_TTL_SECONDS): {
  ttlSeconds: number;
  heartbeatMs: number;
} {
  if (!(ttlSeconds > 0) || ttlSeconds > MAX_TTL_SECONDS)
    throw new Error(`lease ttl must be in (0, ${MAX_TTL_SECONDS}] s, got ${ttlSeconds}`);
  return { ttlSeconds, heartbeatMs: Math.max(1, Math.floor((ttlSeconds * 1000) / 3)) };
}
