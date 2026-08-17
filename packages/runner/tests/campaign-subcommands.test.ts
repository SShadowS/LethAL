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

/**
 * A HERMETIC git environment for the fixture repositories.
 *
 * Measured on a hosted `windows-latest` runner (CI run 32075875426, 2026-08-17): `git commit` in a
 * fresh temp repo exceeded the 5 s default test timeout and was killed, so the suite failed with
 * `git commit ... failed (143)` — SIGTERM, empty stderr — on a commit that only touched a markdown
 * file. It had passed on the commit before and the commit after, which is the signature of a flaky
 * gate rather than a defect, and a flaky gate is how people learn to ignore a red build.
 *
 * Disabling the global and system config is both the speed fix and a correctness one: a fixture
 * repository should not inherit the machine's `hooksPath`, `commit.gpgsign`, or anything else the
 * developer happens to have set. `GIT_TERMINAL_PROMPT=0` makes any credential prompt an error
 * instead of a hang, which is the other way a spawned git eats a timeout.
 */
/**
 * Bun applies the same 5 s default timeout to a HOOK as to a test, and a `beforeAll` here spawns
 * git four or five times against a fresh temp directory. That fits comfortably on a developer
 * machine and did not on a cold hosted runner (CI 32075875426). Generous on purpose: this number
 * exists to stop a slow filesystem reading as a failure, so there is nothing to gain by tuning it
 * close to the observed cost.
 */
const HOOK_TIMEOUT_MS = 60_000;

const HERMETIC_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: join(tmpdir(), "lethal-nonexistent-gitconfig"),
  GIT_CONFIG_SYSTEM: join(tmpdir(), "lethal-nonexistent-gitconfig"),
  GIT_TERMINAL_PROMPT: "0",
};

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: HERMETIC_GIT_ENV,
  });
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
    declarativeSites: { siteCount: 0, fileCount: 0, files: [] },
    timings: {
      totalMs: 0,
      generateMutationSetMs: 0,
      deployMs: 0,
      baselineMs: 0,
      mutantsMs: 0,
      perMutant: { count: 0, meanMs: 0, medianMs: 0, p95Ms: 0, maxMs: 0 },
    },
    preprocessorSymbols: [],
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

/** The stage-2 gate item: turning it on makes `--project` REQUIRED, so a `projectDir` the CLI
 *  adapter dropped surfaces as a throw rather than a silently skipped check. */
const RECONCILING_ANCHORS = { ...PASSING_ANCHORS, reconcileNotInstrumented: true };

/** `TWO_MUTANTS` plus one file the report claims is uninstrumentable. At least one is required:
 *  `reconcileNotInstrumented` reports `checked === 0` as NOT passed, because "every listed file is
 *  uninstrumentable" over zero files is vacuous rather than satisfied. */
