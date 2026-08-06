/**
 * `lethal campaign freeze | anchors | compare` — the gate machinery that already existed, with the
 * two things it was missing: a records directory that comes from a manifest instead of a constant,
 * and a git check that makes "committed before the run" mechanical rather than trusted.
 *
 * **This module is where `assertCommitted` becomes real.** `campaign-git.ts` is pure by design and
 * says so in its own header: it TRUSTS `deps.status(path)` completely and has no way to verify that
 * the answer it gets is even about the path it asked about. That is the right scope for a pure
 * function, and it means the whole fail-closed guarantee lives here, in the wiring. Four measured
 * facts about real git (2.55.0.windows.3) shape every line of it — each one makes git answer
 * "nothing to report", which `assertCommitted` correctly reads as CLEAN:
 *
 *  1. `git status --porcelain -- docs/missing.md`, for a path that does not exist: exit 0, empty
 *     output. A pre-commitment that was never written would therefore PASS. Closed by checking the
 *     path exists on disk, and by requiring git to say it is TRACKED (below), before asking about
 *     its cleanliness.
 *  2. The same for a GITIGNORED, never-committed file — it exists, it is not committed, and
 *     `status` says nothing about it at all.
 *  3. The same for a whitespace-only pathspec (`"   "`): exit 0, empty output, no error. (The empty
 *     STRING is a `fatal:`, so it fails closed on its own; the whitespace one does not, which is
 *     the dangerous half. `campaign-git.ts` refuses an empty ARRAY but passes a blank PATH straight
 *     through to `deps.status`.) Closed by refusing a blank path before git is invoked at all.
 *  4. A pathspec is a GLOB by default: `git ls-files -- 'docs/[ab]tricky.md'` returns BOTH that
 *     file and `docs/atricky.md`. Closed by `--literal-pathspecs` on every invocation, and pinned
 *     by the echo check below rather than by trusting the flag.
 *
 * **How git is invoked, and why it is invoked that way.**
 *  - An ARGV ARRAY through `Bun.spawn`, never a shell string: a path holding a space, a quote or a
 *    glob character reaches git as exactly one argument and cannot be re-split into two pathspecs
 *    (which git would then answer about separately, and — both being nonexistent — silently).
 *  - `-z`, so paths come back NUL-terminated and NEVER quoted. With default `core.quotePath`, plain
 *    `--porcelain` renders `docs/café.md` as `"docs/caf\303\251.md"` — a different string from the
 *    one the caller passed, which no operator can grep for and no comparison can match.
 *  - `--literal-pathspecs`, so the path is a path and not a pattern (fact 4).
 *  - `--no-optional-locks`, because a gate must not write to the repository it is inspecting.
 *  - A NON-ZERO exit is a refusal, never a pass — a path outside the repository is `fatal:` with
 *    exit 128, and "the check could not run" must never be reported as "the check passed".
 *  - `git ls-files -z -- <path>` ECHOES BACK the paths its pathspec resolved to, and this module
 *    requires that echo to be exactly one path equal to the one it asked about. That is the
 *    independent verification `assertCommitted` structurally cannot do: an answer about some other
 *    file, or about several files, can no longer be read as an answer about this one. It is the
 *    same identity-echo discipline `RunMutant` already uses for mutant activation.
 *
 * **What this CANNOT detect, stated so the guarantee is not read as absolute.** This gate asks git
 * whether a file differs from HEAD; it cannot ask whether the CONTENT was honest when it was
 * committed. Two consequences, both measured:
 *  - `git update-index --assume-unchanged` / `--skip-worktree` makes git report a genuinely edited
 *    file as clean, so the echo passes and this gate passes. Deliberately NOT closed: it is
 *    strictly weaker than simply committing the edited pre-commitment, which no git check can
 *    detect at all, and the failure this whole subsystem is aimed at is CARELESSNESS (writing the
 *    file after the run, or forgetting to commit it) rather than evasion.
 *  - Committing an edit after the run passes for the same reason. What makes that visible is the
 *    git HISTORY — the pre-commitment's commit must predate the run — which is a review question,
 *    not a `git status` question.
 * The honest claim is therefore narrow: nothing UNCOMMITTED, untracked, ignored, staged-only,
 * modified or missing can reach these gates unnoticed.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { NormalizedMutant } from "../itest/mutant-equality";
import { diffMutants, normalizeForComparison } from "../itest/mutant-equality";
import { assertCardinality } from "./campaign-anchors";
import { parseAnchorConfig, runAnchorCheck } from "./campaign-anchors-run";
import { freezeStageTo } from "./campaign-freeze";
import { UncommittedPathError, assertCommitted } from "./campaign-git";
import { findRepoRoot, readCampaignManifest, resolveRecordsDirIn } from "./campaign-manifest";
import type { SessionReport } from "./report";

/** One `git` invocation's raw result. */
export interface GitCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `git` with the given argv (no shell) and resolves its exit code and streams. */
export type GitRunner = (args: readonly string[]) => Promise<GitCommandResult>;

