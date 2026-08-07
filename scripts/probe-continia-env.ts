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
 *
 * CORRECTED 2026-07-26: the first run of this probe recorded `coverageMode: "none"`, and that
 * verdict was wrong — see the plan's "Probe result" section for the full evidence. It was reached
 * without a `port`, so `bcdev_status` hit bc-dev-mcp's OnPrem fallback port (7049,
 * `bc-dev-mcp/src/core/urls.ts`), which Continia's path-routed HTTPS portal does not listen on.
 * `ConnectionConfig.port` is a real override (`connectionShape` in
 * `bc-dev-mcp/src/mcp/tools/shared.ts`, the same shape cited above), and the
 * WHATWG URL API normalizes away a default port (`new URL("https://host:443").port === ""`), so
 * embedding `:443` in `server` cannot substitute for it. This version derives and passes `port` —
 * explicit port from `env.url` if it carries one, else 443 for `https:` / 80 for `http:` — so
 * re-running this probe reproduces the success (`coverage: "procedure"`) rather than the stale,
 * now-explained failure.
 *
 * This drives bc-dev-mcp directly through the MCP SDK's own `Client`/`StdioClientTransport` rather
 * than through `BcDevMcpBackend`: `BcDevConfig` (bcdev-backend.ts) has no `port` field yet — that
 * lands with Task 5 — so `BcDevMcpBackend.status()` has no way to carry this probe's decisive
 * parameter today. Calling `bcdev_status` directly, twice (without then with `port`), reproduces
 * exactly the comparison the corrected verdict rests on, without changing library code for a probe.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";

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

const envUrl = new URL(env.url);
const origin = envUrl.origin;
const instance = envUrl.pathname.replace(/^\/+|\/+$/g, "");

/**
 * Derives bc-dev-mcp's `port` override from the resolved environment URL: an explicit port if the
 * URL carries one, else the protocol default. Without this, bc-dev-mcp's own OnPrem fallback
 * (7049) fires instead, which is unreachable on a path-routed HTTPS portal like Continia's.
 */
function derivePort(u: URL): number {
  if (u.port !== "") return Number(u.port);
  return u.protocol === "https:" ? 443 : 80;
}

const port = derivePort(envUrl);
console.log(
  `derived port=${port} (from ${envUrl.protocol}//${envUrl.hostname}${envUrl.port ? `:${envUrl.port}` : ""})`,
);

// Baseline: does the BC surface answer these credentials at all? If this fails, nothing below
// can succeed and the environment — not bc-dev-mcp — is the problem.
const auth = `Basic ${btoa(`${user.username}:${user.password}`)}`;
const probeUrl = `${origin}/${instance}/api/microsoft/automation/v2.0/companies`;
const res = await fetch(probeUrl, { headers: { Authorization: auth } });
console.log(`automation api: ${res.status} ${res.statusText}`);

// THE question: call bc-dev-mcp's own `bcdev_status` tool exactly as `BcDevMcpBackend.status()`
// does (same connection params, same credential channel — BC_DEV_USER/BC_DEV_PASSWORD in the
// spawned process's env), TWICE: once without `port` (reproduces the original, now-explained
// failure) and once with the derived `port` (the decisive, corrected result). One connection
// serves both calls — `port` is a per-call argument, not a connection-time setting.
function isToolError(res: unknown): boolean {
  return (res as { isError?: boolean }).isError === true;
}
function firstText(res: unknown): string {
  const content = (res as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.find((c) => c.type === "text")?.text ?? "";
}

const mcpEnv = {
  ...getDefaultEnvironment(),
  BC_DEV_USER: user.username,
  BC_DEV_PASSWORD: user.password,
};
const transport = new StdioClientTransport({
  command: "bun",
  args: ["run", "U:/Git/bc-dev-mcp/src/mcp/index.ts"],
  env: mcpEnv,
});
const client = new Client({ name: "lethal-envtool-probe", version: "0.0.0" });
await client.connect(transport);

const connectionParams = {
  project: process.cwd(),
  server: origin,
  serverInstance: instance,
  tenant: "default",
  company: "CRONUS Danmark A/S",
};

try {
  const withoutPort = await client.callTool({
    name: "bcdev_status",
    arguments: connectionParams,
  });
  console.log(`\nbcdev_status WITHOUT port: isError=${isToolError(withoutPort)}`);
  console.log(firstText(withoutPort).slice(0, 400));

  const withPort = await client.callTool({
    name: "bcdev_status",
    arguments: { ...connectionParams, port },
  });
  console.log(`\nbcdev_status WITH port=${port}: isError=${isToolError(withPort)}`);
  console.log(firstText(withPort).slice(0, 800));

  console.log(
    !isToolError(withPort)
      ? '\nVERDICT: coverageMode "procedure" — bc-dev-mcp drives this environment once `port` is supplied.'
      : '\nVERDICT: coverageMode "none" — quote the details above in the plan.',
  );
} finally {
  await client.close();
}
