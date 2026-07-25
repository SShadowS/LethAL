#!/usr/bin/env bun
/**
 * The one question the 2026-07-26 spike did not answer: can bc-dev-mcp reach a Continia
 * environment? That decides the coverage mode (spec §Coverage). Provisioning timings and URL
 * stability are already measured — see "Already measured" in the plan; do not re-measure them.
 *
 * Uses an EXISTING environment. Prints findings; changes nothing.
 *
 *   CONTINIA_ENV_ID=... bun run scripts/probe-continia-env.ts
 *
 * CONTINIA_API_TOKEN is deliberately not read here: on this machine `continia.exe` already
 * resolves its own token from VS Code settings, so nothing needs to be exported for it — Bun.spawn
 * inherits the parent process env either way, so an explicit CONTINIA_API_TOKEN would still reach
 * the child if a caller did set one.
 *
 * Deviation from the brief's literal script (this is the actual current interface, checked against
 * bcdev-backend.ts): `BcDevConfig.project` is a REQUIRED string (not optional) — added below. And
 * `BcDevConfig` has no `username`/`password` fields at all — bc-dev-mcp's `bcdev_status` schema
 * (connectionShape, bc-dev-mcp/src/mcp/tools/shared.ts) carries no credential params; credentials
 * reach the spawned server only via BC_DEV_USER/BC_DEV_PASSWORD in `env`, which the brief's script
 * already sets correctly.
 */
import { BcDevMcpBackend } from "../packages/runner/src/bcdev-backend";

const TOOL = process.env.CONTINIA_TOOL ?? "U:/Git/CLI/continia.exe";
const ENV_ID = process.env.CONTINIA_ENV_ID;
if (ENV_ID === undefined) throw new Error("set CONTINIA_ENV_ID");

async function tool(args: readonly string[]): Promise<string> {
  const proc = Bun.spawn([TOOL, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${args.join(" ")} exited ${code}: ${err || out}`);
  return out;
}

const env = JSON.parse(await tool(["env", "get", ENV_ID, "--json"])) as {
  url: string;
  expiresUtc?: string;
};
const users = JSON.parse(await tool(["env", "users", ENV_ID, "--json"])) as Array<{
  username: string;
  password: string;
}>;
const user = users[0];
if (user === undefined) throw new Error("env has no users");
console.log(`url=${env.url} expiresUtc=${env.expiresUtc ?? "(none)"} user=${user.username}`);

const origin = new URL(env.url).origin;
const instance = new URL(env.url).pathname.replace(/^\/+|\/+$/g, "");

// Baseline: does the BC surface answer these credentials at all? If this fails, nothing below
// can succeed and the environment — not bc-dev-mcp — is the problem.
const auth = `Basic ${btoa(`${user.username}:${user.password}`)}`;
const probeUrl = `${origin}/${instance}/api/microsoft/automation/v2.0/companies`;
const res = await fetch(probeUrl, { headers: { Authorization: auth } });
console.log(`automation api: ${res.status} ${res.statusText}`);

// THE question: drive the real backend exactly as a session would, rather than eyeballing
// bc-dev-mcp by hand. `status()` is what runSession hard-gates on (orchestrator.ts), so this is
// the same call that would abort a real run.
const backend = new BcDevMcpBackend({
  mcpCommand: ["bun", "run", "U:/Git/bc-dev-mcp/src/mcp/index.ts"],
  project: process.cwd(),
  server: origin,
  serverInstance: instance,
  tenant: "default",
  company: "CRONUS Danmark A/S",
  packageCachePath: ".alpackages",
  controlSymbolPath: "unused-for-status",
  env: { BC_DEV_USER: user.username, BC_DEV_PASSWORD: user.password },
});
try {
  const status = await backend.status();
  console.log(`bcdev_status ok=${status.ok}`);
  console.log(status.details.slice(0, 800));
  console.log(
    status.ok
      ? '\nVERDICT: coverageMode "procedure" — bc-dev-mcp drives this environment.'
      : '\nVERDICT: coverageMode "none" — quote the details above in the plan.',
  );
} finally {
  await backend.close();
}
