/**
 * R586 §12 (plan `docs/superpowers/plans/2026-10-21-r586-alrunner-v3-backend.md`, r2 §12 with r3's
 * F6 and r4's I-3): the al-runner v3 update gate. Separate from `al-runner-update.sh` (the frozen
 * .NET al-runner). Daily, or by hand:
 *
 *   bun scripts/al-runner-v3-update.ts [--regate <lethal commit>]
 *   bun scripts/al-runner-v3-update.ts --edge        (the daily edge-by-download path, `edgeOnce`)
 *
 * 1. Candidates: `v3.0.0-alpha.N` releases of aldevtools/BusinessCentral.AL.Runner with N above the
 *    gated build's. `edge` only through `--edge`, never as an alpha candidate.
 * 2. The linux-x64 tarball and SHA256SUMS go into a NEW empty folder; a checksum mismatch is
 *    `infra-fail` and the tarball is NEVER extracted. Extraction goes into another new folder.
 * 3. The gate runs in a detached worktree at `.gated`'s `lethalCommit` (never a moving master), with
 *    `LETHAL_ALRUNNER_V3_CANDIDATE=1`, the CDO corpus and leg T. Its receipt is deleted before the
 *    run and accepted only with this run's nonce AND the candidate's binary sha256.
 * 4. Outcomes: `pass` -> installed, `.gated` written, `current` moved (unless a v3 process is
 *    running: "deferred: in use"); `gate-fail` -> `failed/` for good; `held` (every difference a
 *    move toward BC) -> `held/`, never blacklisted, a line for the orchestrator to re-pre-commit;
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
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  type V3LegOutcome,
  V3_GATE_LEGS,
  gateOutcome,
} from "../packages/runner/itest/al-runner-v3-gate";
import { type GatedBuild, parseGated, sha256OfFile } from "../packages/runner/src/al-runner-v3-pin";

export const ROOT = "/work/tools/al-runner-v3";
export const REPO = "aldevtools/BusinessCentral.AL.Runner";
export const GATE_WORKTREE = "/work/lethal-wt/al-runner-v3-gate";
export const LOG = "/coord/handoff/R-586/v3-updates.log";

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
  /** Checks out `commit` detached in the gate worktree and runs the gate with `env`. */
  runGate(commit: string, env: Readonly<Record<string, string>>): Promise<void>;
  /** A running process whose executable resolves under `root`. */
  inUse(): Promise<boolean>;
  log(line: string): Promise<void>;
  now(): string;
}

/** `v3.0.0-alpha.N` -> N; anything else (edge, other lines) -> undefined. */
export function alphaOf(tag: string): number | undefined {
  const m = /^v3\.0\.0-alpha\.(\d+)$/.exec(tag);
  return m === null ? undefined : Number(m[1]);
}

/** Candidates above the gated alpha, oldest first; never `edge`. */
export function candidates(tags: readonly string[], gatedAlpha: number): string[] {
  return tags
    .map((t) => ({ t, n: alphaOf(t) }))
    .filter((x): x is { t: string; n: number } => x.n !== undefined && x.n > gatedAlpha)
    .sort((a, b) => a.n - b.n)
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
    outcome?: unknown;
    legs?: unknown;
  };
  if (r.nonce !== nonce) return { outcome: "infra-fail", why: "a receipt of another run (nonce)" };
  if (r.binarySha256 !== sha)
    return { outcome: "infra-fail", why: "a receipt for another binary (sha256)" };
  const at = typeof r.lethalCommit === "string" ? r.lethalCommit : "";
  if (at === "" || !(at.startsWith(commit) || commit.startsWith(at)))
    return {
      outcome: "infra-fail",
      why: `a receipt of LethAL ${at || "(none)"}, not the requested ${commit}`,
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
  return { outcome: r.outcome, why: `receipt legs ${JSON.stringify(legs)}` };
}

/** Fixture symbol folders the gate's legs compile against (gitignored, from the kraken tar). */
export const GATE_ALPACKAGES = [
  "fixtures/sandbox-tests/.alpackages",
  "fixtures/sandbox-data-tests/.alpackages",
] as const;

/**
 * M4: what the gate worktree needs before any leg, or why it cannot be prepared. `bun install` and
 * the native parser build always run (a moved commit can need either). The fixture symbol folders
 * come from the main checkout's `fixture-symbols.tar` when absent; with neither, the gate is refused
 * by name (`al-runner-v3-gate-worktree-unprepared`), an infra-fail before any leg.
 */
