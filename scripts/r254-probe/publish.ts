/**
 * R254 probe: publish one compiled probe .app over the dev endpoint with altool, the way
 * `packages/runner/src/publisher.ts` does. Credentials are read from a lethal config's `bcdev`
 * block and passed ONLY as env vars to altool; nothing secret is printed or put on a command line.
 *
 * Usage: bun scripts/r254-probe/publish.ts <lethal.config.json naming the container> <app file>
 * Publish the target first, then the tests app.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const [configPath, appPath] = process.argv.slice(2);
if (configPath === undefined || appPath === undefined) {
  throw new Error("usage: publish.ts <lethal config> <app file>");
}
const raw = JSON.parse(await readFile(configPath, "utf8")) as { bcdev?: Record<string, unknown> };
const b = raw.bcdev ?? {};
const need = (k: string): string => {
  const v = b[k];
  if (typeof v !== "string" || v === "") throw new Error(`config bcdev.${k} must be a non-empty string`);
  return v;
};
const altoolDir = process.env.LETHAL_ALC_DIR;
if (altoolDir === undefined) throw new Error("LETHAL_ALC_DIR is not set");
const argv = [
  join(altoolDir, "altool"),
  "publishapp",
  appPath,
  "--server",
  need("server"),
  "--serverinstance",
  need("serverInstance"),
  "--environmenttype",
  "OnPrem",
  "--authentication",
  "UserPassword",
  "--schemaupdatemode",
  "ForceSync",
];
if (typeof b.tenant === "string" && b.tenant !== "") argv.push("--tenant", b.tenant);
console.log(`publishing ${appPath} to ${need("server")}/${need("serverInstance")}`);
const proc = Bun.spawn(argv, {
  env: { ...process.env, BC_SERVER_USERNAME: need("username"), BC_SERVER_PASSWORD: need("password") },
  stdout: "inherit",
  stderr: "inherit",
});
const code = await proc.exited;
if (code !== 0) throw new Error(`altool publishapp exited ${code}`);
