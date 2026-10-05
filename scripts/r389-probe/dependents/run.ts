// R389 dependents probe: presence check (one app id at a time) and publish, Cronus284 only.
// Credentials are read from the config INSIDE this script and never printed.
// Usage: bun run.ts presence | publish
import { readFileSync } from "node:fs";

const HOST = "http://Cronus284";
const INSTANCE = "BC";
const TENANT = "default";
const COMPANY = "CRONUS Danmark A/S";
const here = import.meta.dir;
const raw = JSON.parse(
  readFileSync("/work/lethal/fixtures/sandbox-hang/lethal.config.local.json", "utf8"),
);
const b = raw.bcdev ?? {};
const user: string | undefined = b.username ?? b.env?.BC_DEV_USER;
const pass: string | undefined = b.password ?? b.env?.BC_DEV_PASSWORD;
if (user === undefined || pass === undefined) throw new Error("config has no credentials");

const IDS: Record<string, string> = {
  P: "5e7a3c91-0b42-4d6e-a8f1-389e0a1b3d01",
  C: "5e7a3c91-0b42-4d6e-a8f1-389e0a1b3d02",
  External2026_10_04: "5e7a3c91-0b42-4d6e-a8f1-389e0a1b2c01",
  Tests2026_10_04: "5e7a3c91-0b42-4d6e-a8f1-389e0a1b2c02",
  SystemApplication: "63ca2fa4-4f03-4f2b-a480-172fef340d3f",
};

async function get(path: string, q: Record<string, string> = {}): Promise<unknown[]> {
  const p = new URLSearchParams({ ...q, tenant: TENANT });
  const res = await fetch(`${HOST}:7048/${INSTANCE}/${path}?${p}`, {
    headers: { authorization: `Basic ${btoa(`${user}:${pass}`)}`, accept: "application/json" },
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return ((await res.json()) as { value: unknown[] }).value;
}

const mode = process.argv[2];
if (mode === "presence") {
  const cs = (await get("api/v2.0/companies")) as { id: string; name: string }[];
  const c = cs.find((x) => x.name.toLowerCase() === COMPANY.toLowerCase());
  if (c === undefined) throw new Error("company not found");
  for (const [k, id] of Object.entries(IDS)) {
    const rows = (await get(`api/microsoft/automation/v2.0/companies(${c.id})/extensions`, {
      $filter: `id eq ${id}`,
    })) as Record<string, unknown>[];
    const r = rows[0];
    console.log(
      `${k} ${id}: ${r === undefined ? "ABSENT" : `PRESENT installed=${r.isInstalled} v=${r.versionMajor}.${r.versionMinor}.${r.versionBuild}.${r.versionRevision}`}`,
    );
  }
} else if (mode === "publish") {
  for (const app of ["probe", "child"]) {
    const argv = [
      `${process.env.LETHAL_ALC_DIR}/altool`,
      "publishapp",
      `${here}/out/${app}.app`,
      "--server",
      HOST,
      "--serverinstance",
      INSTANCE,
      "--environmenttype",
      "OnPrem",
      "--authentication",
      "UserPassword",
      "--schemaupdatemode",
      "ForceSync",
      "--tenant",
      TENANT,
    ];
    const p = Bun.spawn(argv, {
      env: { ...process.env, BC_SERVER_USERNAME: user, BC_SERVER_PASSWORD: pass },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const code = await p.exited;
    console.log(`--- ${app} exit ${code}\n${o}\n${e}`);
    if (code !== 0) process.exit(code); // STOP: no workaround on refusal
  }
} else throw new Error("mode: presence | publish");
