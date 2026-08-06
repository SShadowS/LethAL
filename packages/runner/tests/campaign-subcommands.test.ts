/**
 * The wiring tests for `lethal campaign freeze | anchors | compare`.
 *
 * `assertCommitted` (campaign-git.ts) is pure and trusts its injected `status` COMPLETELY — it has
 * no way to verify that `status(path)` is actually about `path`. That is the correct scope for a
 * pure function and its header says so, which means the entire fail-closed guarantee rests on the
 * wiring in `campaign-subcommands.ts`. So the wiring half of this file runs against a REAL git
 * repository (`makeRepo` below), not a fake: every claim here about what git does was measured, and
 * a fake would only re-assert my own beliefs about git's behaviour back at me.
 *
 * Four measured facts this file exists to keep closed, each of which makes git answer "nothing to
 * report" — indistinguishable, to `assertCommitted`, from "clean":
 *   1. `git status --porcelain -- docs/missing.md` on a path that does NOT EXIST: exit 0, no output.
 *   2. ... on a GITIGNORED, never-committed file: exit 0, no output.
 *   3. ... with a whitespace-only pathspec (`"   "`): exit 0, no output. (The EMPTY string is a
 *      `fatal:` — the whitespace one is not, which is the dangerous half.)
 *   4. A pathspec is a GLOB by default: `docs/[ab]tricky.md` also matches `docs/atricky.md`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { normalizeForComparison } from "../itest/mutant-equality";
import { UncommittedPathError } from "../src/campaign-git";
import {
  CampaignGitInvocationError,
  type GitRunner,
  assertCampaignPathsCommitted,
  createRepoGitRunner,
  runCampaignAnchors,
  runCampaignCompare,
  runCampaignFreeze,
} from "../src/campaign-subcommands";
import type { MutantOutcome, SessionReport } from "../src/report";

// ---------------------------------------------------------------------------------------------
// Real-git fixtures
// ---------------------------------------------------------------------------------------------

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${stderr}`);
  return stdout;
}

/**
 * The error `p` rejected with — and a FAILURE if it resolved instead. `.catch((e) => e)` alone
 * yields `undefined` for a call that did not throw, and every subsequent `expect` on it then reads
 * as "no match found", which is indistinguishable from a passing assertion in the direction that
 * matters here: these tests exist to catch a gate that PASSED where it should have refused.
 */
async function refusalFrom(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
  throw new Error("expected this call to refuse, but it resolved");
}

async function writeAt(root: string, rel: string, content: string): Promise<void> {
  const abs = join(root, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
}

/** A real repository with `files` committed in one commit. `realpathSync` because the containment
 *  checks in `campaign-manifest.ts` compare real paths, and a temp dir can be a link. */
async function makeRepo(files: Record<string, string>): Promise<string> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "lethal-campaign-cli-")));
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "campaign@example.invalid"]);
  await git(root, ["config", "user.name", "Campaign Fixture"]);
  for (const [rel, content] of Object.entries(files)) await writeAt(root, rel, content);
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-qm", "campaign fixture"]);
  return root;
}

// ---------------------------------------------------------------------------------------------
// Report fixtures
// ---------------------------------------------------------------------------------------------

function outcome(
  overrides: Partial<MutantOutcome> & Pick<MutantOutcome, "mutantCode">,
): MutantOutcome {
  return {
    file: "SandboxLogic.Codeunit.al",
    line: 100,
    operatorName: "conditional-boundary",
    verdict: "survived",
    batchIndex: 0,
    astHash: `hash-${overrides.mutantCode}`,
    codeunitName: "Sandbox Logic",
    operatorMajor: 1,
    runner: "fenced",
    durationMs: 0,
    procedureName: "Post",
    startIndex: 0,
    endIndex: 1,
    originalText: "Original();",
    mutatedText: "",
    coveringTests: [],
    ...overrides,
  };
}

