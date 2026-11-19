/**
 * PR-197 (R1113 fix 2): the `TestHttpRequestPolicy` of each test codeunit a run selects.
 *
 * BC's default policy lets a test's outbound HTTP call out to the network, exactly as `AllowAllOutboundRequests`
 * (PR-176, measured on bc3); `BlockOutboundRequests`, and `AllowOutboundFromHandler` with no handler, error before
 * sending. One test waiting on a slow or unreachable host can stall a whole baseline (R1113). This reads the policy
 * from source, so the run can say which codeunits can call out. It never decides a verdict and never refuses.
 *
 * Classes: `block` is not listed; `handler` is listed apart (whether a handler lets a call through is not measured);
 * `open` (no property, `AllowAllOutboundRequests`, any other value) is listed; `unread` (file unreadable, or no object
 * of that name in it) is listed and never treated as safe. Which codeunits can REACH an `HttpClient` send is R1134.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { maskAlNonCode } from "@lethal/engine";
import { objectHeadersOf } from "@lethal/schemata";

export interface HttpPolicyEntry {
  readonly codeunit: string;
  readonly file: string;
  /** The property's value as written, or "" when the codeunit sets none. */
  readonly policy: string;
}

export interface HttpPolicySummary {
  /** Distinct selected test codeunits. */
  readonly codeunits: number;
  readonly open: readonly HttpPolicyEntry[];
  readonly handler: readonly HttpPolicyEntry[];
  readonly unread: readonly HttpPolicyEntry[];
}

const norm = (s: string): string => s.replaceAll('"', "").trim().toLowerCase();

/** The policy one codeunit of `source` sets: "" for none, `undefined` when no codeunit of that name is in the file. */
export function policyOfCodeunit(source: string, codeunit: string): string | undefined {
  const masked = maskAlNonCode(source, { blankStringContents: true });
  const headers = [...objectHeadersOf(masked, "")].sort((a, b) => a.startIndex - b.startIndex);
  const i = headers.findIndex((h) => h.type === "codeunit" && norm(h.name) === norm(codeunit));
  const own = headers[i];
  if (own === undefined) return undefined;
  const end = headers[i + 1]?.startIndex ?? masked.length;
  const m = masked
    .slice(own.startIndex, end)
    .match(/\bTestHttpRequestPolicy\s*=\s*([A-Za-z]+)\s*;/i);
  return m?.[1] ?? "";
}

/** Group the selected tests by codeunit and classify each. Reads each test file once. */
export async function httpPolicyOf(
  testDir: string,
  tests: readonly { readonly codeunitName: string; readonly file?: string }[],
  read: (path: string) => Promise<string> = (p) => readFile(p, "utf8"),
): Promise<HttpPolicySummary> {
  const byCodeunit = new Map<string, { codeunit: string; file: string }>();
  for (const t of tests) {
    const k = norm(t.codeunitName);
    if (!byCodeunit.has(k)) byCodeunit.set(k, { codeunit: t.codeunitName, file: t.file ?? "" });
  }
  const sources = new Map<string, string | undefined>();
  const open: HttpPolicyEntry[] = [];
  const handler: HttpPolicyEntry[] = [];
  const unread: HttpPolicyEntry[] = [];
  for (const { codeunit, file } of byCodeunit.values()) {
    if (file !== "" && !sources.has(file))
      sources.set(file, await read(join(testDir, file)).catch(() => undefined));
    const src = file === "" ? undefined : sources.get(file);
    const policy = src === undefined ? undefined : policyOfCodeunit(src, codeunit);
    if (policy === undefined) {
      unread.push({ codeunit, file, policy: "" });
      continue;
    }
    const p = policy.toLowerCase();
    if (p === "blockoutboundrequests") continue;
    (p === "allowoutboundfromhandler" ? handler : open).push({ codeunit, file, policy });
  }
  const byName = (a: HttpPolicyEntry, b: HttpPolicyEntry) => a.codeunit.localeCompare(b.codeunit);
  return {
    codeunits: byCodeunit.size,
    open: open.sort(byName),
    handler: handler.sort(byName),
    unread: unread.sort(byName),
  };
}

const SHOWN = 10;

/** The stderr lines for a summary (the progress renderer and the dry run both print these). */
export function httpPolicyLines(
  s: HttpPolicySummary,
  rest = "the events file lists all",
): string[] {
  const listed = [...s.open, ...s.handler, ...s.unread];
  if (listed.length === 0)
    return [
      `outbound HTTP: all ${s.codeunits} selected test codeunit(s) block outbound calls (TestHttpRequestPolicy)`,
    ];
  const lines = [
    `outbound HTTP: ${s.open.length} of ${s.codeunits} selected test codeunit(s) set no TestHttpRequestPolicy that blocks outbound calls${
      s.handler.length > 0
        ? ` (${s.handler.length} more use AllowOutboundFromHandler; whether a handler lets a call out is not measured)`
        : ""
    }${s.unread.length > 0 ? `; unread: ${s.unread.length}` : ""}.`,
    "  On BC, and in al-runner, a call made from them can go out to the network; a slow or unreachable host can stall the baseline (R1113).",
    "  Set TestHttpRequestPolicy = BlockOutboundRequests on test codeunits that should not call out, or leave a test out with --exclude-test / --tests-only.",
  ];
  for (const e of listed.slice(0, SHOWN))
    lines.push(
      `  ${e.codeunit} (${e.file === "" ? "no file" : e.file})${e.policy !== "" ? `: ${e.policy}` : ""}${s.unread.includes(e) ? ": unread" : ""}`,
    );
  if (listed.length > SHOWN) lines.push(`  ... and ${listed.length - SHOWN} more (${rest})`);
  return lines;
}
