#!/usr/bin/env bun
/**
 * R13 probe driver — same shape as `scripts/probe-r1-permissions.ts` (calls `LethALControl_RunMutant`
 * directly at BASELINE for one named test method and prints the server's raw answer), but
 * parameterised by which fixture config / target app to talk through, because the Tier-3 probes
 * live in `sandbox-probes` while the registered artifact belongs to whichever target the container
 * last had published.
 *
 *   bun scripts/r13-probe/drive.ts <config.json> <targetAppId> <codeunitId> <method> [...]
 */
import { readFile } from "node:fs/promises";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v === "") throw new Error(`config: bcdev.${key} must be a string`);
  return v;
}

const [configPath, targetAppId, codeunitRaw, ...methods] = process.argv.slice(2);
if (!configPath || !targetAppId || !codeunitRaw || methods.length === 0) {
  throw new Error(
    "usage: bun scripts/r13-probe/drive.ts <config.json> <targetAppId> <codeunitId> <method> [...]",
  );
}
const codeunitId = Number(codeunitRaw);
if (!Number.isInteger(codeunitId)) throw new Error(`codeunitId must be an integer: ${codeunitRaw}`);

const parsed: unknown = JSON.parse(await readFile(configPath, "utf8"));
if (!isRecord(parsed) || !isRecord(parsed.bcdev)) throw new Error("expected a bcdev object");
const b = parsed.bcdev;
const tenant = typeof b.tenant === "string" ? b.tenant : undefined;
const cfg = {
  server: requireString(b, "server"),
  serverInstance: requireString(b, "serverInstance"),
  company: requireString(b, "company"),
  username: requireString(b, "username"),
  password: requireString(b, "password"),
};

const baseUrl = `${cfg.server}:7048/${cfg.serverInstance}`;
const auth = `Basic ${btoa(`${cfg.username}:${cfg.password}`)}`;

function url(action: string): string {
  const params = new URLSearchParams({ company: cfg.company });
  if (tenant !== undefined) params.set("tenant", tenant);
  return `${baseUrl}/ODataV4/LethALControl_${action}?${params.toString()}`;
}

async function post(
  action: string,
  body: Record<string, unknown>,
): Promise<{ status: number; text: string }> {
  const res = await fetch(url(action), {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

async function postJson(
  action: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { status, text } = await post(action, body);
  if (status < 200 || status >= 300) throw new Error(`${action} -> HTTP ${status}: ${text}`);
  const envelope: unknown = JSON.parse(text);
  const value = isRecord(envelope) ? envelope.value : undefined;
  if (typeof value !== "string") throw new Error(`${action}: no string "value" in ${text}`);
  const inner: unknown = JSON.parse(value);
  if (!isRecord(inner)) throw new Error(`${action}: "value" is not an object: ${value}`);
  return inner;
}

console.log(`target: ${baseUrl} company=${cfg.company} codeunit=${codeunitId}`);
const info = await postJson("HarnessInfo", { clientProtocol: 2 });
const serverGeneration = info.serverGeneration;
if (typeof serverGeneration !== "string")
  throw new Error(`no serverGeneration: ${JSON.stringify(info)}`);

const { status: raStatus, text: raText } = await post("RegisteredArtifact", { targetAppId });
if (raStatus < 200 || raStatus >= 300)
  throw new Error(`RegisteredArtifact -> HTTP ${raStatus}: ${raText}`);
const raEnvelope: unknown = JSON.parse(raText);
const artifactId =
  isRecord(raEnvelope) && typeof raEnvelope.value === "string" ? raEnvelope.value : "";
console.log(`serverGeneration=${serverGeneration} registeredArtifact=${artifactId || "(none)"}`);
if (artifactId === "") {
  console.log("no artifact registered for that target — pick another target app id");
  process.exit(3);
}

const acquire = await postJson("AcquireLease", {
  owner: "probe-tier3",
  ttlSeconds: 300,
  clientNonce: `t3-${process.pid}-${performance.now()}`,
  expectedGeneration: serverGeneration,
});
if (acquire.granted !== true) throw new Error(`lease not granted: ${JSON.stringify(acquire)}`);
const { epoch, token, lastCompletedOpSeq } = acquire;
if (
  typeof epoch !== "number" ||
  typeof token !== "string" ||
  typeof lastCompletedOpSeq !== "number"
) {
  throw new Error(`malformed grant: ${JSON.stringify(acquire)}`);
}

let opSeq = lastCompletedOpSeq;
try {
  for (const method of methods) {
    opSeq += 1;
    console.log(`\n--- ${method} (baseline, mutantId="") opSeq=${opSeq} ---`);
    const { status, text } = await post("RunMutant", {
      targetAppId,
      artifactId,
      attemptId: `t3-${opSeq}-${process.pid}`,
      mutantId: "",
      testCodeunitId: codeunitId,
      testMethod: method,
      leaseEpoch: epoch,
      leaseToken: token,
      serverGeneration,
      opSeq,
    });
    console.log(`HTTP ${status}`);
    try {
      const envelope: unknown = JSON.parse(text);
      const value = isRecord(envelope) ? envelope.value : undefined;
      if (typeof value === "string") {
        const inner: unknown = JSON.parse(value);
        console.log(JSON.stringify(inner, null, 2));
        if (isRecord(inner) && typeof inner.codeunitResults === "string") {
          console.log("--- codeunitResults ---");
          console.log(JSON.stringify(JSON.parse(inner.codeunitResults), null, 2));
        }
      } else console.log(text);
    } catch {
      console.log(text);
    }
  }
} finally {
  const released = await postJson("ReleaseLease", { epoch, token, generation: serverGeneration });
  console.log(`\nReleaseLease: ${JSON.stringify(released)}`);
}
