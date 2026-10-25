/**
 * R586 §12 (plan `docs/superpowers/plans/2026-10-21-r586-alrunner-v3-backend.md`, r2 §12 with r3's
 * F6 and r4's I-3): the al-runner v3 update gate, the only al-runner update path since the .NET
 * al-runner (v2) and its update script were retired (R654). Daily, or by hand:
 *
 *   bun scripts/al-runner-v3-update.ts [--regate <lethal commit>]
 *   bun scripts/al-runner-v3-update.ts --edge        (the daily edge-by-download path, `edgeOnce`)
 *   bun scripts/al-runner-v3-update.ts --edge-rejudge <edge sha>   (R639: a KEPT edge binary,
 *                                                     re-gated at `.gated`'s commit, `edgeRejudge`)
 *
 * Every gate path holds `<root>/.gate.lock` (R639 I3); a run skipped by it exits 2 on `--regate`
 * and `--edge-rejudge`.
 *
 * 1. Candidates: `v3.0.0-alpha.N` releases of aldevtools/BusinessCentral.AL.Runner with N above the
 *    gated build's, tried NEWEST first (R586d): the first pass becomes `current` and ends the run;
 *    anything else falls back to the next older one. `edge` only through `--edge`, never as an
 *    alpha candidate.
 * 2. The linux-x64 tarball and SHA256SUMS go into a NEW empty folder; a checksum mismatch is
 *    `infra-fail` and the tarball is NEVER extracted. Extraction goes into another new folder.
 * 3. The gate runs in a detached worktree at `.gated`'s `lethalCommit` (never a moving master), with
 *    `LETHAL_ALRUNNER_V3_CANDIDATE=1`, the CDO corpus and leg T. Its receipt is deleted before the
 *    run and accepted only with this run's nonce AND the candidate's binary sha256. R777: when that
 *    commit predates a leg of this script's `V3_GATE_LEGS`, `current` is first re-gated at this
 *    script's own commit (logged `stale-gated`); if that does not pass, `current` stays and the
 *    candidate is judged at the script's commit. A script commit off origin/master is refused.
 * 4. Outcomes: `pass` -> installed, `.gated` written, `current` moved (unless a v3 process is
 *    running: "deferred: in use"); `gate-fail` -> `failed/` for good; `held` (every difference a
 *    move toward BC or a named refusal; read the receipt's lines) -> `held/`, never blacklisted, a
 *    line for the orchestrator to re-pre-commit;
 *    `infra-fail` -> nothing kept, retried next run, a line after 3 in a row.
 * `--regate <commit>`: gate the CURRENT build at a new LethAL commit; on pass `.gated` takes it.
 * The script never commits.
 * To-do (not v1; serve is out of v1): capture `serve`'s full summary for one edit in the CDO
 * 18-dependency workspace, the measurement #5614 lacks (R586's defect table, row 14).
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  cp,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type V3LegOutcome,
  V3_GATE_LEGS,
  gateOutcome,
} from "../packages/runner/itest/al-runner-v3-gate";
import { prepareFixtureSymbols } from "../packages/runner/itest/fixture-symbols";
import {
  type GatedBuild,
  parseGated,
  sha256OfFile,
  warnFactReadings,
} from "../packages/runner/src/al-runner-v3-pin";

export const ROOT = "/work/tools/al-runner-v3";
export const REPO = "aldevtools/BusinessCentral.AL.Runner";
export const GATE_WORKTREE = "/work/lethal-wt/al-runner-v3-gate";
export const LOG = "/coord/handoff/R-586/v3-updates.log";
/**
 * R632 A: the CDO checkout the D legs need (the gate page's `LETHAL_ITEST_V3_CDO`). Without it the
 * gate runs no D leg, and the receipt is an infra-fail every day (alpha.3, 2026-10-22).
 */
export const V3_CDO_DEFAULT = "/work/lethal-wt/cdo-r396";

export type Outcome = "pass" | "held" | "gate-fail" | "infra-fail";

/** Everything with a side effect, injected so the test drives every branch (T19). */
export interface UpdateDeps {
  readonly root: string;
  /** Release tags, newest first (`gh release list`). */
  listReleases(): Promise<readonly string[]>;
  /** Downloads the linux-x64 tarball and SHA256SUMS of `tag` into the empty `dir`. */
  download(tag: string, dir: string): Promise<{ readonly tarball: string; readonly sums: string }>;
  /** Extracts `tarball` into the empty `dir`; returns the binary's path. */
  extract(tarball: string, dir: string): Promise<string>;
  versionOf(binary: string): Promise<string>;
  /**
   * Checks out `commit` detached in the gate worktree and runs the gate with `env`. `log` takes a
   * preparation line (R614 I2: how the fixture `.alpackages` were prepared) into the update log.
   */
  runGate(
    commit: string,
    env: Readonly<Record<string, string>>,
    log: (line: string) => Promise<void>,
  ): Promise<void>;
  /** A running process whose executable resolves under `root`. */
  inUse(): Promise<boolean>;
  log(line: string): Promise<void>;
  now(): string;
  /** Heavy jobs running container-wide (bun itests, `cli.ts run`, corpus jobs, verify). */
  heavyJobs(): Promise<number>;
  /** `free -g`'s available column. */
  freeGb(): Promise<number>;
  /** R639 I3: `/proc/<pid>/cmdline` with NULs as spaces, or undefined when there is no such pid. */
  procCmdline(pid: number): Promise<string | undefined>;
  /** R639 I3: the pids (not this one) whose cwd is `dir` or under it: an orphaned itest child. */
  procsWithCwdUnder(dir: string): Promise<readonly number[]>;
  /** R777: the legs `V3_GATE_LEGS` names at LethAL `commit` (that commit's gate module). */
  legsAt(commit: string): Promise<readonly string[]>;
  /** R777: the full sha of the LethAL commit this script runs from. */
  selfCommit(): Promise<string>;
  /** R777: `git merge-base --is-ancestor a b` (a commit is its own ancestor). */
  isAncestor(a: string, b: string): Promise<boolean>;
}

