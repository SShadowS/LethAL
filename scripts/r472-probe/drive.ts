/**
 * R472 probe driver. Calls R472ProbeApi_Measure and _Raw over OData for modes 1..3 and prints the
 * HTTP status and body of each. Credentials and endpoint come from a lethal config's `bcdev` block
 * and are never printed or put on a command line.
 *
 * Usage: bun scripts/r472-probe/drive.ts <lethal.config.json naming the container>
 * Publish first: bun scripts/r254-probe/publish.ts <config> <compiled probe .app>
 */
import { readFile } from "node:fs/promises";

const [configPath] = process.argv.slice(2);
if (configPath === undefined) throw new Error("usage: drive.ts <lethal config>");
const raw = JSON.parse(await readFile(configPath, "utf8")) as { bcdev?: Record<string, unknown> };
const b = raw.bcdev ?? {};
const need = (k: string): string => {
  const v = b[k];
  if (typeof v !== "string" || v === "")
    throw new Error(`config bcdev.${k} must be a non-empty string`);
  return v;
};
const host = new URL(need("server")).hostname;
// sandbox-data's fixture company (CLAUDE.md, itest:envtool), unless the config names one.
const company =
  typeof b.company === "string" && b.company !== "" ? b.company : "CRONUS Danmark A/S";
const tenant = typeof b.tenant === "string" && b.tenant !== "" ? b.tenant : "default";
const auth = `Basic ${Buffer.from(`${need("username")}:${need("password")}`).toString("base64")}`;
const base = `http://${host}:7048/${need("serverInstance")}/ODataV4`;
const q = `?company=${encodeURIComponent(company)}&tenant=${encodeURIComponent(tenant)}`;

console.log(`endpoint ${base} company=${company} tenant=${tenant} at ${new Date().toISOString()}`);
for (const proc of ["Measure", "Raw"]) {
  for (const mode of [1, 2, 3]) {
    const res = await fetch(`${base}/R472ProbeApi_${proc}${q}`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
      signal: AbortSignal.timeout(60_000),
    });
    console.log(`${proc}(${mode}) HTTP ${res.status}: ${await res.text()}`);
  }
}