/**
 * Thrown when git could not be made to answer the question this gate asked — a non-zero exit, or
 * an answer that is provably about something other than the path requested. Distinct from
 * `UncommittedPathError` (a named path really is dirty) and from `CampaignGitContractError` (the
 * caller called this wrong): this one means the CHECK DID NOT RUN, which is the outcome a gate
 * must never round down to "passed".
 *
 * Extends `Error` directly, per CLAUDE.md's typed-error separation rule.
 */
export class CampaignGitInvocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CampaignGitInvocationError";
  }
}

/** Global git options every invocation here carries — see this module's header for each one. */
const GIT_READONLY_LITERAL = ["--no-optional-locks", "--literal-pathspecs"] as const;

/** The real runner: an argv array, no shell, rooted at `repoRoot`. */
export function createRepoGitRunner(repoRoot: string): GitRunner {
  return async (args) => {
    const proc = Bun.spawn(["git", ...args], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, stdout, stderr };
  };
}

/** `-z` output is NUL-TERMINATED, not NUL-separated, so the final split element is always empty. */
function nulRecords(stdout: string): string[] {
  return stdout.split("\0").filter((s) => s.length > 0);
}

function describeFailedGit(what: string, path: string, r: GitCommandResult): string {
  return (
    `campaign: \`git ${what}\` for "${path}" exited ${r.code} — the committed-before-the-run check ` +
    `could not be evaluated, which is a refusal, not a pass. git said: ${r.stderr.trim() || "(nothing)"}`
  );
}

/**
 * The paths `git ls-files` resolves the pathspec to — exactly one, equal to `path`, or this
 * throws. See the header: this echo is the only independent evidence that git's answer is about
 * the path that was asked about. Zero paths means git does not track it at all (never committed,
 * or committed only inside `.gitignore`'s blind spot), which is reported by the caller as
 * "not committed" rather than as an invocation failure.
 */
async function trackedEcho(git: GitRunner, path: string): Promise<readonly string[]> {
  const r = await git([...GIT_READONLY_LITERAL, "ls-files", "-z", "--", path]);
  if (r.code !== 0) throw new CampaignGitInvocationError(describeFailedGit("ls-files", path, r));
  const echoed = nulRecords(r.stdout);
  if (echoed.length === 0) return echoed;
  if (echoed.length !== 1 || echoed[0] !== path) {
    throw new CampaignGitInvocationError(
      `campaign: asked git about "${path}" and it answered about ${JSON.stringify(echoed)}. A cleanliness answer that is not provably about the path requested cannot be used as one — refusing. (A pathspec expanded as a glob, or a directory rather than a file, both look like this.)`,
    );
  }
  return echoed;
}