/** R777: the leg names of the `V3_GATE_LEGS` literal in a gate module's source; throws when absent. */
export function parseGateLegs(src: string): string[] {
  const m = /export const V3_GATE_LEGS = \[([\s\S]*?)\] as const;/.exec(src);
  if (m === null)
    throw new Error("no `export const V3_GATE_LEGS = [...] as const;` in the gate module");
  const body = (m[1] ?? "").replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");
  return [...body.matchAll(/"([^"]+)"/g)].map((x) => x[1] ?? "");
}

/** `v3.0.0-alpha.N` -> N; anything else (edge, other lines) -> undefined. */
export function alphaOf(tag: string): number | undefined {
  const m = /^v3\.0\.0-alpha\.(\d+)$/.exec(tag);
  return m === null ? undefined : Number(m[1]);
}

/**
 * Candidates above the gated alpha, NEWEST first (R586d); never `edge`. Versions compare by the
 * alpha number as a number, so alpha.10 is newer than alpha.9.
 */
export function candidates(tags: readonly string[], gatedAlpha: number): string[] {
  return tags
    .map((t) => ({ t, n: alphaOf(t) }))
    .filter((x): x is { t: string; n: number } => x.n !== undefined && x.n > gatedAlpha)
    .sort((a, b) => b.n - a.n)
    .map((x) => x.t);
}

/** The sha256 SHA256SUMS states for `file` (by basename), or undefined. */
export function expectedSha(sums: string, file: string): string | undefined {
  const name = file.split("/").pop() ?? file;
  for (const line of sums.split("\n")) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (m !== null && m[2] === name) return m[1];
  }
  return undefined;
}

/**
 * Reads the receipt: valid only with this nonce, this binary's sha256 and the LethAL commit the gate
 * was asked to run at (M3); and its `legs` must give its `outcome` by `gateOutcome` over the exact
 * leg set (a `pass` needs EVERY leg passed). Anything else is infra-fail, never a pass.
 */
export async function readReceipt(
  path: string,
  nonce: string,
  sha: string,
  commit: string,
): Promise<{ outcome: Outcome; why: string }> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return { outcome: "infra-fail", why: "no receipt" };
  }
  const r = raw as {
    nonce?: unknown;
    binarySha256?: unknown;
    lethalCommit?: unknown;
    dirty?: unknown;
    outcome?: unknown;
    legs?: unknown;
  };
  if (r.nonce !== nonce) return { outcome: "infra-fail", why: "a receipt of another run (nonce)" };
  if (r.binarySha256 !== sha)
    return { outcome: "infra-fail", why: "a receipt for another binary (sha256)" };
  // F6: the full 40-character sha, equal; never a prefix match either way.
  const at = typeof r.lethalCommit === "string" ? r.lethalCommit : "";
  if (!FULL_SHA.test(at) || !FULL_SHA.test(commit) || at !== commit)
    return {
      outcome: "infra-fail",
      why: `a receipt of LethAL ${at || "(none)"}, not the requested ${commit} (both must be the full 40-character sha)`,
    };
  if (
    r.outcome !== "pass" &&
    r.outcome !== "held" &&
    r.outcome !== "gate-fail" &&
    r.outcome !== "infra-fail"
  ) {
    return { outcome: "infra-fail", why: `a receipt with outcome ${JSON.stringify(r.outcome)}` };
  }
  const legs = (typeof r.legs === "object" && r.legs !== null ? r.legs : {}) as Record<
    string,
    V3LegOutcome
  >;
  const byLegs = gateOutcome(legs);
  if (byLegs !== r.outcome)
    return {
      outcome: "infra-fail",
      why: `the receipt says ${r.outcome}, but its legs ${JSON.stringify(legs)} give ${byLegs} (every leg of ${V3_GATE_LEGS.join(",")} must be present)`,
    };
  // F5: a pass from a dirty gate worktree (an edited file, a rewritten lockfile) proves nothing.
  if (r.outcome === "pass" && r.dirty !== false)
    return {
      outcome: "infra-fail",
      why: `a pass from a gate worktree that was not clean (dirty: ${JSON.stringify(r.dirty)})`,
    };
  // R632 A: name the legs that never ran (D1 and D1c need LETHAL_ITEST_V3_CDO).
  const missing = V3_GATE_LEGS.filter((l) => !(l in legs));
  return {
    outcome: r.outcome,
    why: `receipt legs ${JSON.stringify(legs)}${missing.length > 0 ? `; missing legs ${missing.join(",")}` : ""}`,
  };
}

/** R632 C: the receipt's own `lines` (each leg's message), or none. */
async function receiptLines(path: string): Promise<string[]> {
  try {
    const l = (JSON.parse(await readFile(path, "utf8")) as { lines?: unknown }).lines;
    return Array.isArray(l) ? l.map(String) : [];
  } catch {
    return [];
  }
}

/** R612 M-2: the receipt's warn-fact readings, carried into `.gated` on a pass. */
async function receiptWarnFacts(
  path: string,
): Promise<Readonly<Record<string, string>> | undefined> {
  try {
    return warnFactReadings(
      (JSON.parse(await readFile(path, "utf8")) as { warnFacts?: unknown }).warnFacts,
    );
  } catch {
    return undefined;
  }
}