const RECON_REPORT: SessionReport = {
  ...TWO_MUTANTS,
  notInstrumented: {
    totalFiles: 1,
    fileCount: 1,
    siteCount: 1,
    files: [{ file: "Probe.Page.al", kinds: "page_declaration", sites: 1 }],
  },
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
    // STAGED ONLY — `git add`ed after the commit and never committed. The one category the module
    // header claims ("uncommitted, untracked, ignored, staged-only, modified or missing") that had
    // no real-git test of its own; the nearest coverage was a SYNTHETIC porcelain string against
    // the pure `assertCommitted`, which is inference from the fail-closed design rather than a
    // measurement through this wiring.
    await writeAt(repo, "docs/staged.md", "written and `git add`ed after the run\n");
    await git(repo, ["add", "--", "docs/staged.md"]);
    deps = { git: createRepoGitRunner(repo), repoRoot: repo };
  }, HOOK_TIMEOUT_MS);

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

  test("a STAGED-ONLY file is refused — `git add` is not a commit", async () => {
    // Staged-only is the one category in this module's header claim that reaches `assertCommitted`
    // itself rather than being stopped by an earlier check, so measure WHICH layer catches it:
    // the file exists, and `ls-files` DOES list it (a staged path is in the index), so both
    // pre-checks pass and it is the porcelain status that refuses.
    const echo = await deps.git([
      "--no-optional-locks",
      "--literal-pathspecs",
      "ls-files",
      "-z",
      "--",
      "docs/staged.md",
    ]);
    expect(echo.stdout).toBe("docs/staged.md\0"); // tracked, so the pre-checks let it through

    const err = await refusalFrom(assertCampaignPathsCommitted(["docs/staged.md"], deps));
    expect(err).toBeInstanceOf(UncommittedPathError);
    // The REAL porcelain code git produced, carried through the -z join un-mangled.
    expect(err.message).toContain('"A  docs/staged.md"');
    // ... and the rule's own sentence, which names this exact case.
    expect(err.message).toContain("never staged or edited after seeing the results");
    expect((err as UncommittedPathError).paths).toEqual(["docs/staged.md"]);
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
    // NOTE this runner fails the FIRST call, which is `ls-files` — so it can only ever prove
    // `trackedEcho`'s half of "a non-zero exit is a refusal". It never reaches `porcelainStatus`,
    // and that is exactly what let `porcelainStatus`'s own guard hide: mutating it to `return ""`
    // left this test (and the whole suite) green. The next test covers the other half; do not
    // delete it as a duplicate of this one.
    const failing: GitRunner = async () => ({ code: 128, stdout: "", stderr: "fatal: bad thing" });
    await expect(
      assertCampaignPathsCommitted(["docs/clean.md"], { git: failing, repoRoot: repo }),
    ).rejects.toBeInstanceOf(CampaignGitInvocationError);
  });

  test("a `git status` that fails AFTER ls-files succeeded is a refusal, not 'clean'", async () => {
    // The dangerous ordering: the echo check passes, so the path is proven tracked, and then the
    // one call that decides clean-vs-dirty dies. Reporting "" there is a fail-OPEN — a corrupt
    // index, a concurrent `index.lock`, or a killed subprocess would each mark every
    // pre-commitment committed.
    const statusFails: GitRunner = async (args) =>
      args.includes("ls-files")
        ? { code: 0, stdout: "docs/clean.md\0", stderr: "" }
        : { code: 128, stdout: "", stderr: "fatal: index file corrupt" };
    const err = await refusalFrom(
      assertCampaignPathsCommitted(["docs/clean.md"], { git: statusFails, repoRoot: repo }),
    );
    expect(err).toBeInstanceOf(CampaignGitInvocationError);
    expect(err.message).toContain("git status");
    expect(err.message).toContain("index file corrupt");
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
      [rec("stage-ok.precommit.md")]: "# stage-ok\n\n2 mutants expected.\n",
      [rec("stage-ok.anchors.json")]: JSON.stringify(PASSING_ANCHORS, null, 2),
      [rec("stage-fail.precommit.md")]: "# stage-fail\n",
      [rec("stage-fail.anchors.json")]: JSON.stringify(FAILING_ANCHORS, null, 2),
      [rec("stage-dirty.precommit.md")]: "# stage-dirty\n",
      [rec("stage-crosscheck.precommit.md")]: "# stage-crosscheck\n",
      // Pre-committed at 2 while the caller will claim 3 — the cross-check, isolated from the
      // cardinality check by handing freeze a report that really does hold 3 mutants.
      [rec("stage-crosscheck.anchors.json")]: JSON.stringify(PASSING_ANCHORS, null, 2),
      [rec("stage-cmp.precommit.md")]: "# stage-cmp\n",
      [rec("stage-cmp.baseline.json")]: baseline,
      [rec("stage-nobaseline.precommit.md")]: "# stage-nobaseline\n",
      [rec("stage-freeze.precommit.md")]: "# stage-freeze\n",
      // Fix round 1, Important 1/2: stages whose PRE-COMMITMENT is committed and clean, so the only
      // thing wrong is the OTHER file each verb is supposed to check. Without these, every "which
      // paths" mutation (drop the manifest, drop the anchors, drop the baseline) passes the suite.
      [rec("stage-dirtyanchors.precommit.md")]: "# stage-dirtyanchors\n",
      [rec("stage-dirtyanchors.anchors.json")]: JSON.stringify(PASSING_ANCHORS, null, 2),
      [rec("stage-dirtybaseline.precommit.md")]: "# stage-dirtybaseline\n",
      [rec("stage-dirtybaseline.baseline.json")]: baseline,
      [rec("stage-anchorsuntracked.precommit.md")]: "# stage-anchorsuntracked\n",
      // A stage with ALL THREE records committed and clean, so freeze's announced list pins every
      // path it checks — including the two conditional ones.
      [rec("stage-full.precommit.md")]: "# stage-full\n",
      [rec("stage-full.anchors.json")]: JSON.stringify(PASSING_ANCHORS, null, 2),
      [rec("stage-full.baseline.json")]: baseline,
    });
    manifestPath = join(repo, "campaign.json");
    recordsDir = join(repo, RECORDS_DIR);

    // Dirty and untracked pre-commitments, created AFTER the commit.
    await writeAt(repo, rec("stage-dirty.precommit.md"), "# stage-dirty\n\nEDITED AFTER THE RUN\n");
    await writeAt(repo, rec("stage-untracked.precommit.md"), "# stage-untracked\n");
    // ... and the same treatment for the non-precommit records, leaving each precommit clean.
    await writeAt(
      repo,
      rec("stage-dirtyanchors.anchors.json"),
      `${JSON.stringify({ ...PASSING_ANCHORS, expectedMutantCount: 999 }, null, 2)}\n`,
    );
    await writeAt(repo, rec("stage-dirtybaseline.baseline.json"), "[]\n");
    await writeAt(
      repo,
      rec("stage-anchorsuntracked.anchors.json"),
      JSON.stringify(PASSING_ANCHORS, null, 2),
    );

    const outDir = realpathSync(await mkdtemp(join(tmpdir(), "lethal-campaign-out-")));
    reportPath = join(outDir, "report.json");
    threeMutantReportPath = join(outDir, "report-3.json");
    changedReportPath = join(outDir, "report-changed.json");
    await writeFile(reportPath, JSON.stringify(TWO_MUTANTS), "utf8");
    await writeFile(threeMutantReportPath, JSON.stringify(THREE_MUTANTS), "utf8");
    await writeFile(changedReportPath, JSON.stringify(TWO_MUTANTS_CHANGED), "utf8");
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  // ---- freeze -------------------------------------------------------------------------------

  test("freeze refuses when the pre-commitment is UNCOMMITTED, and writes nothing", async () => {
    await expect(
      runCampaignFreeze({
        manifestPath,
        stage: "stage-untracked",
        reportPath,
        expectedMutantCount: 2,
      }),
    ).rejects.toThrow(/precommit/);
    // The refusal has to come BEFORE any records-directory write: `assertMatchesBaseline`
    // self-records when the baseline file is absent, so a freeze that ran first and refused second
    // would have minted `stage-untracked.baseline.json` from the very run it then rejected.
    const written = (await readdir(recordsDir)).filter((f) => f.startsWith("stage-untracked."));
    expect(written).toEqual(["stage-untracked.precommit.md"]);
  });

  test("freeze refuses when the pre-commitment is DIRTY", async () => {
    await expect(
      runCampaignFreeze({ manifestPath, stage: "stage-dirty", reportPath, expectedMutantCount: 2 }),
    ).rejects.toThrow(/stage-dirty\.precommit\.md/);
    const written = (await readdir(recordsDir)).filter((f) => f.startsWith("stage-dirty."));
    expect(written).toEqual(["stage-dirty.precommit.md"]);
  });

  test("freeze archives the report and the per-mutant baseline when everything is committed", async () => {
    const code = await runCampaignFreeze({
      manifestPath,
      stage: "stage-freeze",
      reportPath,
      expectedMutantCount: 2,
    });
    expect(code).toBe(0);
    const written = (await readdir(recordsDir)).filter((f) => f.startsWith("stage-freeze.")).sort();
    expect(written).toEqual([
      "stage-freeze.baseline.json",
      "stage-freeze.precommit.md",
      "stage-freeze.report.json",
    ]);
    const archived = JSON.parse(
      await readFile(join(recordsDir, "stage-freeze.report.json"), "utf8"),
    ) as SessionReport;
    expect(archived.mutants).toHaveLength(2);
  });

  test("freeze refuses when --expect-mutants disagrees with the COMMITTED anchor count", async () => {
    // Cardinality alone cannot catch this: the report really does hold 3 mutants, so `3` passes
    // `assertCardinality`. What it contradicts is the number pre-committed BEFORE the run.
    await expect(
      runCampaignFreeze({
        manifestPath,
        stage: "stage-crosscheck",
        reportPath: threeMutantReportPath,
        expectedMutantCount: 3,
      }),
    ).rejects.toThrow(/pre-committed .*2.*3|expectedMutantCount/);
  });

  test("freeze checks git BEFORE anything else", async () => {
    const order: string[] = [];
    await runCampaignFreeze({
      manifestPath,
      stage: "stage-untracked",
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
      stage: "stage-ok",
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
      stage: "stage-fail",
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
      stage: "stage-ok",
      reportPath,
      onStep: (s) => order.push(s),
    }).catch(() => {});
    expect(order[0]).toBe("assert-committed");
    expect(order[1]).toBe("cardinality");
    expect(order.indexOf("cardinality")).toBeLessThan(order.indexOf("anchors"));
    expect(order.indexOf("anchors")).toBeGreaterThan(-1);
  });

  test("campaign anchors refuses when the ANCHOR CONFIG is uncommitted, precommit clean", async () => {
    // Fix round 1, Important 2: this used to point at `stage-untracked`, whose PRECOMMIT is
    // untracked and whose anchors.json does not exist at all — so it stayed green whichever of the
    // two paths was dropped, and did not test what it names. `stage-anchorsuntracked` has a
    // committed, clean precommit and an untracked anchors.json, so the only thing that can refuse
    // it is the anchor config being checked. `paths` pins that exactly.
    const err = await refusalFrom(
      runCampaignAnchors({ manifestPath, stage: "stage-anchorsuntracked", reportPath }),
    );
    expect(err).toBeInstanceOf(UncommittedPathError);
    expect((err as UncommittedPathError).paths).toEqual([
      rec("stage-anchorsuntracked.anchors.json"),
    ]);
  });

  test("campaign anchors throws on a cardinality mismatch rather than reporting a pass", async () => {
    await expect(
      runCampaignAnchors({ manifestPath, stage: "stage-ok", reportPath: threeMutantReportPath }),
    ).rejects.toThrow(/cardinality|expected 2, got 3/);
  });

  // ---- compare ------------------------------------------------------------------------------

  test("compare returns 0 when the report matches the committed baseline", async () => {
    const lines: string[] = [];
    const code = await runCampaignCompare({
      manifestPath,
      stage: "stage-cmp",
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
      stage: "stage-cmp",
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
    //
    // Fix round 1, Important 2: this used to assert only `.rejects.toThrow(/baseline/)`. Drop the
    // baseline from compare's checked paths and the rejection still matches — but it comes from
    // `readFile`'s "ENOENT: ... stage-nobaseline.baseline.json", which also contains "baseline", so
    // the GATE's refusal was never measured. Asserting the class plus a fragment only the gate
    // produces makes it fail for its stated reason.
    const baselinePath = join(recordsDir, "stage-nobaseline.baseline.json");
    expect(existsSync(baselinePath)).toBe(false);
    const err = await refusalFrom(
      runCampaignCompare({ manifestPath, stage: "stage-nobaseline", reportPath }),
    );
    expect(err).toBeInstanceOf(UncommittedPathError);
    expect(err.message).toContain("cannot have been committed before the run");
    expect((err as UncommittedPathError).paths).toEqual([rec("stage-nobaseline.baseline.json")]);
    expect(existsSync(baselinePath)).toBe(false);
  });

  test("compare refuses a report that is not the committed baseline's size", async () => {
    await expect(
      runCampaignCompare({ manifestPath, stage: "stage-cmp", reportPath: threeMutantReportPath }),
    ).rejects.toThrow(/expected 2, got 3/);
  });

  // ---- WHICH paths each verb checks (fix round 1, Important 1) --------------------------------
  //
  // Everything above pins HOW a path is checked and precisely WHEN. None of it pinned WHICH: each
  // of these four mutations passed the entire runner suite —
  //   `committedPaths` drops `c.manifestRel`;
  //   freeze's `records` drops `[anchors, baseline].filter(existsSync)`;
  //   anchors' `[precommit, anchors]` becomes `[precommit]`;
  //   compare's `[precommit, baselinePath]` becomes `[precommit]`.
  // Two independent pins per verb: the announced list (exact), and a stage whose PRE-COMMITMENT is
  // committed and clean so the only file that can refuse it is the other one.

  test("each verb ANNOUNCES exactly which committed paths it verified", async () => {
    const freezeLines: string[] = [];
    await runCampaignFreeze({
      manifestPath,
      stage: "stage-full",
      reportPath,
      expectedMutantCount: 2,
      log: (l) => freezeLines.push(l),
    });
    expect(freezeLines[0]).toBe(
      `[campaign] fixture-campaign-77: 4 committed path(s) verified — campaign.json, ${rec("stage-full.precommit.md")}, ${rec("stage-full.anchors.json")}, ${rec("stage-full.baseline.json")}`,
    );

    const anchorLines: string[] = [];
    await runCampaignAnchors({
      manifestPath,
      stage: "stage-ok",
      reportPath,
      log: (l) => anchorLines.push(l),
    });
    expect(anchorLines[0]).toBe(
      `[campaign] fixture-campaign-77: 3 committed path(s) verified — campaign.json, ${rec("stage-ok.precommit.md")}, ${rec("stage-ok.anchors.json")}`,
    );

    const compareLines: string[] = [];
    await runCampaignCompare({
      manifestPath,
      stage: "stage-cmp",
      reportPath,
      log: (l) => compareLines.push(l),
    });
    expect(compareLines[0]).toBe(
      `[campaign] fixture-campaign-77: 3 committed path(s) verified — campaign.json, ${rec("stage-cmp.precommit.md")}, ${rec("stage-cmp.baseline.json")}`,
    );
  });

  test("freeze checks the stage's ANCHOR CONFIG, not just its pre-commitment", async () => {
    // `--expect-mutants` reads this file and treats ITS count as the pre-commitment. Unchecked, the
    // cross-check compares a number typed on the command line against a file that could have been
    // written after the run — which is the thing the cross-check exists to prevent.
    const err = await refusalFrom(
      runCampaignFreeze({
        manifestPath,
        stage: "stage-dirtyanchors",
        reportPath,
        expectedMutantCount: 2,
      }),
    );
    expect(err).toBeInstanceOf(UncommittedPathError);
    expect((err as UncommittedPathError).paths).toEqual([rec("stage-dirtyanchors.anchors.json")]);
  });

  test("freeze checks the stage's existing BASELINE too", async () => {
    const err = await refusalFrom(
      runCampaignFreeze({
        manifestPath,
        stage: "stage-dirtybaseline",
        reportPath,
        expectedMutantCount: 2,
      }),
    );
    expect(err).toBeInstanceOf(UncommittedPathError);
    expect((err as UncommittedPathError).paths).toEqual([rec("stage-dirtybaseline.baseline.json")]);
  });

  test("anchors checks the ANCHOR CONFIG it is about to read", async () => {
    // The sharpest of the four: this file IS the pre-commitment the verb gates against
    // (expectedMutantCount, coveredProcedureRanges). The dirty copy on disk says 999 — a verb that
    // did not check it would happily gate against an edit made after the run.
    const err = await refusalFrom(
      runCampaignAnchors({ manifestPath, stage: "stage-dirtyanchors", reportPath }),
    );
    expect(err).toBeInstanceOf(UncommittedPathError);
    expect((err as UncommittedPathError).paths).toEqual([rec("stage-dirtyanchors.anchors.json")]);
  });

  test("compare checks the BASELINE it is about to compare against", async () => {
    const err = await refusalFrom(
      runCampaignCompare({ manifestPath, stage: "stage-dirtybaseline", reportPath }),
    );
    expect(err).toBeInstanceOf(UncommittedPathError);
    expect((err as UncommittedPathError).paths).toEqual([rec("stage-dirtybaseline.baseline.json")]);
  });

  // ---- shared argument validation ------------------------------------------------------------

  test("a stage name holding a path separator is refused", async () => {
    // `/invalid --stage/`, not `/stage/i`: the refusal echoes the rejected VALUE, so a bare
    // /stage/ would match "../stage-ok" itself and pass without the flag ever being named.
    for (const stage of ["../stage-ok", "sub/stage-ok", "..", "stage ok"]) {
      await expect(runCampaignAnchors({ manifestPath, stage, reportPath })).rejects.toThrow(
        /invalid --stage/,
      );
    }
  });

  test("an unreadable manifest is refused by name", async () => {
    await expect(
      runCampaignAnchors({
        manifestPath: join(repo, "no-such.json"),
        stage: "stage-ok",
        reportPath,
      }),
    ).rejects.toThrow(/no-such\.json/);
  });
});