/**
 * `git status --porcelain -z` for exactly one path, rendered as the single string
 * `assertCommitted`'s `deps.status` contract expects: `""` when clean, and otherwise the porcelain
 * records joined with `"; "` — the `-z` NUL separators turned into something a human reads, with
 * each record's two status characters (`??`, ` M`, `R `, ...) left exactly as git wrote them so
 * `campaign-git.ts`'s own wording logic still sees them.
 */
async function porcelainStatus(git: GitRunner, path: string): Promise<string> {
  const r = await git([...GIT_READONLY_LITERAL, "status", "--porcelain", "-z", "--", path]);
  if (r.code !== 0) throw new CampaignGitInvocationError(describeFailedGit("status", path, r));
  return nulRecords(r.stdout).join("; ");
}

export interface CampaignCommittedDeps {
  readonly git: GitRunner;
  /** Absolute path to the repository root the paths are relative to, and git's working directory. */
  readonly repoRoot: string;
}

/** Refuses a path shape git would answer about silently or wrongly — see facts 3 and 4 in the
 *  header. Anything that is not a plain, non-blank, repository-relative path is refused. */
function assertUsablePathspec(path: string, repoRoot: string): void {
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new CampaignGitInvocationError(
      `campaign: refusing to check a blank or whitespace-only path (${JSON.stringify(path)}). Measured: \`git status --porcelain -- '   '\` exits 0 and reports NOTHING, which this gate would otherwise read as 'clean' for a path it never actually checked.`,
    );
  }
  if (path.includes("\0")) {
    throw new CampaignGitInvocationError(
      `campaign: refusing a path containing a NUL byte (${JSON.stringify(path)}).`,
    );
  }
  if (isAbsolute(path) || /^[A-Za-z]:/.test(path)) {
    throw new CampaignGitInvocationError(
      `campaign: "${path}" is absolute; this gate speaks repository-relative paths only, so that the path it checks and the path git echoes back are directly comparable.`,
    );
  }
  const rel = relative(repoRoot, resolve(repoRoot, path));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new CampaignGitInvocationError(
      `campaign: "${path}" resolves outside the repository root "${repoRoot}". git answers \`fatal:\` for such a pathspec, and a gate that cannot ask its question has not passed it.`,
    );
  }
}

/**
 * The composed check: every path in `paths` exists on disk, is TRACKED by git (echo-verified), and
 * is clean. Resolves only when all three hold for all of them.
 *
 * Three separate refusals rather than one, each naming EVERY offending path rather than the first:
 * `CampaignGitInvocationError` for a path git cannot be asked about, `UncommittedPathError` for
 * paths that do not exist or are not tracked, and then `assertCommitted`'s own
 * `UncommittedPathError` for paths that are tracked but dirty. The middle one is a deliberate
 * pre-check rather than a synthesised status string: `assertCommitted`'s contract is that
 * `deps.status` returns what GIT said, and fabricating a plausible porcelain line for a file git
 * never mentioned would be this project's signature bug wearing the right costume.
 */
export async function assertCampaignPathsCommitted(
  paths: readonly string[],
  deps: CampaignCommittedDeps,
): Promise<void> {
  if (paths.length === 0) {
    throw new CampaignGitInvocationError(
      "campaign: refusing an empty paths array — a gate asked to verify nothing must not be able " +
        "to report success.",
    );
  }
  for (const p of paths) assertUsablePathspec(p, deps.repoRoot);

  const missing = paths.filter((p) => !existsSync(join(deps.repoRoot, p)));
  if (missing.length > 0) {
    throw new UncommittedPathError(
      `campaign: refusing — ${missing.length} pre-commitment path(s) DO NOT EXIST:\n${missing.map((p) => `  - "${p}"`).join("\n")}\n\nA pre-commitment that does not exist cannot have been committed before the run. Note that git does not object to this on its own: \`git status --porcelain -- <missing path>\` exits 0 and prints nothing, which reads exactly like 'clean'.`,
      missing,
    );
  }

  const untracked: string[] = [];
  for (const p of paths) {
    if ((await trackedEcho(deps.git, p)).length === 0) untracked.push(p);
  }
  if (untracked.length > 0) {
    throw new UncommittedPathError(
      `campaign: refusing — ${untracked.length} path(s) are not known to git at all (untracked, or ignored):\n${untracked.map((p) => `  - "${p}"`).join("\n")}\n\nA file that was never added is not a pre-commitment, and \`git status --porcelain\` says NOTHING about an ignored one — which is why this is checked with \`git ls-files\` instead of inferred from a clean status.`,
      untracked,
    );
  }

  await assertCommitted(paths, { status: (p) => porcelainStatus(deps.git, p) });
}