const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * M4: run in the gate worktree before any leg; a moved commit can need either. F5: the lockfile is
 * never rewritten there. The fixture `.alpackages` follow, by `prepareFixtureSymbols` (R614, shared
 * with the itest's own startup): extracted from the pinned tar, verified, or refused by name.
 */
export const GATE_STEPS: readonly (readonly string[])[] = [
  ["bun", "install", "--frozen-lockfile"],
  ["bun", "scripts/build-native-parser.ts"],
];

async function readCurrentGated(root: string): Promise<GatedBuild & { readonly dir: string }> {
  const dir = await readlink(join(root, "current"));
  return { ...parseGated(await readFile(join(dir, ".gated"), "utf8"), join(dir, ".gated")), dir };
}

/**
 * R777: a candidate is never judged on fewer legs than `V3_GATE_LEGS` requires. When `.gated`'s
 * commit predates some of them, `current` is first re-gated at this script's own commit, under the
 * caller's lock. Returns the `.gated` to judge against: the re-gated one on a pass; otherwise
 * `current`'s with this script's commit, so the candidate is still judged on every leg while
 * `current` stays put. Undefined (logged) when this script's commit cannot serve: it lacks the legs
 * too, is not on origin/master, or is older than `.gated`'s.
 */
async function gatedWithAllLegs(
  deps: UpdateDeps,
  what: string,
): Promise<(GatedBuild & { readonly dir: string }) | undefined> {
  const current = await readCurrentGated(deps.root);
  const has = new Set(await deps.legsAt(current.lethalCommit));
  const missing = V3_GATE_LEGS.filter((l) => !has.has(l));
  if (missing.length === 0) return current;
  const self = await deps.selfCommit();
  const selfHas = new Set(await deps.legsAt(self));
  const stale = `${deps.now()} ${what}: stale-gated: .gated's lethalCommit ${current.lethalCommit} predates leg(s) ${missing.join(",")} of V3_GATE_LEGS`;
  const cannot = V3_GATE_LEGS.some((l) => !selfHas.has(l))
    ? "lacks them too (uncommitted legs?)"
    : !(await deps.isAncestor(self, "origin/master"))
      ? "is not on origin/master"
      : await deps.isAncestor(self, current.lethalCommit)
        ? "is not newer than .gated's (an old checkout?)"
        : undefined;
  if (cannot !== undefined) {
    await deps.log(
      `${stale}; this script's commit ${self} ${cannot}: not gated; run it from a current master checkout, or \`--regate <master commit>\``,
    );
    return undefined;
  }
  await deps.log(`${stale}; re-gating current at ${self} first`);
  const o = await gateOne(deps, "regate", current, { regateAt: self });
  if (o === "pass") return readCurrentGated(deps.root);
  await deps.log(
    `${deps.now()} ${what}: the re-gate of current at ${self} gave ${o}: current stays at ${current.lethalCommit}; the candidate is judged at ${self}`,
  );
  return { ...current, lethalCommit: self };
}

async function infraCount(root: string, name: string, bump: boolean): Promise<number> {
  const f = join(root, "infra", `${name}.count`);
  await mkdir(join(root, "infra"), { recursive: true });
  const n = existsSync(f) ? Number(await readFile(f, "utf8")) : 0;
  const next = bump ? n + 1 : 0;
  await writeFile(f, String(next));
  return next;
}

/** `gateOne`'s options: `--regate`'s commit, or `--edge-rejudge`'s custody-checked kept binary. */
export interface GateOneOpts {
  readonly regateAt?: string;
  /** R639 M4: the kept binary (no download, no extract) and the sha its custody check gave. */
  readonly binary?: string;
  readonly binarySha256?: string;
  /** R639 M5: the kept folder the binary came from, written into `.gated` on a pass. */
  readonly rejudgedFrom?: string;
}

/** One candidate (or the current build, on `--regate`) through the gate. */
export async function gateOne(
  deps: UpdateDeps,
  tag: string,
  gated: GatedBuild,
  opts: GateOneOpts = {},
): Promise<Outcome> {
  const { root } = deps;
  const work = await mkdtemp(join(root, ".work-"));
  try {
    let binary: string;
    let tarballSha: string | undefined;
    const name = tag;
    const commit = opts.regateAt ?? gated.lethalCommit;
    // I-2: a gate-fail is final for THIS build at THIS LethAL commit only; a LethAL fix (a new
    // `.gated` commit after a re-pre-commitment) may gate the same build again. R639 I5: checked
    // before every binary path, so a rejudge can never write into an existing failed/ folder.
    const failedDir = join(root, "failed", `${name}@${commit}`);
    if (opts.regateAt === undefined && existsSync(failedDir)) {
      await deps.log(
        `${deps.now()} ${tag}: gate-fail: already gate-failed at ${commit} (${failedDir}); not gated again at this commit, \`--regate\` to re-judge`,
      );
      return "gate-fail";
    }
    if (opts.regateAt !== undefined) {
      binary = join(await readlink(join(root, "current")), "al-runner");
    } else if (opts.binary !== undefined) {
      binary = opts.binary;
    } else {
      const dl = join(work, "dl");
      await mkdir(dl);
      let got: { tarball: string; sums: string };
      try {
        got = await deps.download(tag, dl);
      } catch (err) {
        await deps.log(`${deps.now()} ${tag}: infra-fail: download: ${String(err)}`);
        return infra(deps, name);
      }
      const want = expectedSha(await readFile(got.sums, "utf8"), got.tarball);
      tarballSha = await sha256OfFile(got.tarball);
      if (want === undefined || want !== tarballSha) {
        // Logged loudly, never extracted.
        await deps.log(
          `${deps.now()} ${tag}: infra-fail: CHECKSUM MISMATCH (SHA256SUMS ${want ?? "none"}, tarball ${tarballSha}); not extracted`,
        );
        return infra(deps, name);
      }
      const x = join(work, "x");
      await mkdir(x);
      binary = await deps.extract(got.tarball, x);
    }
    const sha = await sha256OfFile(binary);
    // R639 M4: the bytes gated are the bytes the custody check read.
    if (opts.binarySha256 !== undefined && sha !== opts.binarySha256)
      throw new Error(
        `al-runner-v3-edge-rejudge-refused: ${binary} has sha256 ${sha} now, not the custody-checked ${opts.binarySha256}`,
      );
    const version = await deps.versionOf(binary);
    const nonce = randomUUID();
    const receipt = join(work, "receipt.json");
    await rm(receipt, { force: true });
    try {
      await deps.runGate(
        commit,
        {
          LETHAL_ITEST_ALRUNNER_V3: "1",
          LETHAL_ALRUNNER_V3_PATH: binary,
          ...(opts.regateAt === undefined ? { LETHAL_ALRUNNER_V3_CANDIDATE: "1" } : {}),
          LETHAL_ITEST_V3_TABLES: "1",
          LETHAL_ITEST_V3_CDO: process.env.LETHAL_ITEST_V3_CDO ?? V3_CDO_DEFAULT,
          LETHAL_V3_GATE_NONCE: nonce,
          LETHAL_V3_GATE_RECEIPT: receipt,
        },
        (line) => deps.log(`${deps.now()} ${tag}: ${line}`),
      );
    } catch (err) {
      // A failing gate still writes its receipt; the receipt decides. R633 I1: the error is logged.
      await deps.log(
        `${deps.now()} ${tag}: the gate exited with an error: ${String(err).slice(0, 1000)}`,
      );
    }
    const { outcome, why } = await readReceipt(receipt, nonce, sha, commit);
    const lines = await receiptLines(receipt);
    await deps.log(
      `${deps.now()} ${tag} (${version}, ${sha}) at ${commit}: ${outcome}: ${why}${lines.length > 0 ? `; lines: ${lines.join(" | ")}` : ""}`,
    );
    // R632 C, R633 I1: the receipt and the gate's own output (`gate.log`) outlive `work`, beside the
    // outcome they gave, each when it exists. R633 M2: a failed copy is logged and never blocks the
    // verdict, `.gated` or the count.
    const gateLog = join(work, "gate.log");
    const keep = async (dir: string, prefix = "") => {
      for (const [from, file] of [
        [receipt, "receipt.json"],
        [gateLog, "gate.log"],
      ] as const) {
        if (!existsSync(from)) continue;
        try {
          await mkdir(dir, { recursive: true });
          await cp(from, join(dir, `${prefix}${file}`));
        } catch (err) {
          await deps.log(`${deps.now()} ${tag}: ${file} not kept in ${dir}: ${String(err)}`);
        }
      }
    };
    if (opts.regateAt !== undefined) await keep(join(root, "regate"), `${commit}.`);
    // R639 §6 step 8: a rejudge's evidence, whatever the outcome; nothing old is moved or rewritten.
    const rejudge = opts.binary !== undefined;
    if (rejudge) await keep(join(root, "rejudge", `${name}@${commit}`));
    if (outcome === "infra-fail") {
      if (opts.regateAt === undefined) await keep(join(root, "infra"), `${name}.`);
      return infra(deps, name);
    }
    await infraCount(root, name, false);
    if (outcome === "gate-fail") {
      if (opts.regateAt === undefined) {
        await mkdir(failedDir, { recursive: true });
        await cp(binary, join(failedDir, "al-runner"));
        await keep(failedDir);
      }
      return "gate-fail";
    }
    if (outcome === "held") {
      const heldDir = join(root, "held", name);
      // R639: a rejudge never rewrites an existing held/<tag>/ (its record stays in rejudge/).
      if (opts.regateAt === undefined && !(rejudge && existsSync(heldDir))) {
        await mkdir(heldDir, { recursive: true });
        await cp(binary, join(heldDir, "al-runner"));
        await keep(heldDir);
      }
      await deps.log(
        `${deps.now()} ${tag}: HELD for the orchestrator: every difference is a move toward BC or a named refusal; read the receipt's lines; re-pre-commit, then re-gate`,
      );
      return "held";
    }
    // pass
    const dirName =
      opts.regateAt !== undefined
        ? undefined
        : `${tag.replace(/^v/, "")}-${/\(([0-9a-f]+)\)/.exec(version)?.[1] ?? "unknown"}`;
    const dest =
      dirName === undefined ? await readlink(join(root, "current")) : join(root, dirName);
    if (dirName !== undefined) {
      await mkdir(dest, { recursive: true });
      await cp(binary, join(dest, "al-runner"));
      await chmod(join(dest, "al-runner"), 0o755);
    }
    // R612 M-2: this gate's warn-fact readings, so a session shows what the gate read.
    const warnFacts = await receiptWarnFacts(receipt);
    const next: GatedBuild = {
      ...(warnFacts !== undefined ? { warnFacts } : {}),
      version,
      binarySha256: sha,
      lethalCommit: commit,
      // M5 (R639): only `--regate` (the same binary) inherits the tarball; a rejudge names its
      // kept folder instead.
      ...(tarballSha !== undefined
        ? { tarballSha256: tarballSha }
        : opts.regateAt !== undefined && gated.tarballSha256 !== undefined
          ? { tarballSha256: gated.tarballSha256 }
          : {}),
      ...(opts.rejudgedFrom !== undefined
        ? { rejudgedFrom: opts.rejudgedFrom }
        : opts.regateAt !== undefined && gated.rejudgedFrom !== undefined
          ? { rejudgedFrom: gated.rejudgedFrom }
          : {}),
      gatedAt: deps.now(),
    };
    await writeFile(join(dest, ".gated"), `${JSON.stringify(next, null, 2)}\n`);
    if (dirName !== undefined) {
      if (await deps.inUse()) {
        await deps.log(`${deps.now()} ${tag}: passed; deferred: in use (current not moved)`);
        return "pass";
      }
      const tmp = join(root, `current.${randomUUID()}`);
      await symlink(dest, tmp);
      await rename(tmp, join(root, "current"));
      await deps.log(`${deps.now()} ${tag}: current -> ${dest} (a line for R586)`);
    }
    return "pass";
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

async function infra(deps: UpdateDeps, name: string): Promise<Outcome> {
  const n = await infraCount(deps.root, name, true);
  if (n >= 3)
    await deps.log(`${deps.now()} ${name}: ${n} infra-fails in a row: a line for the orchestrator`);
  return "infra-fail";
}

/**
 * The daily run: the candidates above the gated alpha, newest first, until one passes (R586d). A
 * candidate that does not pass (gate-fail, held, infra-fail, or already in `failed/`) sends the run
 * to the next older one. Older releases skipped after a pass get no verdict that day.
 */
export async function updateOnce(
  deps: UpdateDeps,
  opts: { readonly regateAt?: string } = {},
): Promise<(Outcome | "skipped")[]> {
  // R632 D: the D legs make every gate a corpus job, on this path too.
  const what = opts.regateAt !== undefined ? "regate" : "alpha";
  if (await skippedForTheDay(deps, what)) return ["skipped"];
  const lock = await takeGateLock(deps, what);
  if (lock === undefined) return ["skipped"];
  try {
    return await updateLocked(deps, opts);
  } finally {
    await lock.release();
  }
}

async function updateLocked(
  deps: UpdateDeps,
  opts: { readonly regateAt?: string },
): Promise<(Outcome | "skipped")[]> {
  if (opts.regateAt !== undefined)
    return [await gateOne(deps, "regate", await readCurrentGated(deps.root), opts)];
  const current = await gatedWithAllLegs(deps, "alpha");
  if (current === undefined) return ["skipped"];
  const gatedAlpha = /3\.0\.0-alpha\.(\d+)/.exec(current.version)?.[1];
  if (gatedAlpha === undefined)
    throw new Error(`the gated build "${current.version}" is not a v3 alpha`);
  const out: Outcome[] = [];
  const unjudged: string[] = [];
  for (const tag of candidates(await deps.listReleases(), Number(gatedAlpha))) {
    const o = await gateOne(deps, tag, current);
    out.push(o);
    if (o === "infra-fail") unjudged.push(tag);
    if (o === "pass") {
      // A newer release the gate could not judge today is not a verdict: say so.
      for (const t of unjudged)
        await deps.log(`${deps.now()} ${tag}: passed after ${t} was not judged (infra-fail) today`);
      break;
    }
  }
  return out;
}

/**
 * The daily EDGE path (owner request, via the orchestrator): upstream's `edge` release by download.
 * - Skipped for the day, with the reason logged, when 3 or more other heavy jobs run container-wide or
 *   `free -g` shows under 10 GB available.
 * - A NO-OP when edge's commit equals the one last seen (`<root>/edge.last-seen`).
 * - Otherwise the candidate goes through `gateOne`: the checksum is checked before anything is
 *   extracted, the receipt is matched by nonce and sha256, the gate runs at `.gated`'s commit, and
 *   only a `pass` moves `current`. `held` is kept, never blacklisted.
 * The commit is recorded as seen once the gate gave an answer other than `infra-fail`, so an
 * infrastructure failure is retried the next day.
 */
export interface EdgeDeps {
  /** Edge's commit (short or full sha), from `gh release view edge`. */
  edgeCommit(): Promise<string>;
}

export type EdgeResult = "skipped" | "no-op" | Outcome;

/**
 * A heavy job's command line (`/proc/<pid>/cmdline`, NULs as spaces): an itest, `cli.ts run`, verify or
 * a corpus job. R633 M5: bun may appear by a full path (`/home/dev/.bun/bin/bun ...`).
 */
export const HEAVY_JOB =
  /(^|\/)bun packages\/runner\/itest\/[\w-]+\.itest\.ts|cli\.ts run|(^|\/)bun scripts\/verify\.ts|\/work\/src\/(BC\.History|DC|DO|do-lethal)/;

/**
 * R633 I2: a `--regate` (R639: or an `--edge-rejudge`) that was skipped exits 2, so a `&&` chain
 * stops.
 */
export function updateExitCode(mustRun: boolean, out: readonly string[]): number {
  return mustRun && out[0] === "skipped" ? 2 : 0;
}

/**
 * True, with the reason logged, when 3 or more OTHER heavy jobs run or under 10 GB is available:
 * at most 3 heavy jobs container-wide (2026-10-22, 32 GB), counting the gate itself. The BaseApp
 * cap of two does not apply to the gate.
 */
async function skippedForTheDay(deps: UpdateDeps, what: string): Promise<boolean> {
  const heavy = await deps.heavyJobs();
  if (heavy >= 3) {
    await deps.log(
      `${deps.now()} ${what}: skipped for the day: ${heavy} heavy jobs are running (limit: 2 others)`,
    );
    return true;
  }
  const free = await deps.freeGb();
  if (free < 10) {
    await deps.log(`${deps.now()} ${what}: skipped for the day: ${free} GB available (needs 10)`);
    return true;
  }
  return false;
}

/** The holder a lock file names, or undefined when it is empty or unreadable. */
async function lockHolder(
  path: string,
): Promise<{ readonly pid: number; readonly startedAt: string } | undefined> {
  try {
    const h = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown; startedAt?: unknown };
    return typeof h.pid === "number" && typeof h.startedAt === "string"
      ? { pid: h.pid, startedAt: h.startedAt }
      : undefined;
  } catch {
    return undefined;
  }
}

/** `link()` a fully written temp file to `lock`: atomic, so the lock is never seen half-written. */
async function linkLock(lock: string, body: string): Promise<boolean> {
  const tmp = `${lock}.${randomUUID()}`;
  await writeFile(tmp, body);
  try {
    await link(tmp, lock);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

/**
 * R639 I3: one lock, `<root>/.gate.lock`, around every gate path (the alpha path, `--regate`,
 * `--edge`, `--edge-rejudge`), since all of them check out and run in `GATE_WORKTREE`. A holder is
 * live only when its `/proc/<pid>/cmdline` names `al-runner-v3-update`; a dead, reused, empty or
 * unreadable holder is stale, and is taken over (by rename, then a second `link`) unless a process
 * still runs under `GATE_WORKTREE` (an orphaned itest child). Every skip is logged with the manual
 * clear step and returns `undefined`.
 */
export async function takeGateLock(
  deps: UpdateDeps,
  what: string,
): Promise<{ release(): Promise<void> } | undefined> {
  const lock = join(deps.root, ".gate.lock");
  const me = { pid: process.pid, startedAt: deps.now() };
  const body = JSON.stringify({ ...me, argv: process.argv });
  const release = async () => {
    const h = await lockHolder(lock);
    if (h?.pid === me.pid && h.startedAt === me.startedAt) await unlink(lock).catch(() => {});
  };
  if (await linkLock(lock, body)) return { release };
  const h = await lockHolder(lock);
  const skip = async (why: string) => {
    await deps.log(
      `${deps.now()} ${what}: skipped: the gate lock ${lock} is held by pid ${h?.pid ?? "?"} since ${h?.startedAt ?? "?"} (${why}); check that no process runs under ${GATE_WORKTREE}, then \`rm ${lock}\``,
    );
    return undefined;
  };
  if (
    h !== undefined &&
    h.pid !== process.pid &&
    ((await deps.procCmdline(h.pid)) ?? "").includes("al-runner-v3-update")
  )
    return skip("a live al-runner-v3-update");
  if (h === undefined)
    await deps.log(`${deps.now()} ${what}: the gate lock ${lock} is empty or unreadable: stale`);
  const orphans = await deps.procsWithCwdUnder(GATE_WORKTREE);
  if (orphans.length > 0)
    return skip(`stale, but pid(s) ${orphans.join(", ")} still run under ${GATE_WORKTREE}`);
  // ponytail: two runs that both find the same stale lock in the same instant can both take it; needs a stale lock plus simultaneous starts. Upgrade: re-read the lock before and after the rename and skip unless it still names the dead holder.
  await rename(lock, `${lock}.stale.${randomUUID()}`).catch(() => {});
  if (!(await linkLock(lock, body))) return skip("another run took it over first");
  await deps.log(`${deps.now()} ${what}: took over the stale gate lock ${lock}`);
  return { release };
}

/** The kept folders of `tag`: `failed/<tag>@*` and `held/<tag>`, each with a binary and a receipt. */
async function keptFolders(root: string, tag: string): Promise<string[]> {
  const failed = join(root, "failed");
  const names = existsSync(failed) ? await readdir(failed) : [];
  return [
    ...names.filter((n) => n.startsWith(`${tag}@`)).map((n) => join(failed, n)),
    join(root, "held", tag),
  ].filter((d) => existsSync(join(d, "al-runner")) && existsSync(join(d, "receipt.json")));
}

/**
 * R639 `--edge-rejudge <edge sha>` (plan r2 §6, r3 I4/I5, M4/M5): re-gate a KEPT edge binary at
 * `.gated`'s current commit. It never downloads, never reads or writes `edge.last-seen`, and never
 * deletes, moves or rewrites anything under `failed/` or `held/`. A refusal throws.
 */
export async function edgeRejudge(deps: UpdateDeps, arg: string): Promise<Outcome | "skipped"> {
  const refuse = (why: string): never => {
    throw new Error(`al-runner-v3-edge-rejudge-refused: ${why}`);
  };
  if (!/^[0-9a-f]{7,40}$/.test(arg)) refuse(`"${arg}" is not a 7-40 character sha`);
  if (await skippedForTheDay(deps, "edge-rejudge")) return "skipped";
  const lock = await takeGateLock(deps, "edge-rejudge");
  if (lock === undefined) return "skipped";
  try {
    const { root } = deps;
    const tag = `edge-${arg}`;
    // Custody: every kept copy is the bytes its receipt names, and all are one build.
    const folders = await keptFolders(root, tag);
    if (folders.length === 0)
      refuse(`no kept binary with a receipt for ${tag} in failed/ or held/`);
    const before: string[] = [];
    let sha: string | undefined;
    for (const d of folders) {
      const r = JSON.parse(await readFile(join(d, "receipt.json"), "utf8")) as {
        binarySha256?: unknown;
        outcome?: unknown;
        lethalCommit?: unknown;
      };
      const s = await sha256OfFile(join(d, "al-runner"));
      if (s !== r.binarySha256)
        refuse(`${d}/al-runner has sha256 ${s}, its receipt names ${String(r.binarySha256)}`);
      if (sha !== undefined && s !== sha)
        refuse(`two different kept builds of ${tag} (${sha}, ${s})`);
      sha = s;
      before.push(`${String(r.outcome)}@${String(r.lethalCommit)}`);
    }
    const [from] = folders;
    if (from === undefined || sha === undefined) return refuse(`no kept binary for ${tag}`);
    const binary = join(from, "al-runner");
    // I4: the kept bytes ARE the build the argument names.
    const v = /\(([0-9a-f]+)\)$/.exec((await deps.versionOf(binary)).trim())?.[1] ?? "";
    if (v.length < 7 || !(v.startsWith(arg) || arg.startsWith(v)))
      refuse(`${binary} reports commit "${v}", not ${arg}`);
    // R777: after the cheap refusals, since a stale `.gated` costs a re-gate first.
    const current = await gatedWithAllLegs(deps, "edge-rejudge");
    if (current === undefined) return "skipped";
    const commit = current.lethalCommit;
    // I5: at the same commit a verdict is final, whether or not its folder holds a receipt.
    const judged = () =>
      refuse(`${tag} already judged at ${commit}; --regate to a new commit first`);
    if (existsSync(join(root, "failed", `${tag}@${commit}`))) judged();
    for (const r of [
      join(root, "rejudge", `${tag}@${commit}`, "receipt.json"),
      join(root, "held", tag, "receipt.json"),
    ]) {
      const k = existsSync(r)
        ? (JSON.parse(await readFile(r, "utf8")) as { lethalCommit?: unknown; outcome?: unknown })
        : undefined;
      if (k?.lethalCommit === commit && k.outcome !== "infra-fail") judged();
    }
    const outcome = await gateOne(deps, tag, current, {
      binary,
      binarySha256: sha,
      rejudgedFrom: from,
    });
    const same = before.every((b) => b.startsWith(`${outcome}@`));
    await deps.log(
      `${deps.now()} edge-rejudge ${tag} (${sha}) at ${commit}: ${outcome}; before: ${before.join(", ")}; ${same ? "same" : "different"}`,
    );
    return outcome;
  } finally {
    await lock.release();
  }
}

export async function edgeOnce(deps: UpdateDeps & EdgeDeps): Promise<EdgeResult> {
  if (await skippedForTheDay(deps, "edge")) return "skipped";
  const lock = await takeGateLock(deps, "edge");
  if (lock === undefined) return "skipped";
  try {
    return await edgeLocked(deps);
  } finally {
    await lock.release();
  }
}

async function edgeLocked(deps: UpdateDeps & EdgeDeps): Promise<EdgeResult> {
  const commit = (await deps.edgeCommit()).trim();
  if (!/^[0-9a-f]{7,40}$/.test(commit)) throw new Error(`edge's commit "${commit}" is not a sha`);
  const seenFile = join(deps.root, "edge.last-seen");
  const seen = existsSync(seenFile) ? (await readFile(seenFile, "utf8")).trim() : "";
  if (seen === commit) {
    await deps.log(`${deps.now()} edge: no-op: commit ${commit} was already gated`);
    return "no-op";
  }
  // Not marked seen when skipped here: the edge is retried once current re-gates.
  const current = await gatedWithAllLegs(deps, "edge");
  if (current === undefined) return "skipped";
  const outcome = await gateOne(deps, `edge-${commit}`, current);
  if (outcome !== "infra-fail") await writeFile(seenFile, `${commit}\n`);
  return outcome;
}

/**
 * Runs `argv`; returns its stdout, and throws on a non-zero exit with the tail of its stderr. With
 * `logPath` (R633 I1), stdout and stderr are written there first, on EVERY exit, so the gate's own
 * output (leg C's per-fact lines included) survives a failing run.
 */
export async function runToLog(
  argv: string[],
  env: Record<string, string> = {},
  cwd?: string,
  logPath?: string,
): Promise<string> {
  const p = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
    ...(cwd !== undefined ? { cwd } : {}),
  });
  const [out, err] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  const code = await p.exited;
  if (logPath !== undefined)
    await writeFile(
      logPath,
      `$ ${argv.join(" ")}\n-- exit ${code}\n-- stdout\n${out}\n-- stderr\n${err}\n`,
    );
  if (code !== 0) throw new Error(`${argv.join(" ")}: exit ${code}: ${err.slice(-400)}`);
  return out;
}

/** Real side effects. */
export function realDeps(root = ROOT): UpdateDeps {
  const run = (argv: string[], env: Record<string, string> = {}, cwd?: string) =>
    runToLog(argv, env, cwd);
  return {
    root,
    listReleases: async () =>
      (
        await run([
          "gh",
          "release",
          "list",
          "--repo",
          REPO,
          "--limit",
          "50",
          "--json",
          "tagName",
          "--jq",
          ".[].tagName",
        ])
      )
        .split("\n")
        .filter((t) => t !== ""),
    download: async (tag, dir) => {
      await run([
        "gh",
        "release",
        "download",
        tag.startsWith("edge-") ? "edge" : tag,
        "--repo",
        REPO,
        "--dir",
        dir,
        "--pattern",
        "*x86_64-unknown-linux*.tar.xz",
        "--pattern",
        "SHA256SUMS",
      ]);
      const files = await readdir(dir);
      const tarball = files.find((f) => f.endsWith(".tar.xz"));
      if (tarball === undefined || !files.includes("SHA256SUMS"))
        throw new Error(`release ${tag} has no linux-x64 tarball or SHA256SUMS`);
      return { tarball: join(dir, tarball), sums: join(dir, "SHA256SUMS") };
    },
    extract: async (tarball, dir) => {
      await run(["tar", "-xJf", tarball, "-C", dir]);
      for (const n of ["al-runner", "alrunner"]) if (existsSync(join(dir, n))) return join(dir, n);
      throw new Error(`no al-runner binary in ${tarball}`);
    },
    versionOf: async (b) => (await run([b, "--version"])).trim(),
    runGate: async (commit, env, log) => {
      if (!existsSync(GATE_WORKTREE))
        await run([
          "git",
          "-C",
          process.cwd(),
          "worktree",
          "add",
          "--detach",
          GATE_WORKTREE,
          commit,
        ]);
      await run(["git", "-C", GATE_WORKTREE, "checkout", "--detach", commit]);
      // M4: prepare the worktree, or refuse by name before any leg (a throw here is infra-fail:
      // no receipt is written).
      for (const step of GATE_STEPS) await run([...step], {}, GATE_WORKTREE);
      // R614: extracted from the pinned tar, verified against it, or refused by name.
      // I2: logged at once, so the first run's `marked` (or an `extracted`) shows in the update log.
      const prepared = await prepareFixtureSymbols({ worktree: GATE_WORKTREE });
      await log(`fixture .alpackages: ${prepared}`);
      // R633 I1: the itest's own output goes to `gate.log` beside the receipt; `gateOne` keeps it.
      const receipt = env.LETHAL_V3_GATE_RECEIPT;
      await runToLog(
        ["bun", "run", "itest:alrunner-v3"],
        { ...env },
        GATE_WORKTREE,
        receipt !== undefined ? join(dirname(receipt), "gate.log") : undefined,
      );
    },
    inUse: async () => {
      for (const pid of await readdir("/proc")) {
        if (!/^\d+$/.test(pid)) continue;
        const exe = await readlink(`/proc/${pid}/exe`).catch(() => "");
        if (exe.startsWith(`${root}/`)) return true;
      }
      return false;
    },
    log: async (line) => {
      console.log(line);
      await writeFile(LOG, `${line}\n`, { flag: "a" }).catch(() => {});
    },
    now: () => new Date().toISOString(),
    heavyJobs: async () => {
      let n = 0;
      for (const pid of await readdir("/proc")) {
        if (!/^\d+$/.test(pid)) continue;
        const cmd = (await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).replaceAll(
          "\0",
          " ",
        );
        if (HEAVY_JOB.test(cmd)) n++;
      }
      return n;
    },
    freeGb: async () => {
      const p = Bun.spawn(["free", "-g"], { stdout: "pipe" });
      const out = await new Response(p.stdout).text();
      const mem = out
        .split("\n")
        .find((l) => l.startsWith("Mem:"))
        ?.trim()
        .split(/\s+/);
      const avail = Number(mem?.[6]);
      if (!Number.isFinite(avail)) throw new Error(`cannot read free -g: ${out}`);
      return avail;
    },
    procCmdline: async (pid) =>
      readFile(`/proc/${pid}/cmdline`, "utf8")
        .then((c) => c.replaceAll("\0", " "))
        .catch(() => undefined),
    procsWithCwdUnder: async (dir) => {
      const pids: number[] = [];
      for (const pid of await readdir("/proc")) {
        if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
        const cwd = await readlink(`/proc/${pid}/cwd`).catch(() => "");
        if (cwd === dir || cwd.startsWith(`${dir}/`)) pids.push(Number(pid));
      }
      return pids;
    },
    legsAt: async (commit) =>
      parseGateLegs(
        await run([
          "git",
          "-C",
          dirname(import.meta.dir),
          "show",
          `${commit}:packages/runner/itest/al-runner-v3-gate.ts`,
        ]),
      ),
    selfCommit: async () =>
      (await run(["git", "-C", dirname(import.meta.dir), "rev-parse", "HEAD"])).trim(),
    isAncestor: async (a, b) =>
      (
        await Bun.spawn(
          ["git", "-C", dirname(import.meta.dir), "merge-base", "--is-ancestor", a, b],
          { stdout: "ignore", stderr: "ignore" },
        ).exited
      ) === 0,
  };
}

/** The edge path's real side effects, with the per-day log. */
export function realEdgeDeps(root = ROOT): UpdateDeps & EdgeDeps {
  const base = realDeps(root);
  const day = new Date().toISOString().slice(0, 10);
  const log = `/coord/handoff/al-runner-v3-update/${day}.log`;
  return {
    ...base,
    log: async (line) => {
      console.log(line);
      await mkdir("/coord/handoff/al-runner-v3-update", { recursive: true }).catch(() => {});
      await writeFile(log, `${line}\n`, { flag: "a" }).catch(() => {});
    },
    edgeCommit: async () => {
      const p = Bun.spawn(
        ["gh", "release", "view", "edge", "--repo", REPO, "--json", "targetCommitish,name,body"],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const out = await new Response(p.stdout).text();
      if ((await p.exited) !== 0) throw new Error("gh release view edge failed");
      const j = JSON.parse(out) as { targetCommitish?: string; name?: string; body?: string };
      const sha = [j.targetCommitish, j.name, j.body]
        .map((s) => /\b[0-9a-f]{7,40}\b/.exec(s ?? "")?.[0])
        .find((s) => s !== undefined);
      if (sha === undefined) throw new Error("edge names no commit");
      return sha;
    },
  };
}

if (import.meta.main && process.argv.includes("--edge")) {
  console.log(`al-runner-v3-update --edge: ${await edgeOnce(realEdgeDeps())}`);
} else if (import.meta.main && process.argv.includes("--edge-rejudge")) {
  const sha = process.argv[process.argv.indexOf("--edge-rejudge") + 1] ?? "";
  const out = await edgeRejudge(realEdgeDeps(), sha);
  console.log(`al-runner-v3-update --edge-rejudge: ${out}`);
  process.exitCode = updateExitCode(true, [out]);
} else if (import.meta.main) {
  const i = process.argv.indexOf("--regate");
  const regateAt = i >= 0 ? process.argv[i + 1] : undefined;
  if (i >= 0 && (regateAt === undefined || !/^[0-9a-f]{40}$/.test(regateAt))) {
    throw new Error("--regate needs a full 40-character LethAL commit sha (F6)");
  }
  const out = await updateOnce(realDeps(), regateAt !== undefined ? { regateAt } : {});
  console.log(`al-runner-v3-update: ${out.join(", ") || "no candidate"}`);
  process.exitCode = updateExitCode(regateAt !== undefined, out);
}
