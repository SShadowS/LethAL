/** Fields identifying a physical BC SERVICE TIER (the shared-resource scope for quarantine).
 *  Deliberately excludes tenant — the SQL worker pool is shared across tenants on one tier. */
export interface ResourceKeyConfig {
  readonly server: string;
  readonly serverInstance: string;
}

/** Lowercase + strip a single trailing slash, matching publish-serializer's normalization so
 *  `http://Cronus281/` and `http://cronus281` name the same tier. Host-vs-IP aliases are NOT
 *  resolvable here and are an operator responsibility (spec §9). */
function normalizeServer(server: string): string {
  const lower = server.toLowerCase();
  return lower.endsWith("/") ? lower.slice(0, -1) : lower;
}

/**
 * Tier-scoped quarantine identity: two configs naming the same server (modulo case/trailing
 * slash) and server instance collapse to one key, regardless of tenant. Distinct from
 * `canonicalContainerKey` (publish-serializer.ts), which keeps tenant for a different domain.
 */
export function quarantineResourceKey(cfg: ResourceKeyConfig): string {
  return `${normalizeServer(cfg.server)}|${cfg.serverInstance}`;
}