/**
 * The MANIFEST is checked alongside the stage's own records — its own repository, because a dirty
 * manifest would refuse every test in the block above.
 *
 * Fix round 1, Important 1: dropping `c.manifestRel` from `committedPaths` passed the whole runner
 * suite. It is the module's own headline design decision (a manifest edited after the run can
 * redirect `recordsDir` at a different, or freshly minted, set of records), and it fires in
 * production — the first refusal the real campaign produced was its untracked `campaign.json`.
 */
describe("lethal campaign — the manifest itself must be committed", () => {
  let repo: string;
  let manifestPath: string;
  let reportPath: string;

  beforeAll(async () => {
    repo = await makeRepo({
      "campaign.json": MANIFEST,
      [rec("stage-ok.precommit.md")]: "# stage-ok\n",
      [rec("stage-ok.anchors.json")]: JSON.stringify(PASSING_ANCHORS, null, 2),
      [rec("stage-ok.baseline.json")]: JSON.stringify(normalizeForComparison(TWO_MUTANTS), null, 2),
      "report.json": JSON.stringify(TWO_MUTANTS),
    });
    manifestPath = join(repo, "campaign.json");
    reportPath = join(repo, "report.json");
    // Every RECORD stays committed and clean. Only the manifest is edited after the commit, so it
    // is the sole thing any of the three verbs can refuse on.
    await writeAt(
      repo,
      "campaign.json",
      JSON.stringify({ recordsDir: RECORDS_DIR, campaignId: "redirected-after-the-run" }, null, 2),
    );
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  test("freeze refuses a dirty manifest even when every record is clean", async () => {
    const err = await refusalFrom(
      runCampaignFreeze({ manifestPath, stage: "stage-ok", reportPath, expectedMutantCount: 2 }),
    );
    expect(err).toBeInstanceOf(UncommittedPathError);
    expect((err as UncommittedPathError).paths).toEqual(["campaign.json"]);
  });

  test("anchors refuses a dirty manifest even when every record is clean", async () => {
    const err = await refusalFrom(
      runCampaignAnchors({ manifestPath, stage: "stage-ok", reportPath }),
    );
    expect(err).toBeInstanceOf(UncommittedPathError);
    expect((err as UncommittedPathError).paths).toEqual(["campaign.json"]);
  });

  test("compare refuses a dirty manifest even when every record is clean", async () => {
    const err = await refusalFrom(
      runCampaignCompare({ manifestPath, stage: "stage-ok", reportPath }),
    );
    expect(err).toBeInstanceOf(UncommittedPathError);
    expect((err as UncommittedPathError).paths).toEqual(["campaign.json"]);
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
 *
 * Final review, Important 1: this block also covers `campaignFromCli`'s DISPATCH, which nothing
 * did. `runCampaign*` are exhaustively tested and `parseCliConfig` is exhaustively tested, and
 * nothing connected them — so making `freeze` dispatch to `runCampaignCompare` AND `anchors` drop
 * `projectDir` passed the entire runner suite. A `lethal campaign freeze` that silently ran a
 * compare would write no baseline, freeze nothing, print "identical" and exit 0: the signature bug
 * at the adapter layer, inside the subsystem built to prevent it. Spawning is what makes it real —
 * argv through `parseCliConfig` through `campaignFromCli` into the verb that actually runs.
 */
describe("lethal campaign (exit code + dispatch, spawned)", () => {
  const CLI = join(import.meta.dir, "..", "src", "cli.ts");
  let repo: string;
  let manifestPath: string;
  let recordsDir: string;
  let projectDir: string;
  let passingReport: string;
  let threeMutantReport: string;
  let changedReport: string;
  let reconReport: string;

  beforeAll(async () => {
    repo = await makeRepo({
      "campaign.json": MANIFEST,
      [rec("stage-ok.precommit.md")]: "# stage-ok\n",
      [rec("stage-ok.anchors.json")]: JSON.stringify(PASSING_ANCHORS, null, 2),
      [rec("stage-fail.precommit.md")]: "# stage-fail\n",
      [rec("stage-fail.anchors.json")]: JSON.stringify(FAILING_ANCHORS, null, 2),
      // freeze's own stage: precommit only, so nothing but the manifest and it are checked and the
      // baseline this verb MINTS is unambiguously its own output.
      [rec("stage-spawnfreeze.precommit.md")]: "# stage-spawnfreeze\n",
      // A SECOND freeze stage, untouched by the one above: once `stage-spawnfreeze` has been frozen
      // its (still uncommitted) baseline is itself a refusal, so a later freeze on that stage never
      // reaches the cardinality assertion this test is about.
      [rec("stage-spawncount.precommit.md")]: "# stage-spawncount\n",
      // The reconciliation stage — the only config in this file that turns it on, so `--project`
      // is REQUIRED and a dropped `projectDir` surfaces as "Refusing to skip a requested gate item".
      [rec("stage-recon.precommit.md")]: "# stage-recon\n",
      [rec("stage-recon.anchors.json")]: JSON.stringify(RECONCILING_ANCHORS, null, 2),
      // A page cannot carry the injected selector var, so the oracle agrees with the report's own
      // claim and the reconciliation PASSES — an assertable outcome, unlike the vacuous zero-file case.
      "project/Probe.Page.al": 'page 79324 "Data Scope Probe"\n{\n}\n',
    });
    manifestPath = join(repo, "campaign.json");
    recordsDir = join(repo, RECORDS_DIR);
    projectDir = join(repo, "project");
    passingReport = join(repo, "report.json");
    threeMutantReport = join(repo, "report-3.json");
    changedReport = join(repo, "report-changed.json");
    reconReport = join(repo, "report-recon.json");
    await writeFile(passingReport, JSON.stringify(TWO_MUTANTS), "utf8");
    await writeFile(threeMutantReport, JSON.stringify(THREE_MUTANTS), "utf8");
    await writeFile(changedReport, JSON.stringify(TWO_MUTANTS_CHANGED), "utf8");
    await writeFile(reconReport, JSON.stringify(RECON_REPORT), "utf8");
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  async function run(
    verb: string,
    stage: string,
    reportFile: string,
    extra: readonly string[] = [],
  ): Promise<{ code: number; out: string }> {
    const proc = Bun.spawn(
      [
        "bun",
        CLI,
        "campaign",
        verb,
        "--manifest",
        manifestPath,
        "--stage",
        stage,
        "--report",
        reportFile,
        ...extra,
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
    const { code, out } = await run("anchors", "stage-ok", passingReport);
    expect(out).toContain("PASS baseline-green");
    expect(code).toBe(0);
  });

  test("exits NON-ZERO when one anchor fails", async () => {
    const { code, out } = await run("anchors", "stage-fail", passingReport);
    expect(out).toContain("FAIL coverage-location");
    expect(code).not.toBe(0);
  });

  test("`freeze` runs FREEZE — it archives the report and mints the baseline", async () => {
    // Dispatch to any other verb produces neither file. `compare` in particular would print
    // "[compare] … identical" and exit 0, which reads like success.
    const { code, out } = await run("freeze", "stage-spawnfreeze", passingReport, [
      "--expect-mutants",
      "2",
    ]);
    expect(out).toContain("[freeze] stage-spawnfreeze: 2 mutants archived and frozen");
    expect(code).toBe(0);
    const written = (await readdir(recordsDir))
      .filter((f) => f.startsWith("stage-spawnfreeze."))
      .sort();
    expect(written).toEqual([
      "stage-spawnfreeze.baseline.json",
      "stage-spawnfreeze.precommit.md",
      "stage-spawnfreeze.report.json",
    ]);
  });

  test("`freeze` threads --expect-mutants through to the cardinality assertion", async () => {
    // A count that never reached `assertCardinality` — defaulted, or dropped by the adapter — would
    // let a report of the wrong size freeze itself.
    const { code, out } = await run("freeze", "stage-spawncount", threeMutantReport, [
      "--expect-mutants",
      "2",
    ]);
    expect(out).toContain("expected 2, got 3");
    expect(code).not.toBe(0);
    // ... and nothing was written: cardinality precedes every records-directory touch.
    expect((await readdir(recordsDir)).filter((f) => f.startsWith("stage-spawncount."))).toEqual([
      "stage-spawncount.precommit.md",
    ]);
  });

  test("`compare` runs COMPARE against the baseline `freeze` just committed", async () => {
    // Depends on the freeze test above having produced the files — then commits them, which is the
    // real operator flow ("Review and commit this file") and the only way `compare` will accept
    // them. It also proves freeze's output is directly consumable by compare.
    await git(repo, ["add", "--", `${RECORDS_DIR}/stage-spawnfreeze.baseline.json`]);
    await git(repo, ["commit", "-qm", "freeze stage-spawnfreeze"]);

    const same = await run("compare", "stage-spawnfreeze", passingReport);
    expect(same.out).toContain("identical — all 2 mutant(s) match the committed baseline");
    expect(same.code).toBe(0);

    const differing = await run("compare", "stage-spawnfreeze", changedReport);
    expect(differing.out).toContain("RESULT: DIFFERENT");
    expect(differing.out).toContain("hash-M0002");
    expect(differing.code).toBe(1);
  });

  test("a re-freeze on a stage whose baseline is ALREADY committed still FREEZES", async () => {
    // The exit-0 shape of the dispatch swap, which the fresh-stage freeze test does NOT cover: there,
    // `compare` is refused by its own missing-baseline gate, so the swap surfaces as a refusal. Here
    // the baseline exists and is committed (the test above committed it), `<stage>.report.json`
    // already exists from the first freeze, and so a swapped verb prints
    // "[compare] … identical — all 2 mutant(s) match", exits 0, freezes nothing, and leaves a
    // directory listing byte-identical to the one a real freeze produces. Only the `[freeze]` line
    // separates the two.
    //
    // The narrow mutation that survives everything else — `if (baseline exists && no anchors.json)
    // return runCampaignCompare(args)` — is the PRODUCTION shape, not a contrived one: stages 2 and 3
    // of the 2026-08-03 campaign carry no anchors.json, so freeze and compare announce the identical
    // path list and the announced-list test's kill evaporates.
    const { code, out } = await run("freeze", "stage-spawnfreeze", passingReport, [
      "--expect-mutants",
      "2",
    ]);
    expect(out).toContain("[freeze] stage-spawnfreeze: 2 mutants archived and frozen");
    expect(code).toBe(0);
  });

  test("`anchors --project` threads projectDir into the reconciliation", async () => {
    // `reconcileNotInstrumented: true` makes --project REQUIRED. A dropped `projectDir` throws
    // "Refusing to skip a requested gate item" — so this fails loudly rather than silently
    // skipping, but only if something actually runs the verb with the flag.
    const { code, out } = await run("anchors", "stage-recon", reconReport, [
      "--project",
      projectDir,
    ]);
    expect(out).toContain("PASS notinstrumented-reconciliation");
    // `{"page":1}` is the oracle's classification of the SOURCE it read at `--project` — it cannot
    // be produced without the flag having reached `runAnchorCheck` and the file having been read.
    expect(out).toContain('confirmed uninstrumentable by object header ({"page":1})');
    expect(code).toBe(0);
  });

  test("exits NON-ZERO on a cardinality mismatch", async () => {
    const { code, out } = await run("anchors", "stage-ok", threeMutantReport);
    // Asserted on the OUTPUT as well as the code: a CLI that failed to parse its own arguments
    // also exits non-zero, and this test passed for exactly that reason while `--manifest` was
    // still an unknown option.
    expect(out).toContain("expected 2, got 3");
    expect(code).not.toBe(0);
  });
});