export function gatePreparation(s: {
  readonly worktree: string;
  readonly alpackagesPresent: boolean;
  readonly symbolTar: string | undefined;
}): { readonly steps: readonly string[][] } | { readonly refused: string } {
  const steps: string[][] = [
    ["bun", "install"],
    ["bun", "scripts/build-native-parser.ts"],
  ];
  if (!s.alpackagesPresent) {
    if (s.symbolTar === undefined)
      return {
        refused: `al-runner-v3-gate-worktree-unprepared: ${s.worktree} has no fixture .alpackages (${GATE_ALPACKAGES.join(", ")}) and no fixture-symbols.tar was found to extract them from`,
      };
    steps.push(["tar", "-xf", s.symbolTar, "-C", s.worktree]);
  }
  return { steps };
}

async function readCurrentGated(root: string): Promise<GatedBuild & { readonly dir: string }> {
  const dir = await readlink(join(root, "current"));
  return { ...parseGated(await readFile(join(dir, ".gated"), "utf8"), join(dir, ".gated")), dir };
}

async function infraCount(root: string, name: string, bump: boolean): Promise<number> {
  const f = join(root, "infra", `${name}.count`);
  await mkdir(join(root, "infra"), { recursive: true });
  const n = existsSync(f) ? Number(await readFile(f, "utf8")) : 0;
  const next = bump ? n + 1 : 0;
  await writeFile(f, String(next));
  return next;
}