// ---------------------------------------------------------------------------------------------
// The subcommands
// ---------------------------------------------------------------------------------------------

/** What every `lethal campaign` subcommand takes. */
export interface CampaignArgsBase {
  /** Path to the campaign manifest (`{ recordsDir, campaignId }`), as given on the command line. */
  readonly manifestPath: string;
  /** The campaign stage this invocation is about. It NAMES the committed files
   *  (`<stage>.precommit.md`, `<stage>.anchors.json`, `<stage>.baseline.json`), so it is validated
   *  as a single filename component and never a path. The name is the campaign author's to choose —
   *  the 2026-08-03 campaign's stages are `rung1`, `rung2`, `rung3`, and those files are unchanged
   *  by this flag's rename. */
  readonly stage: string;
  /** The report a run produced with `--out`. Not itself a committed record. */
  readonly reportPath: string;
  /** Phase notifications, in order. `"assert-committed"` is always first. */
  readonly onStep?: (step: string) => void;
  /** Where the human-readable lines go. Defaults to `console.log`. */
  readonly log?: (line: string) => void;
  /** Injected git runner; defaults to the real one, rooted at the manifest's repository. */
  readonly git?: GitRunner;
}

export interface CampaignFreezeArgs extends CampaignArgsBase {
  /** The mutant count pre-committed BEFORE the run. Never derived from the report — a count taken
   *  from the report being checked makes the cardinality assertion compare a report against itself
   *  and pass on every report ever produced, including an empty one. */
  readonly expectedMutantCount: number;
}

export interface CampaignAnchorsArgs extends CampaignArgsBase {
  /** Only used when the committed anchor config sets `reconcileNotInstrumented`. */
  readonly projectDir?: string;
}

/** A stage names files; it is not a path. `../stage1` or `sub/stage1` would place (or read) a
 *  campaign's records outside the directory the manifest designated, which is the whole thing
 *  `resolveRecordsDir`'s containment checks exist to prevent — reintroducing it one layer up. */
const STAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface ResolvedCampaign {
  readonly recordsDir: string;
  readonly repoRoot: string;
  readonly campaignId: string;
  readonly manifestRel: string;
  readonly git: GitRunner;
  readonly log: (line: string) => void;
  readonly step: (name: string) => void;
  /** `<recordsDir>/<stage>.<suffix>`, absolute. */
  readonly file: (suffix: string) => string;
  /** The same file as a repository-relative, forward-slash path — what git is asked about. */
  readonly rel: (abs: string) => string;
}

function toRepoRelative(repoRoot: string, abs: string): string {
  const rel = relative(repoRoot, abs);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new CampaignGitInvocationError(
      `campaign: "${abs}" is not inside the repository root "${repoRoot}", so it cannot be checked for being committed. Refusing rather than checking nothing.`,
    );
  }
  // git speaks forward slashes on every platform, including Windows, and the echo check compares
  // the path it sent against the path git sent back — so they must be spelled the same way.
  return rel.split(sep).join("/");
}

/**
 * Reads the manifest, locates the repository IT lives in, and resolves the records directory
 * against that root.
 *
 * The repository root comes from the MANIFEST's own directory, not from `import.meta.dir`: a
 * `bun build --compile` binary has no repository at `import.meta.dir` at all (it resolves against
 * Bun's virtual root — R50 measured that class of failure), and a checkout can legitimately drive
 * a campaign whose records live in a different repository. The manifest is a real file in the
 * campaign's own repository, so walking up from it is the resolution that works in both.
 */