function report(mutants: readonly MutantOutcome[]): SessionReport {
  return {
    schemaVersion: 2,
    validity: {
      reliability: "full" as const,
      caveats: [],
      scoreDescribes: "test fixture",
      baselineTests: { total: 0, failing: 0 },
      scoredMutants: { scored: 0, recorded: 0 },
      executionContexts: [
        {
          runner: "fenced",
          guiAllowed: false,
          clientType: "ODataV4",
          basis: "test fixture",
          verdictCount: mutants.length,
        },
      ],
    },
    survivorsByProcedure: [],
    testFiles: {},
    backend: "bcdev",
    authoritative: true,
    baselineGreen: true,
    batches: 1,
    counts: {
      killed: mutants.filter((m) => m.verdict === "killed").length,
      survived: mutants.filter((m) => m.verdict === "survived").length,
      noCoverage: mutants.filter((m) => m.verdict === "no-coverage").length,
      timeoutKilled: mutants.filter((m) => m.verdict === "timeout-killed").length,
      knownSurvivors: mutants.filter((m) => m.verdict === "known-survivor").length,
      unstable: 0,
      errors: mutants.filter((m) => m.verdict === "error").length,
      deadlineExceeded: 0,
    },
    mutationScore: null,
    mutants,
    unsupportedTests: [],
    notInstrumented: { totalFiles: 0, fileCount: 0, siteCount: 0, files: [] },
    timings: {
      totalMs: 0,
      generateMutationSetMs: 0,
      deployMs: 0,
      baselineMs: 0,
      mutantsMs: 0,
      perMutant: { count: 0, meanMs: 0, medianMs: 0, p95Ms: 0, maxMs: 0 },
    },
    untargetedTriggerCount: 0,
  };
}

/** Two mutants, one killed and one survived, both on lines the PASSING anchor config covers. */
const TWO_MUTANTS = report([
  outcome({
    mutantCode: "M0001",
    verdict: "killed",
    killingTest: "SandboxTests.PostsOk",
    line: 100,
  }),
  outcome({ mutantCode: "M0002", verdict: "survived", line: 101 }),
]);

const THREE_MUTANTS = report([
  outcome({
    mutantCode: "M0001",
    verdict: "killed",
    killingTest: "SandboxTests.PostsOk",
    line: 100,
  }),
  outcome({ mutantCode: "M0002", verdict: "survived", line: 101 }),
  outcome({
    mutantCode: "M0003",
    verdict: "killed",
    killingTest: "SandboxTests.AlsoOk",
    line: 102,
  }),
]);

/** The same two mutants, but M0002 came back killed — a per-mutant regression `compare` must see. */
const TWO_MUTANTS_CHANGED = report([
  outcome({
    mutantCode: "M0001",
    verdict: "killed",
    killingTest: "SandboxTests.PostsOk",
    line: 100,
  }),
  outcome({
    mutantCode: "M0002",
    verdict: "killed",
    killingTest: "SandboxTests.NowKills",
    line: 101,
  }),
]);

const PASSING_ANCHORS = {
  expectedMutantCount: 2,
  expectedBaselineTests: 56,
  coveredProcedureRanges: [{ name: "Post", startLine: 90, endLine: 200 }],
  reconcileNotInstrumented: false,
};

/** Same shape, but the covered range excludes lines 100/101 — anchor 2 (coverage-location) fails. */
const FAILING_ANCHORS = {
  ...PASSING_ANCHORS,
  coveredProcedureRanges: [{ name: "Elsewhere", startLine: 900, endLine: 1000 }],
};

// A records directory that CANNOT coincide with this repo's own production default
// (`docs/campaign/2026-08-03-do`) — see task 2's fix round 1, where a fixture colliding with the
// production default let a mutant that ignored the file entirely pass.
const RECORDS_DIR = "campaign-records/2099-01-01-fixture";
const MANIFEST = JSON.stringify({
  recordsDir: RECORDS_DIR,
  campaignId: "fixture-campaign-77",
});

function rec(name: string): string {
  return `${RECORDS_DIR}/${name}`;
}

// ---------------------------------------------------------------------------------------------
// 1. The git wiring — measured against real git
// ---------------------------------------------------------------------------------------------