/** One candidate (or the current build, on `--regate`) through the gate. */
export async function gateOne(
  deps: UpdateDeps,
  tag: string,
  gated: GatedBuild,
  opts: { readonly regateAt?: string } = {},
): Promise<Outcome> {
  const { root } = deps;
  const work = await mkdtemp(join(root, ".work-"));
  try {
    let binary: string;
    let tarballSha: string | undefined;
    const name = tag;
    const commit = opts.regateAt ?? gated.lethalCommit;
    // I-2: a gate-fail is final for THIS build at THIS LethAL commit only; a LethAL fix (a new
    // `.gated` commit after a re-pre-commitment) may gate the same build again.
    const failedDir = join(root, "failed", `${name}@${commit}`);
    if (opts.regateAt !== undefined) {
      binary = join(await readlink(join(root, "current")), "al-runner");
    } else {
      if (existsSync(failedDir)) return "gate-fail";
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
    const version = await deps.versionOf(binary);
    const nonce = randomUUID();
    const receipt = join(work, "receipt.json");
    await rm(receipt, { force: true });
    try {
      await deps.runGate(commit, {
        LETHAL_ITEST_ALRUNNER_V3: "1",
        LETHAL_ALRUNNER_V3_PATH: binary,
        ...(opts.regateAt === undefined ? { LETHAL_ALRUNNER_V3_CANDIDATE: "1" } : {}),
        LETHAL_ITEST_V3_TABLES: "1",
        LETHAL_V3_GATE_NONCE: nonce,
        LETHAL_V3_GATE_RECEIPT: receipt,
      });
    } catch {
      // A failing gate still writes its receipt; the receipt decides.
    }
    const { outcome, why } = await readReceipt(receipt, nonce, sha, commit);
    await deps.log(`${deps.now()} ${tag} (${version}, ${sha}) at ${commit}: ${outcome}: ${why}`);
    if (outcome === "infra-fail") return infra(deps, name);
    await infraCount(root, name, false);
    if (outcome === "gate-fail") {
      if (opts.regateAt === undefined) {
        await mkdir(failedDir, { recursive: true });
        await cp(binary, join(failedDir, "al-runner"));
      }
      return "gate-fail";
    }
    if (outcome === "held") {
      if (opts.regateAt === undefined) {
        await mkdir(join(root, "held", name), { recursive: true });
        await cp(binary, join(root, "held", name, "al-runner"));
      }
      await deps.log(
        `${deps.now()} ${tag}: HELD for the orchestrator: every difference is a move toward BC; re-pre-commit, then re-gate`,
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
    const next: GatedBuild = {
      version,
      binarySha256: sha,
      lethalCommit: commit,
      ...(tarballSha !== undefined
        ? { tarballSha256: tarballSha }
        : gated.tarballSha256 !== undefined
          ? { tarballSha256: gated.tarballSha256 }
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

/** The daily run: every candidate above the gated alpha, oldest first, until one passes. */
export async function updateOnce(
  deps: UpdateDeps,
  opts: { readonly regateAt?: string } = {},
): Promise<Outcome[]> {
  const current = await readCurrentGated(deps.root);
  if (opts.regateAt !== undefined) return [await gateOne(deps, "regate", current, opts)];
  const gatedAlpha = /3\.0\.0-alpha\.(\d+)/.exec(current.version)?.[1];
  if (gatedAlpha === undefined)
    throw new Error(`the gated build "${current.version}" is not a v3 alpha`);
  const out: Outcome[] = [];
  for (const tag of candidates(await deps.listReleases(), Number(gatedAlpha))) {
    const o = await gateOne(deps, tag, current);
    out.push(o);
    if (o === "pass") break;
  }
  return out;
}

/**
 * The daily EDGE path (owner request, via the orchestrator): upstream's `edge` release by download.
 * - Skipped for the day, with the reason logged, when 2 or more heavy jobs run container-wide or
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
  /** Heavy jobs running container-wide (bun itests, `cli.ts run`, corpus jobs, verify). */
  heavyJobs(): Promise<number>;
  /** `free -g`'s available column. */
  freeGb(): Promise<number>;
}

export type EdgeResult = "skipped" | "no-op" | Outcome;

export async function edgeOnce(deps: UpdateDeps & EdgeDeps): Promise<EdgeResult> {
  const heavy = await deps.heavyJobs();
  if (heavy >= 2) {
    await deps.log(
      `${deps.now()} edge: skipped for the day: ${heavy} heavy jobs are running (limit: 1 other)`,
    );
    return "skipped";
  }
  const free = await deps.freeGb();
  if (free < 10) {
    await deps.log(`${deps.now()} edge: skipped for the day: ${free} GB available (needs 10)`);
    return "skipped";
  }
  const commit = (await deps.edgeCommit()).trim();
  if (!/^[0-9a-f]{7,40}$/.test(commit)) throw new Error(`edge's commit "${commit}" is not a sha`);
  const seenFile = join(deps.root, "edge.last-seen");
  const seen = existsSync(seenFile) ? (await readFile(seenFile, "utf8")).trim() : "";
  if (seen === commit) {
    await deps.log(`${deps.now()} edge: no-op: commit ${commit} was already gated`);
    return "no-op";
  }
  const current = await readCurrentGated(deps.root);
  const outcome = await gateOne(deps, `edge-${commit}`, current);
  if (outcome !== "infra-fail") await writeFile(seenFile, `${commit}\n`);
  return outcome;
}

/** Real side effects. */
export function realDeps(root = ROOT): UpdateDeps {
  const run = async (argv: string[], env: Record<string, string> = {}, cwd?: string) => {
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
    if (code !== 0) throw new Error(`${argv.join(" ")}: exit ${code}: ${err.slice(-400)}`);
    return out;
  };
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
    runGate: async (commit, env) => {
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
      const tar = ["/work/lethal/.kraken-local/fixture-symbols.tar"].find((p) => existsSync(p));
      const prep = gatePreparation({
        worktree: GATE_WORKTREE,
        alpackagesPresent: GATE_ALPACKAGES.every((d) => existsSync(join(GATE_WORKTREE, d))),
        symbolTar: tar,
      });
      if ("refused" in prep) throw new Error(prep.refused);
      for (const step of prep.steps) await run(step, {}, GATE_WORKTREE);
      await run(
        ["bun", "run", "itest:alrunner-v3"],
        {
          ...env,
          ...(process.env.LETHAL_ITEST_V3_CDO !== undefined
            ? { LETHAL_ITEST_V3_CDO: process.env.LETHAL_ITEST_V3_CDO }
            : {}),
        },
        GATE_WORKTREE,
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
    heavyJobs: async () => {
      let n = 0;
      for (const pid of await readdir("/proc")) {
        if (!/^\d+$/.test(pid)) continue;
        const cmd = (await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).replaceAll(
          "\0",
          " ",
        );
        if (
          /^bun packages\/runner\/itest\/[\w-]+\.itest\.ts|cli\.ts run|^bun scripts\/verify\.ts|\/work\/src\/(BC\.History|DC|DO|do-lethal)/.test(
            cmd,
          )
        )
          n++;
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
  };
}

if (import.meta.main && process.argv.includes("--edge")) {
  console.log(`al-runner-v3-update --edge: ${await edgeOnce(realEdgeDeps())}`);
} else if (import.meta.main) {
  const i = process.argv.indexOf("--regate");
  const regateAt = i >= 0 ? process.argv[i + 1] : undefined;
  if (i >= 0 && (regateAt === undefined || !/^[0-9a-f]{7,40}$/.test(regateAt))) {
    throw new Error("--regate needs a LethAL commit sha");
  }
  const out = await updateOnce(realDeps(), regateAt !== undefined ? { regateAt } : {});
  console.log(`al-runner-v3-update: ${out.join(", ") || "no candidate"}`);
}
