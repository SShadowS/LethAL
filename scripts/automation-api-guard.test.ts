import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * R433 / R-385 T0, the SOURCE half of the guard. BC's automation `extensions` list, asked for every
 * row or filtered by publisher, hung BC 28.4 and took Cronus28's service tier down. At run time
 * `HarnessVerifier.fetchApiRows` (packages/runner/src/harness.ts) refuses any `extensions` request
 * not filtered by one GUID. That refusal sees only requests sent THROUGH it; a call built anywhere
 * else (an itest's own fetch, a probe script, a skill's snippet) would bypass it. So the automation
 * API text may appear only in harness.ts, plus the allowlist below, each entry with an exact hit
 * count and a reason. `docs/` is prose and is not scanned.
 *
 * The needle is built in two pieces so this file is not itself a hit.
 */

const NEEDLE = ["api/microsoft", "automation"].join("/");
const GUID_FILTER =
  /filter=id\+eq\+[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(&|"|$)/;

/** The one file allowed to build the path, without a count: its sender refuses at run time. */
const BUILDER = "packages/runner/src/harness.ts";

type Allowed = {
  readonly count: number;
  readonly reason: string;
  /** What the file's text must also satisfy; returns a failure message, or undefined. */
  readonly check: (text: string, hitLines: readonly string[]) => string | undefined;
};

const everyHitLineFiltersByGuid = (_text: string, hitLines: readonly string[]) => {
  const bad = hitLines.filter((l) => !GUID_FILTER.test(l));
  return bad.length === 0
    ? undefined
    : `hit line(s) without \`filter=id+eq+<GUID>\`: ${bad.map((l) => l.trim()).join(" | ")}`;
};

const ALLOWED: ReadonlyMap<string, Allowed> = new Map([
  [
    "scripts/probe-continia-env.ts",
    {
      count: 1,
      reason: "reads the automation `companies` list only, to probe that the API answers",
      check: (text) =>
        /extensions/i.test(text)
          ? "the probe now mentions `extensions`; it was allowed only for `companies`"
          : undefined,
    },
  ],
  [
    "packages/runner/tests/doctor-issue-23.test.ts",
    {
      count: 1,
      reason: "the URL a fake fetch saw from fetchExtensionInstalled, filtered by one GUID",
      check: everyHitLineFiltersByGuid,
    },
  ],
  [
    "packages/runner/tests/extensions-query-refusal.test.ts",
    {
      count: 1,
      reason: "the one URL the run-time refusal allows, sent to a fake fetch",
      check: everyHitLineFiltersByGuid,
    },
  ],
]);

const ROOT = join(import.meta.dir, "..");
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

/** The scanned roots, relative to the repo root: every package's src, itest and tests, plus
 *  `scripts/`, `tests/`, the shipped root `skills/` (when present) and `.claude/`; every
 *  package's `scripts/` too. */
function scannedRoots(root: string): string[] {
  const roots = ["scripts", "tests", ".claude", "skills"];
  for (const pkg of readdirSync(join(root, "packages"))) {
    for (const sub of ["src", "itest", "tests", "scripts"]) roots.push(`packages/${pkg}/${sub}`);
  }
  return roots.filter((r) => existsSync(join(root, r)));
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (st.isFile()) out.push(p);
  }
}

type Violation = { readonly file: string; readonly why: string };

/** Pure: given files (repo-relative, forward slashes) and their text, every violation. */
function findViolations(
  files: readonly { readonly path: string; readonly text: string }[],
): Violation[] {
  const out: Violation[] = [];
  const seen = new Set<string>();
  for (const { path, text } of files) {
    const lower = text.toLowerCase();
    const hitLines = text.split(/\r?\n/).filter((l) => l.toLowerCase().includes(NEEDLE));
    let count = 0;
    for (let i = lower.indexOf(NEEDLE); i !== -1; i = lower.indexOf(NEEDLE, i + 1)) count++;
    if (count === 0) continue;
    seen.add(path);
    if (path === BUILDER) continue;
    const allowed = ALLOWED.get(path);
    if (allowed === undefined) {
      out.push({ file: path, why: `${count} hit(s), and the file is not allowed` });
      continue;
    }
    if (count !== allowed.count) {
      out.push({ file: path, why: `${count} hit(s), allowed exactly ${allowed.count}` });
      continue;
    }
    const failed = allowed.check(text, hitLines);
    if (failed !== undefined) out.push({ file: path, why: failed });
  }
  for (const path of ALLOWED.keys()) {
    if (!seen.has(path) && files.some((f) => f.path === path)) {
      out.push({ file: path, why: "allowed with a count but has no hit; remove the entry" });
    }
  }
  return out;
}

function repoFiles(): { path: string; text: string }[] {
  const abs: string[] = [];
  for (const r of scannedRoots(ROOT)) walk(join(ROOT, r), abs);
  return abs.map((p) => ({
    path: relative(ROOT, p).replaceAll("\\", "/"),
    text: readFileSync(p, "utf8"),
  }));
}

describe("automation API guard (R433)", () => {
  test("no automation API text outside harness.ts and the allowlist", () => {
    expect(findViolations(repoFiles())).toEqual([]);
  });

  test("the scan reaches every root it claims, itests and .claude included", () => {
    const roots = scannedRoots(ROOT);
    for (const r of [
      "scripts",
      ".claude",
      "skills",
      "packages/runner/src",
      "packages/runner/itest",
      "packages/runner/scripts",
    ]) {
      expect(roots).toContain(r);
    }
    const paths = repoFiles().map((f) => f.path);
    expect(paths).toContain(BUILDER);
    expect(paths).toContain("packages/runner/itest/verify.itest.ts");
    expect(paths.some((p) => p.startsWith(".claude/skills/"))).toBe(true);
    expect(paths.some((p) => p.startsWith("skills/"))).toBe(true);
    expect(paths.some((p) => p.startsWith("packages/runner/scripts/"))).toBe(true);
  });

  test("the builder itself is a hit, so the scan is not blind", () => {
    const builder = repoFiles().find((f) => f.path === BUILDER);
    expect(builder?.text.toLowerCase().includes(NEEDLE)).toBe(true);
  });

  const hit = `fetch(\`\${base}/${NEEDLE}/v2.0/companies(\${c})/extensions\`)`;
  const guid = "437dbf0e-84ff-417a-965d-ed2bb9650972";

  test("a hit in any other file is reported, whatever its case", () => {
    expect(
      findViolations([
        { path: "packages/runner/itest/x.itest.ts", text: hit },
        { path: ".claude/skills/s/SKILL.md", text: hit.toUpperCase() },
        { path: "scripts/a.ts", text: `const p = "${NEEDLE}/";` },
      ]).map((v) => v.file),
    ).toEqual(["packages/runner/itest/x.itest.ts", ".claude/skills/s/SKILL.md", "scripts/a.ts"]);
  });

  test("an allowed file with another count, or a hit line without the GUID filter, is reported", () => {
    const t = "packages/runner/tests/doctor-issue-23.test.ts";
    const ok = `"http://bc/${NEEDLE}/v2.0/companies(c)/extensions?%24filter=id+eq+${guid}&tenant=d"`;
    expect(findViolations([{ path: t, text: ok }])).toEqual([]);
    expect(findViolations([{ path: t, text: `${ok}\n${ok}` }]).length).toBe(1);
    expect(findViolations([{ path: t, text: ok.replace(guid, "app-1") }]).length).toBe(1);
    expect(
      findViolations([{ path: t, text: ok.replace(`filter=id+eq+${guid}`, "top=5") }]).length,
    ).toBe(1);
  });

  test("the probe is allowed only while it never names extensions", () => {
    const p = "scripts/probe-continia-env.ts";
    const companies = `const u = \`\${o}/${NEEDLE}/v2.0/companies\`;`;
    expect(findViolations([{ path: p, text: companies }])).toEqual([]);
    expect(findViolations([{ path: p, text: `${companies}\n// extensions` }]).length).toBe(1);
  });
});