function resolveCampaign(args: CampaignArgsBase): ResolvedCampaign {
  const { stage } = args;
  if (typeof stage !== "string" || !STAGE_RE.test(stage)) {
    throw new Error(
      `campaign: invalid --stage ${JSON.stringify(stage)}. A stage names the committed files (<stage>.precommit.md, <stage>.anchors.json, <stage>.baseline.json) inside the records directory, so it must be a single plain name matching ${STAGE_RE.source} — not a path.`,
    );
  }
  const manifestAbs = resolve(args.manifestPath);
  const manifest = readCampaignManifest(manifestAbs);
  const repoRoot = findRepoRoot(manifestAbs);
  const recordsDir = resolveRecordsDirIn(repoRoot, manifest);
  const log = args.log ?? ((line: string) => console.log(line));
  return {
    recordsDir,
    repoRoot,
    campaignId: manifest.campaignId,
    manifestRel: toRepoRelative(repoRoot, manifestAbs),
    git: args.git ?? createRepoGitRunner(repoRoot),
    log,
    step: (name) => args.onStep?.(name),
    file: (suffix) => join(recordsDir, `${stage}.${suffix}`),
    rel: (abs) => toRepoRelative(repoRoot, abs),
  };
}

/** The manifest is checked alongside the stage's own records: a manifest edited after the run can
 *  redirect `recordsDir` at a different (or freshly minted) set of records, which is the same
 *  failure as editing the pre-commitment, one level up. */
function committedPaths(c: ResolvedCampaign, records: readonly string[]): string[] {
  return [c.manifestRel, ...records.map((abs) => c.rel(abs))];
}

function announceChecked(c: ResolvedCampaign, paths: readonly string[]): void {
  c.log(
    `[campaign] ${c.campaignId}: ${paths.length} committed path(s) verified — ${paths.join(", ")}`,
  );
}

/**
 * `lethal campaign freeze` — archive a stage's report and freeze its per-mutant verdicts, refusing
 * unless the manifest and the stage's committed records are clean in git FIRST.
 *
 * The ordering is not cosmetic. `assertMatchesBaseline` (baseline-guard.ts) RECORDS a baseline when
 * none exists, so a freeze that ran before the git check and refused after it would have minted
 * `<stage>.baseline.json` from the very run it then rejected — and every later stage would compare
 * against that.
 */
export async function runCampaignFreeze(args: CampaignFreezeArgs): Promise<number> {
  const c = resolveCampaign(args);
  const precommit = c.file("precommit.md");
  const anchors = c.file("anchors.json");
  const baseline = c.file("baseline.json");

  // The anchor config and the baseline are conditional because not every stage has them (stages
  // `rung2` and `rung3` of the 2026-08-03 campaign carry no anchors.json, and the first freeze of a
  // stage is where its baseline is minted). Both are named in the printed list when they ARE
  // checked, so a check that did not run is visible rather than implied.
  const records = [precommit, ...[anchors, baseline].filter((p) => existsSync(p))];
  const paths = committedPaths(c, records);
  c.step("assert-committed");
  await assertCampaignPathsCommitted(paths, { git: c.git, repoRoot: c.repoRoot });
  announceChecked(c, paths);

  // A count typed on the command line AFTER a run is not a pre-commitment. When the stage has a
  // committed anchor config, that file's `expectedMutantCount` is the pre-commitment, and the two
  // must agree — a disagreement means one of them was written after seeing the results.
  c.step("cross-check-expected");
  if (existsSync(anchors)) {
    const cfg = parseAnchorConfig(JSON.parse(await readFile(anchors, "utf8")), anchors);
    if (cfg.expectedMutantCount !== args.expectedMutantCount) {
      throw new Error(
        `campaign freeze: --expect-mutants ${args.expectedMutantCount} contradicts the pre-committed expectedMutantCount ${cfg.expectedMutantCount} in ${anchors}. The committed file is the pre-commitment; a number supplied on the command line after the run is not. Refusing rather than freezing against whichever one was typed last.`,
      );
    }
  }

  c.step("freeze");
  await freezeStageTo(args.reportPath, args.stage, args.expectedMutantCount, c.recordsDir);
  return 0;
}

