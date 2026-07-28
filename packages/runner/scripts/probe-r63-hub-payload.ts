#!/usr/bin/env bun
/**
 * R63: capture the RAW `bcdev_test_run` coverage payload so the server-side semantics are
 * measured, not guessed.
 *
 * R58's DO differential proved LethAL credits a test with another test's coverage
 * (`buildCoverageMap` takes the first `testObjectId`-matching entry, never `testMethodId`).
 * What it could not say is WHY a single-method run's payload holds several entries for one
 * codeunit. The candidates have different fixes:
 *
 *   A. The payload always carries exactly one entry (the requested method's) and DO's blob came
 *      from something DO-specific. Then matching `(testObjectId, testMethodId)` is the whole fix.
 *   B. The server accumulates coverage at test-codeunit scope ACROSS calls (a persistent
 *      server-side runner), so later single-method runs inherit earlier methods' entries.
 *      Then the payload must also be FILTERED, and order-dependence must be documented.
 *   C. Each payload carries extra non-method entries (a codeunit-level or synthetic entry —
 *      cf. bc-dev-mcp's "empty method name" quirk) that the find-by-codeunit grabs.
 *
 * The discriminator is a 2-method fixture codeunit whose methods cover DISJOINT procedures
 * (`Sandbox Tests`: OverBudgetDetected -> IsOverBudget; ClampPercentRuns -> ClampPercent +
 * ApplyAudit), run in this order with the RAW payload dumped per call:
 *
 *   1. ClampPercentRuns alone        (baseline shape: which entries, which methodIds)
 *   2. OverBudgetDetected alone      (disjoint coverage — must not appear in 1 or 3 if per-call)
 *   3. ClampPercentRuns again        (if OverBudget's procedures show up now: cross-call
 *                                     accumulation, candidate B)
 *   4. BOTH methods in one call      (the healthy multi-entry shape, for comparison)
 *
 * Usage:
 *   bun scripts/probe-r63-hub-payload.ts --config fixtures/sandbox-app/lethal.config.local.json \
 *     --project fixtures/sandbox-app --codeunit 79100 \
 *     --method-a ClampPercentRuns --method-b OverBudgetDetected --out u:/tmp/r63-payload.jsonl
 *
 * Defaults are the sandbox fixture's. Reads the SAME gitignored local config the itests read —
 * credentials stay in that file and only the non-secret connection fields are echoed.
 */
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..");

interface BcDevLocalConfig {
  readonly bcdev: {
    readonly mcpCommand: Record<string, string> | readonly string[];
    readonly server: string;
    readonly serverInstance: string;
    readonly tenant?: string;
    readonly company?: string;
    readonly port?: number;
    readonly env?: Record<string, string>;
  };
}

function parseArgs(argv: readonly string[]) {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const abs = (p: string): string => (isAbsolute(p) ? p : join(REPO_ROOT, p));
  const config = get("--config") ?? "fixtures/sandbox-app/lethal.config.local.json";
  return {
    configPath: abs(config),
    project: abs(get("--project") ?? "fixtures/sandbox-app"),
    codeunitId: Number(get("--codeunit") ?? "79100"),
    methodA: get("--method-a") ?? "ClampPercentRuns",
    methodB: get("--method-b") ?? "OverBudgetDetected",
    out: get("--out"),
  };
}

function mcpCommandOf(raw: BcDevLocalConfig["bcdev"]["mcpCommand"]): readonly string[] {
  return Array.isArray(raw)
    ? raw
    : Object.keys(raw)
        .sort()
        .map((k) => raw[k] ?? "");
}

interface WireEntry {
  readonly testObjectId: number;
  readonly testMethodId: number;
  readonly coveredProcedures: readonly { objectType: number; objectId: number; methodId: number }[];
}

function summarize(call: string, payloadText: string) {
  let parsed: {
    results?: readonly { codeunitId: number; method: string; status: string }[];
    coverage?: readonly WireEntry[];
    runAborted?: boolean;
    abortReason?: string;
  };
  try {
    parsed = JSON.parse(payloadText);
  } catch {
    return { call, parseError: true, raw: payloadText.slice(0, 500) };
  }
  return {
    call,
    runAborted: parsed.runAborted ?? false,
    abortReason: parsed.abortReason,
    results: (parsed.results ?? []).map(
      (r) => `${r.codeunitId}:${r.method || "<empty>"}=${r.status}`,
    ),
    coverageEntries: (parsed.coverage ?? []).map((e) => ({
      testObjectId: e.testObjectId,
      testMethodId: e.testMethodId,
      procedures: e.coveredProcedures.length,
      objectIds: [...new Set(e.coveredProcedures.map((p) => p.objectId))].sort(),
    })),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = JSON.parse(await readFile(args.configPath, "utf8")) as BcDevLocalConfig;
  const cmd = mcpCommandOf(cfg.bcdev.mcpCommand);
  const env = { ...getDefaultEnvironment(), ...cfg.bcdev.env };
  const transport = new StdioClientTransport({
    command: cmd[0] ?? "",
    args: [...cmd.slice(1)],
    env,
  });
  const client = new Client({ name: "lethal-r63-probe", version: "0.0.0" });
  await client.connect(transport);

  const conn = {
    project: args.project,
    server: cfg.bcdev.server,
    serverInstance: cfg.bcdev.serverInstance,
    ...(cfg.bcdev.tenant !== undefined ? { tenant: cfg.bcdev.tenant } : {}),
    ...(cfg.bcdev.company !== undefined ? { company: cfg.bcdev.company } : {}),
    ...(cfg.bcdev.port !== undefined ? { port: cfg.bcdev.port } : {}),
  };
  console.log(
    `probing ${cfg.bcdev.server}/${cfg.bcdev.serverInstance} codeunit ${args.codeunitId} ` +
      `(A=${args.methodA}, B=${args.methodB})`,
  );

  const calls: readonly [string, readonly string[]][] = [
    ["1:A-alone", [args.methodA]],
    ["2:B-alone", [args.methodB]],
    ["3:A-again", [args.methodA]],
    ["4:A-and-B", [args.methodA, args.methodB]],
  ];

  const lines: string[] = [];
  for (const [label, methods] of calls) {
    const res = await client.callTool({
      name: "bcdev_test_run",
      arguments: {
        ...conn,
        codeunits: [{ id: args.codeunitId, methods: [...methods] }],
        coverage: "procedure",
      },
    });
    const text = (res.content as readonly { type: string; text?: string }[])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    const summary = summarize(label, text);
    lines.push(JSON.stringify(summary));
    console.log(JSON.stringify(summary, null, 1));
  }

  if (args.out !== undefined) {
    await writeFile(args.out, `${lines.join("\n")}\n`);
    console.log(`wrote ${args.out}`);
  }
  await client.close();
}

await main();
