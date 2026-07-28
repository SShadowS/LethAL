#!/usr/bin/env bun
/**
 * Writes a `lethal.config.json` with the environment tool's resolved connection fields filled in,
 * for the commands that read `bcdev` DIRECTLY and perform no env-tool resolution of their own —
 * `force-reset-lease` and `clear-quarantine`.
 *
 * Two rules it enforces so the caller cannot forget them:
 *
 *  - the output path must be OUTSIDE the repository (plaintext credentials never enter the tree),
 *  - nothing sensitive is ever printed; it reports only whether each field resolved.
 *
 * Delete the file as soon as the command that needs it has run.
 *
 * Usage:
 *   bun materialize-config.ts <envId> <base-config.json> <out-path-outside-repo>
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const [envId, baseConfigPath, outPath] = process.argv.slice(2);
if (envId === undefined || baseConfigPath === undefined || outPath === undefined) {
  console.error("usage: materialize-config.ts <envId> <base-config.json> <out-path-outside-repo>");
  process.exit(1);
}

const repoRoot = resolve(import.meta.dir, "..", "..", "..", "..");
const norm = (p: string): string => resolve(p).replace(/\\/g, "/").toLowerCase();
if (norm(outPath).startsWith(`${norm(repoRoot)}/`)) {
  const why = "Choose a path outside it — the file carries a real username and password.";
  console.error(
    `refusing to write resolved credentials inside the repository (${outPath}).\n${why}`,
  );
  process.exit(1);
}

const base = (await Bun.file(baseConfigPath).json()) as {
  bcdev?: Record<string, unknown>;
  envTool?: { toolPath?: string };
};
const toolPath = base.envTool?.toolPath;
if (typeof toolPath !== "string") {
  console.error(`${baseConfigPath} has no envTool.toolPath — nothing to resolve credentials with`);
  process.exit(1);
}

// `env users --json` prints PLAINTEXT passwords. Captured, never echoed.
const users = spawnSync(toolPath, ["env", "users", envId, "--json"], { encoding: "utf8" });
if (users.status !== 0) {
  console.error(`\`env users ${envId} --json\` failed (exit ${users.status})`);
  process.exit(1);
}
const parsed: unknown = JSON.parse(users.stdout);
const user = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown>;
const username = (user.username ?? user.userName ?? user.name) as string | undefined;
const password = user.password as string | undefined;

const envGet = spawnSync(toolPath, ["env", "get", envId], { encoding: "utf8" });
const urlLine = envGet.stdout.split("\n").find((l) => l.trim().startsWith("URL:"));
const baseUrl = urlLine?.split(/\s+/).slice(1).join("").trim();
if (baseUrl === undefined || baseUrl === "") {
  console.error(`could not read the environment URL for ${envId}`);
  process.exit(1);
}
const server = new URL(baseUrl).origin;

if (typeof username !== "string" || typeof password !== "string") {
  console.error("the environment tool returned no usable username/password pair");
  process.exit(1);
}

await Bun.write(
  outPath,
  `${JSON.stringify(
    {
      ...base,
      bcdev: {
        ...(base.bcdev ?? {}),
        server,
        serverInstance: envId,
        baseUrl,
        username,
        password,
        port: 443,
      },
    },
    null,
    2,
  )}\n`,
);

// Deliberately reports only presence. A "helpful" echo of the resolved config is exactly how a
// credential reaches a transcript.
console.log(
  `wrote ${outPath} — server=${server} instance=${envId} username=${username.length > 0 ? "resolved" : "MISSING"} password=${password.length > 0 ? "resolved" : "MISSING"}`,
);
console.log("delete this file as soon as the command that needs it has run.");