/**
 * `lethal campaign anchors` — run the stage's pre-committed anchor gate over a report. Returns 0
 * when every checked anchor passed, 1 when one failed; throws when the gate could not be evaluated
 * at all (uncommitted records, unreadable report, invalid config, cardinality mismatch).
 */
export async function runCampaignAnchors(args: CampaignAnchorsArgs): Promise<number> {
  const c = resolveCampaign(args);
  const precommit = c.file("precommit.md");
  const anchors = c.file("anchors.json");
  const paths = committedPaths(c, [precommit, anchors]);
  c.step("assert-committed");
  await assertCampaignPathsCommitted(paths, { git: c.git, repoRoot: c.repoRoot });
  announceChecked(c, paths);

  const outcome = await runAnchorCheck({
    reportPath: args.reportPath,
    configPath: anchors,
    ...(args.projectDir !== undefined ? { projectDir: args.projectDir } : {}),
    ...(args.onStep !== undefined ? { onStep: args.onStep } : {}),
  });
  for (const line of outcome.lines) c.log(line);
  return outcome.ok ? 0 : 1;
}

/**
 * `lethal campaign compare` — diff a report against the stage's COMMITTED per-mutant baseline,
 * writing nothing.
 *
 * The difference from `freeze` is the whole reason this is its own verb: `assertMatchesBaseline`
 * mints a baseline when the file is absent, which is right for the run that establishes a stage and
 * catastrophic for a comparison — it would report "matches" against a file it had just written out
 * of the report it was comparing. So a missing baseline is a REFUSAL here, and nothing on disk is
 * created or modified on any path through this function.
 */
export async function runCampaignCompare(args: CampaignArgsBase): Promise<number> {
  const c = resolveCampaign(args);
  const precommit = c.file("precommit.md");
  const baselinePath = c.file("baseline.json");
  const paths = committedPaths(c, [precommit, baselinePath]);
  c.step("assert-committed");
  // A baseline that does not exist is refused by the existence check inside this call, naming the
  // file — see `assertCampaignPathsCommitted`.
  await assertCampaignPathsCommitted(paths, { git: c.git, repoRoot: c.repoRoot });
  announceChecked(c, paths);

  const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as NormalizedMutant[];
  if (!Array.isArray(baseline)) {
    throw new Error(
      `campaign compare: ${baselinePath} is not a per-mutant baseline array (baseline-guard.ts writes one record per mutant). Refusing to compare against a file of unknown shape.`,
    );
  }
  const report = JSON.parse(await readFile(args.reportPath, "utf8")) as SessionReport;

  // Cardinality first, exactly as in `freeze` and `anchors`, with the committed baseline's own
  // length as the pre-commitment: a truncated report would otherwise be reported as "these N
  // mutants all agree", which is true and beside the point.
  c.step("cardinality");
  assertCardinality(report, baseline.length, `${args.stage} compare`);

  c.step("compare");
  const diffs = diffMutants(baseline, normalizeForComparison(report));
  if (diffs.length === 0) {
    c.log(
      `[compare] ${args.stage}: identical — all ${baseline.length} mutant(s) match the committed baseline at ${baselinePath}`,
    );
    return 0;
  }
  c.log(
    `[compare] ${args.stage}: ${diffs.length} per-mutant difference(s) against the committed baseline at ${baselinePath}:`,
  );
  for (const d of diffs) c.log(`[compare]   - ${d}`);
  c.log(`[compare] RESULT: DIFFERENT (${diffs.length} mutant(s))`);
  return 1;
}