describe("assertCampaignPathsCommitted — the wiring assertCommitted trusts", () => {
  let repo: string;
  let deps: { readonly git: GitRunner; readonly repoRoot: string };

  beforeAll(async () => {
    repo = await makeRepo({
      ".gitignore": "docs/ignored.md\n",
      "docs/clean.md": "committed and untouched\n",
      "docs/modified.md": "committed\n",
      "docs/clean space.md": "committed and untouched\n",
      "docs/with space.md": "committed\n",
      "docs/café.md": "committed\n",
      // `[` and `]` are legal in a filename on both Windows and POSIX, and are git pathspec GLOB
      // metacharacters. Without `--literal-pathspecs` the pathspec `docs/[ab]tricky.md` ALSO
      // matches the decoy below — measured.
      "docs/[ab]tricky.md": "committed\n",
      "docs/atricky.md": "the decoy a glob would hit — committed and untouched\n",
    });
    for (const f of [
      "docs/modified.md",
      "docs/with space.md",
      "docs/café.md",
      "docs/[ab]tricky.md",
    ])
      await writeAt(repo, f, "EDITED AFTER THE RUN\n");
    await writeAt(repo, "docs/untracked.md", "never added\n");
    await writeAt(repo, "docs/ignored.md", "gitignored, never committed\n");
    deps = { git: createRepoGitRunner(repo), repoRoot: repo };
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  test("a tracked, clean file passes", async () => {
    await expect(assertCampaignPathsCommitted(["docs/clean.md"], deps)).resolves.toBeUndefined();
  });

  test("a MODIFIED tracked file is refused, naming it", async () => {
    await expect(assertCampaignPathsCommitted(["docs/modified.md"], deps)).rejects.toThrow(
      /docs\/modified\.md/,
    );
  });

  test("an UNTRACKED file is refused", async () => {
    await expect(assertCampaignPathsCommitted(["docs/untracked.md"], deps)).rejects.toThrow(
      /untracked|not committed|not known to git/i,
    );
  });

  test("a pre-commitment that DOES NOT EXIST is refused — git itself calls it clean", async () => {
    // The measurement this guard exists for. git answers "nothing to report", exit 0 — which
    // `assertCommitted` reads as clean, i.e. a missing pre-commitment would PASS the gate.
    const raw = await deps.git([
      "--no-optional-locks",
      "--literal-pathspecs",
      "status",
      "--porcelain",
      "-z",
      "--",
      "docs/never-written.md",
    ]);
    expect(raw.code).toBe(0);
    expect(raw.stdout).toBe("");

    await expect(assertCampaignPathsCommitted(["docs/never-written.md"], deps)).rejects.toThrow(
      /does not exist/i,
    );
  });

  test("a GITIGNORED, never-committed file is refused — git says nothing about it either", async () => {
    const raw = await deps.git([
      "--no-optional-locks",
      "--literal-pathspecs",
      "status",
      "--porcelain",
      "-z",
      "--",
      "docs/ignored.md",
    ]);
    expect(raw.code).toBe(0);
    expect(raw.stdout).toBe(""); // it EXISTS and is dirty in every human sense; git is silent

    await expect(assertCampaignPathsCommitted(["docs/ignored.md"], deps)).rejects.toThrow(
      /not known to git|untracked/i,
    );
  });

  test("a whitespace-only path is refused — git exits 0 and reports nothing for it", async () => {
    const raw = await deps.git([
      "--no-optional-locks",
      "--literal-pathspecs",
      "status",
      "--porcelain",
      "-z",
      "--",
      "   ",
    ]);
    expect(raw.code).toBe(0);
    expect(raw.stdout).toBe("");

    await expect(assertCampaignPathsCommitted(["   "], deps)).rejects.toThrow(/blank|empty/i);
  });

  test("an empty-string path is refused", async () => {
    await expect(assertCampaignPathsCommitted([""], deps)).rejects.toThrow(/blank|empty/i);
  });

  test("an empty paths array is refused — a check that verifies nothing is not a pass", async () => {
    await expect(assertCampaignPathsCommitted([], deps)).rejects.toThrow(/empty paths array/i);
  });

  test("EVERY dirty path is named in ONE refusal", async () => {
    const err = await refusalFrom(
      assertCampaignPathsCommitted(["docs/modified.md", "docs/clean.md", "docs/café.md"], deps),
    );
    expect(err).toBeInstanceOf(UncommittedPathError);
    expect(err.message).toContain("docs/modified.md");
    expect(err.message).toContain("docs/café.md");
    expect((err as UncommittedPathError).paths).toHaveLength(2);
  });

  test("a path with a SPACE is one pathspec, not two — clean passes, dirty is refused by full name", async () => {
    // A shell-string invocation would split this into `docs/with` and `space.md`: two pathspecs,
    // neither of which exists, and git would answer "nothing to report" for both — a false PASS on
    // an edited pre-commitment.
    await expect(
      assertCampaignPathsCommitted(["docs/clean space.md"], deps),
    ).resolves.toBeUndefined();
    await expect(assertCampaignPathsCommitted(["docs/with space.md"], deps)).rejects.toThrow(
      /docs\/with space\.md/,
    );
  });

  test("a filename holding glob metacharacters is matched LITERALLY, not expanded", async () => {
    // Measured: WITHOUT `--literal-pathspecs`, `git ls-files -- 'docs/[ab]tricky.md'` returns TWO
    // paths — the file itself AND `docs/atricky.md`, which is clean. The decoy is committed clean
    // on purpose: it is what a glob-expanded pathspec would report on instead.
    await expect(assertCampaignPathsCommitted(["docs/atricky.md"], deps)).resolves.toBeUndefined();
    const err = await refusalFrom(assertCampaignPathsCommitted(["docs/[ab]tricky.md"], deps));
    // The CLASS is the discriminator, not just the fact of a refusal. Dropping `--literal-pathspecs`
    // makes `ls-files` resolve this pathspec to TWO files, and the echo check then refuses it as a
    // `CampaignGitInvocationError` — also a refusal, and also carrying this filename in its message,
    // so asserting only "it threw naming the file" would stay green with the flag removed.
    expect(err).toBeInstanceOf(UncommittedPathError);
    expect(err).not.toBeInstanceOf(CampaignGitInvocationError);
    expect(err.message).toContain("[ab]tricky.md");
  });

  test("a non-ASCII path is named UNQUOTED in the refusal", async () => {
    // Default `core.quotePath` renders this as `"docs/caf\303\251.md"` — a different string than
    // the one the caller passed, and one no operator can grep for. `-z` never quotes.
    const err = await refusalFrom(assertCampaignPathsCommitted(["docs/café.md"], deps));
    expect(err.message).toContain("docs/café.md");
    expect(err.message).not.toContain("\\303");
  });

  test("an absolute path is refused — this gate speaks repo-relative paths only", async () => {
    await expect(assertCampaignPathsCommitted([join(repo, "docs/clean.md")], deps)).rejects.toThrow(
      /absolute|repository-relative/i,
    );
  });

  test("a path escaping the repository root is refused", async () => {
    await expect(assertCampaignPathsCommitted(["../outside.md"], deps)).rejects.toThrow(
      /outside the repository/i,
    );
  });

  test("git failing to answer is a refusal, not a pass", async () => {
    const failing: GitRunner = async () => ({ code: 128, stdout: "", stderr: "fatal: bad thing" });
    await expect(
      assertCampaignPathsCommitted(["docs/clean.md"], { git: failing, repoRoot: repo }),
    ).rejects.toBeInstanceOf(CampaignGitInvocationError);
  });

  test("git echoing a DIFFERENT path than the one asked about is refused", async () => {
    // The one thing `assertCommitted` cannot check for itself. `ls-files` echoes the paths its
    // pathspec resolved to, and this wiring requires that echo to be exactly the path it asked
    // about — so an answer about some other file can never be read as an answer about this one.
    const liar: GitRunner = async (args) =>
      args.includes("ls-files")
        ? { code: 0, stdout: "docs/some-other-file.md\0", stderr: "" }
        : { code: 0, stdout: "", stderr: "" };
    const err = await refusalFrom(
      assertCampaignPathsCommitted(["docs/clean.md"], { git: liar, repoRoot: repo }),
    );
    expect(err).toBeInstanceOf(CampaignGitInvocationError);
    expect(err.message).toContain("docs/some-other-file.md");
  });

  test("git echoing TWO paths for one pathspec is refused — the glob-expansion signature", async () => {
    const globby: GitRunner = async (args) =>
      args.includes("ls-files")
        ? { code: 0, stdout: "docs/[ab]tricky.md\0docs/atricky.md\0", stderr: "" }
        : { code: 0, stdout: "", stderr: "" };
    await expect(
      assertCampaignPathsCommitted(["docs/[ab]tricky.md"], { git: globby, repoRoot: repo }),
    ).rejects.toBeInstanceOf(CampaignGitInvocationError);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. The subcommands
// ---------------------------------------------------------------------------------------------

describe("lethal campaign freeze | anchors | compare", () => {
  let repo: string;
  let manifestPath: string;
  let reportPath: string;
  let threeMutantReportPath: string;
  let changedReportPath: string;
  let recordsDir: string;

  beforeAll(async () => {
    const baseline = JSON.stringify(normalizeForComparison(TWO_MUTANTS), null, 2);
    repo = await makeRepo({
      "campaign.json": MANIFEST,
      [rec("rung-ok.precommit.md")]: "# rung-ok\n\n2 mutants expected.\n",
      [rec("rung-ok.anchors.json")]: JSON.stringify(PASSING_ANCHORS, null, 2),
      [rec("rung-fail.precommit.md")]: "# rung-fail\n",
      [rec("rung-fail.anchors.json")]: JSON.stringify(FAILING_ANCHORS, null, 2),
      [rec("rung-dirty.precommit.md")]: "# rung-dirty\n",
      [rec("rung-crosscheck.precommit.md")]: "# rung-crosscheck\n",
      // Pre-committed at 2 while the caller will claim 3 — the cross-check, isolated from the
      // cardinality check by handing freeze a report that really does hold 3 mutants.
      [rec("rung-crosscheck.anchors.json")]: JSON.stringify(PASSING_ANCHORS, null, 2),
      [rec("rung-cmp.precommit.md")]: "# rung-cmp\n",
      [rec("rung-cmp.baseline.json")]: baseline,
      [rec("rung-nobaseline.precommit.md")]: "# rung-nobaseline\n",
      [rec("rung-freeze.precommit.md")]: "# rung-freeze\n",
    });
    manifestPath = join(repo, "campaign.json");
    recordsDir = join(repo, RECORDS_DIR);

    // Dirty and untracked pre-commitments, created AFTER the commit.
    await writeAt(repo, rec("rung-dirty.precommit.md"), "# rung-dirty\n\nEDITED AFTER THE RUN\n");
    await writeAt(repo, rec("rung-untracked.precommit.md"), "# rung-untracked\n");

    const outDir = realpathSync(await mkdtemp(join(tmpdir(), "lethal-campaign-out-")));
    reportPath = join(outDir, "report.json");
    threeMutantReportPath = join(outDir, "report-3.json");
    changedReportPath = join(outDir, "report-changed.json");
    await writeFile(reportPath, JSON.stringify(TWO_MUTANTS), "utf8");
    await writeFile(threeMutantReportPath, JSON.stringify(THREE_MUTANTS), "utf8");
    await writeFile(changedReportPath, JSON.stringify(TWO_MUTANTS_CHANGED), "utf8");
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  // ---- freeze -------------------------------------------------------------------------------

  test("freeze refuses when the pre-commitment is UNCOMMITTED, and writes nothing", async () => {
    await expect(
      runCampaignFreeze({
        manifestPath,
        rung: "rung-untracked",
        reportPath,
        expectedMutantCount: 2,
      }),
    ).rejects.toThrow(/precommit/);
    // The refusal has to come BEFORE any records-directory write: `assertMatchesBaseline`
    // self-records when the baseline file is absent, so a freeze that ran first and refused second
    // would have minted `rung-untracked.baseline.json` from the very run it then rejected.
    const written = (await readdir(recordsDir)).filter((f) => f.startsWith("rung-untracked."));
    expect(written).toEqual(["rung-untracked.precommit.md"]);
  });

  test("freeze refuses when the pre-commitment is DIRTY", async () => {
    await expect(
      runCampaignFreeze({ manifestPath, rung: "rung-dirty", reportPath, expectedMutantCount: 2 }),
    ).rejects.toThrow(/rung-dirty\.precommit\.md/);
    const written = (await readdir(recordsDir)).filter((f) => f.startsWith("rung-dirty."));
    expect(written).toEqual(["rung-dirty.precommit.md"]);
  });

  test("freeze archives the report and the per-mutant baseline when everything is committed", async () => {
    const code = await runCampaignFreeze({
      manifestPath,
      rung: "rung-freeze",
      reportPath,
      expectedMutantCount: 2,
    });
    expect(code).toBe(0);
    const written = (await readdir(recordsDir)).filter((f) => f.startsWith("rung-freeze.")).sort();
    expect(written).toEqual([
      "rung-freeze.baseline.json",
      "rung-freeze.precommit.md",
      "rung-freeze.report.json",
    ]);
    const archived = JSON.parse(
      await readFile(join(recordsDir, "rung-freeze.report.json"), "utf8"),
    ) as SessionReport;
    expect(archived.mutants).toHaveLength(2);
  });

  test("freeze refuses when --expect-mutants disagrees with the COMMITTED anchor count", async () => {
    // Cardinality alone cannot catch this: the report really does hold 3 mutants, so `3` passes
    // `assertCardinality`. What it contradicts is the number pre-committed BEFORE the run.
    await expect(
      runCampaignFreeze({
        manifestPath,
        rung: "rung-crosscheck",
        reportPath: threeMutantReportPath,
        expectedMutantCount: 3,
      }),
    ).rejects.toThrow(/pre-committed .*2.*3|expectedMutantCount/);
  });

  test("freeze checks git BEFORE anything else", async () => {
    const order: string[] = [];
    await runCampaignFreeze({
      manifestPath,
      rung: "rung-untracked",
      reportPath,
      expectedMutantCount: 2,
      onStep: (s) => order.push(s),
    }).catch(() => {});
    expect(order[0]).toBe("assert-committed");
  });

  // ---- anchors ------------------------------------------------------------------------------

  test("campaign anchors returns 0 when every anchor passes", async () => {
    const lines: string[] = [];
    const code = await runCampaignAnchors({
      manifestPath,
      rung: "rung-ok",
      reportPath,
      log: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("PASS coverage-location");
  });

  test("campaign anchors exits non-zero when an anchor fails", async () => {
    const lines: string[] = [];
    const code = await runCampaignAnchors({
      manifestPath,
      rung: "rung-fail",
      reportPath,
      log: (l) => lines.push(l),
    });
    expect(code).not.toBe(0);
    expect(lines.join("\n")).toContain("FAIL coverage-location");
  });

  test("campaign anchors asserts cardinality BEFORE reading any anchor", async () => {
    // `assertMatchesBaseline` self-records when the baseline file is absent, so a cardinality check
    // running second would freeze a truncated report and then compare it against itself. The git
    // check comes first of all (the brief's own "before doing anything else"), so what is pinned
    // here is: cardinality is the first step that TOUCHES THE REPORT, and it precedes every anchor.
    const order: string[] = [];
    await runCampaignAnchors({
      manifestPath,
      rung: "rung-ok",
      reportPath,
      onStep: (s) => order.push(s),
    }).catch(() => {});
    expect(order[0]).toBe("assert-committed");
    expect(order[1]).toBe("cardinality");
    expect(order.indexOf("cardinality")).toBeLessThan(order.indexOf("anchors"));
    expect(order.indexOf("anchors")).toBeGreaterThan(-1);
  });

  test("campaign anchors refuses when the anchor config is UNCOMMITTED", async () => {
    await expect(
      runCampaignAnchors({ manifestPath, rung: "rung-untracked", reportPath }),
    ).rejects.toThrow(/rung-untracked/);
  });

  test("campaign anchors throws on a cardinality mismatch rather than reporting a pass", async () => {
    await expect(
      runCampaignAnchors({ manifestPath, rung: "rung-ok", reportPath: threeMutantReportPath }),
    ).rejects.toThrow(/cardinality|expected 2, got 3/);
  });

  // ---- compare ------------------------------------------------------------------------------

  test("compare returns 0 when the report matches the committed baseline", async () => {
    const lines: string[] = [];
    const code = await runCampaignCompare({
      manifestPath,
      rung: "rung-cmp",
      reportPath,
      log: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(/identical|no per-mutant difference/i);
  });

  test("compare returns non-zero and NAMES the mutant when a verdict differs", async () => {
    const lines: string[] = [];
    const code = await runCampaignCompare({
      manifestPath,
      rung: "rung-cmp",
      reportPath: changedReportPath,
      log: (l) => lines.push(l),
    });
    expect(code).not.toBe(0);
    expect(lines.join("\n")).toContain("hash-M0002");
    expect(lines.join("\n")).toContain("survived");
  });

  test("compare REFUSES when the committed baseline is absent — it never records one", async () => {
    // The difference between `compare` and `freeze`: `assertMatchesBaseline` mints a baseline when
    // none exists. A comparison that did that would report "matches" against a file it had just
    // written from the report it was comparing.
    const baselinePath = join(recordsDir, "rung-nobaseline.baseline.json");
    expect(existsSync(baselinePath)).toBe(false);
    await expect(
      runCampaignCompare({ manifestPath, rung: "rung-nobaseline", reportPath }),
    ).rejects.toThrow(/baseline/);
    expect(existsSync(baselinePath)).toBe(false);
  });

  test("compare refuses a report that is not the committed baseline's size", async () => {
    await expect(
      runCampaignCompare({ manifestPath, rung: "rung-cmp", reportPath: threeMutantReportPath }),
    ).rejects.toThrow(/expected 2, got 3/);
  });

  // ---- shared argument validation ------------------------------------------------------------

  test("a rung name holding a path separator is refused", async () => {
    for (const rung of ["../rung-ok", "sub/rung-ok", "..", "rung ok"]) {
      await expect(runCampaignAnchors({ manifestPath, rung, reportPath })).rejects.toThrow(/rung/i);
    }
  });

  test("an unreadable manifest is refused by name", async () => {
    await expect(
      runCampaignAnchors({ manifestPath: join(repo, "no-such.json"), rung: "rung-ok", reportPath }),
    ).rejects.toThrow(/no-such\.json/);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. The exit code — spawned, because only `main()` owns it
// ---------------------------------------------------------------------------------------------

/**
 * Moved here from `campaign-anchors-run.test.ts`, which spawned `scripts/campaign/anchors.ts` — a
 * file this task deleted, so that `lethal campaign anchors` is the ONLY way to run the gate and
 * therefore the only way to run it that cannot skip the git check. Its point is unchanged: a
 * driver that printed "FAIL" and exited 0 would be read as a pass by every CI step that ran it.
 */
describe("lethal campaign anchors (exit code, spawned)", () => {
  const CLI = join(import.meta.dir, "..", "src", "cli.ts");
  let repo: string;
  let manifestPath: string;
  let passingReport: string;
  let threeMutantReport: string;

  beforeAll(async () => {
    repo = await makeRepo({
      "campaign.json": MANIFEST,
      [rec("rung-ok.precommit.md")]: "# rung-ok\n",
      [rec("rung-ok.anchors.json")]: JSON.stringify(PASSING_ANCHORS, null, 2),
      [rec("rung-fail.precommit.md")]: "# rung-fail\n",
      [rec("rung-fail.anchors.json")]: JSON.stringify(FAILING_ANCHORS, null, 2),
    });
    manifestPath = join(repo, "campaign.json");
    passingReport = join(repo, "report.json");
    threeMutantReport = join(repo, "report-3.json");
    await writeFile(passingReport, JSON.stringify(TWO_MUTANTS), "utf8");
    await writeFile(threeMutantReport, JSON.stringify(THREE_MUTANTS), "utf8");
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  async function run(rung: string, reportFile: string): Promise<{ code: number; out: string }> {
    const proc = Bun.spawn(
      [
        "bun",
        CLI,
        "campaign",
        "anchors",
        "--manifest",
        manifestPath,
        "--rung",
        rung,
        "--report",
        reportFile,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { code, out: out + err };
  }

  test("exits 0 when every anchor passes", async () => {
    const { code, out } = await run("rung-ok", passingReport);
    expect(out).toContain("PASS baseline-green");
    expect(code).toBe(0);
  });

  test("exits NON-ZERO when one anchor fails", async () => {
    const { code, out } = await run("rung-fail", passingReport);
    expect(out).toContain("FAIL coverage-location");
    expect(code).not.toBe(0);
  });

  test("exits NON-ZERO on a cardinality mismatch", async () => {
    const { code, out } = await run("rung-ok", threeMutantReport);
    // Asserted on the OUTPUT as well as the code: a CLI that failed to parse its own arguments
    // also exits non-zero, and this test passed for exactly that reason while `--manifest` was
    // still an unknown option.
    expect(out).toContain("expected 2, got 3");
    expect(code).not.toBe(0);
  });
});
