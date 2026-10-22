/**
 * R664: re-freeze the gift-card demo's `rehearsal` stage on bc-demo, from three runs that agree
 * mutant for mutant, at this build's identity scheme.
 *
 *   bun scripts/gift-card-refreeze.ts [--laptop]
 *
 * `--laptop` (R663b, `docs/talk-laptop.md`): probe `LETHAL_DEMO_HOST` (default localhost) and first
 * refuse by name any tool `lethal run` needs that the checkout lacks (`laptopPreflight`).
 *
 * Run `bun scripts/bc-demo-setup.ts` first: it publishes the apps and writes the gitignored config
 * this script runs with. This script calls only bc-demo (never bc1-bc3), through `lethal run`.
 *
 * In order, refusing at the first failure:
 *   1. probe bc-demo with R663's one unauthenticated GET; no answer, exit 2 with the owner steps;
 *   2. `lethal run` three times, each `--out` into a temp folder OUTSIDE the repo;
 *   3. refuse unless every report is at `IDENTITY_SCHEME` and runs 2 and 3 equal run 1 per mutant
 *      (`compareMutants`, the comparison `campaign compare` uses), never by aggregate counts;
 *   4. BEFORE anything is deleted or written: refuse if the destination would hold AL source and is
 *      not a proven first-party report (`firstPartyVerdict`, the redaction script's own rule), if
 *      run 1 is not the pre-committed 60 mutants, records no coverage mode, or if a demo row named
 *      in `rehearsal.precommit.md` moved;
 *   5. delete `rehearsal.baseline.json` and `campaign freeze` run 1 (the CLAUDE.md re-freeze
 *      procedure); freeze writes the new baseline at the report's identity scheme, and refuses
 *      unless the manifest and `rehearsal.precommit.md` are committed and clean. Then replace
 *      `rehearsal.events.ndjson` with run 1's `--progress-out`;
 *   6. `redact-campaign-report.ts --check` on the archived report. A failure in 5 or 6 prints
 *      `RESTORE` (a `git checkout` of the stage) and exits 1;
 *   7. print the figures, as the runbook's phrases, for the owner to paste after the run.
 *
 * WHERE: the stage is re-frozen IN PLACE, in `docs/campaign/2026-08-16-gift-card/`. The runbook's
 * compare, explain and overlay commands all name that directory, and its report is on the
 * first-party allowlist (`redact-first-party-reports.json`), so it stays unredacted on purpose:
 * `explain` and the overlay need the gift card's own source text. A new dated directory would be a
 * redacted report (useless as the talk's backup) or a new allowlist entry.
 *
 * Nothing is committed. Review `git diff docs/campaign/2026-08-16-gift-card/`, then commit.
 */
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCoverageMode } from "../packages/runner/itest/baseline-guard";
import { compareMutants, normalizeForComparison } from "../packages/runner/itest/mutant-equality";
import { runCampaignFreeze } from "../packages/runner/src/campaign-subcommands";
import { REDACTION_MARKER } from "../packages/runner/src/explain";
import type { SessionReport } from "../packages/runner/src/report";
import { IDENTITY_SCHEME } from "../packages/schemata/src/project";
import { DEMO_PORTS, DEMO_SERVER, HOST } from "./bc-app-content.ts";
import {
  DEFAULT_LAPTOP_HOST,
  DEMO_CONFIG,
  REAL_DEPS as DEMO_DEPS,
  LAPTOP_FLAG,
  type LaptopIo,
  LaptopRefused,
  laptopStartSteps,
  laptopTools,
  ownerSteps,
  probe,
  realIo,
} from "./bc-demo-setup.ts";
import { firstPartyVerdict } from "./redact-campaign-report.ts";

const REPO = join(import.meta.dir, "..");
const RECORDS = join(REPO, "docs", "campaign", "2026-08-16-gift-card");
const STAGE = "rehearsal";
export const FROZEN_REPORT = join(RECORDS, `${STAGE}.report.json`);
/** Pre-committed in `rehearsal.precommit.md`, "Amended 2026-10-22 by R664". Changing it is a new
 *  pre-commitment: amend that file and commit it before the run. */
export const EXPECTED_DEPLOYED = 60;
const RUNS = 3;

export interface RefreezeDeps {
  /** R663's probe: one unauthenticated GET on bc-demo's dev port. */
  readonly reachable: () => Promise<boolean>;
  /** One `lethal run` writing its report to `out` and its events to `events`; resolves its exit code. */
  readonly run: (out: string, events: string) => Promise<number>;
  /** Deletes the stage baseline, `campaign freeze`s `report` to `dest`, and replaces the stage's
   *  committed events stream with `events` (run 1's). */
  readonly freeze: (report: string, events: string) => Promise<void>;
  /** `redact-campaign-report.ts --check` on `path`: true when it passes. */
  readonly redactCheck: (path: string) => Promise<boolean>;
  readonly commit: () => string;
  /** Where the three `--out` reports go; never inside the repo. */
  readonly scratch: string;
  /** Where `freeze` archives the report. */
  readonly dest: string;
  /** R663b laptop mode only: refuses by name when a dependency or the config is missing. */
  readonly preflight?: () => Promise<void>;
  /** R663b laptop mode only: the host the probe used, for the not-up message. */
  readonly laptopHost?: string;
}

/** R663b: laptop mode's preflight. Every tool `lethal run` needs, and setup's config. */
export async function laptopPreflight(io: LaptopIo, controlSha?: string): Promise<void> {
  await laptopTools(io, controlSha);
  if (!io.exists(DEMO_CONFIG))
    throw new LaptopRefused(
      `${DEMO_CONFIG} does not exist: run bun scripts/bc-demo-setup.ts --laptop first (docs/talk-laptop.md)`,
    );
}

export class RefreezeRefused extends Error {}
export class BcDemoUnreachable extends Error {}

/** Unredacted source fields the report would carry at `dest`; 0 when `dest` is proven first-party. */
export function unredactedAt(dest: string, report: SessionReport): number {
  const fp = firstPartyVerdict(dest, report.mutants);
  if (fp !== undefined && fp.foreign.length === 0) return 0;
  return report.mutants
    .flatMap((m) => [m.originalText, m.mutatedText])
    .filter((v) => typeof v === "string" && v !== "" && v !== REDACTION_MARKER).length;
}

/**
 * The rows `rehearsal.precommit.md` says carry the demo. Each must exist and every mutant in it must
 * hold its verdict. Redeem's row covers BOTH its conditional-boundary survivors (the remaining-amount
 * guard the precommit names, and the expiry boundary the runbook's 2:40 beat uses).
 */
const DEMO_ROWS = [
  {
    name: "GetBalance remove-setrange survived",
    proc: "GetBalance",
    op: "lethal.remove-setrange",
    verdict: "survived",
  },
  {
    name: "Redeem conditional-boundary survived",
    proc: "Redeem",
    op: "lethal.conditional-boundary",
    verdict: "survived",
  },
  {
    name: "BlockExpiredCards no-coverage",
    proc: "BlockExpiredCards",
    op: undefined,
    verdict: "no-coverage",
  },
] as const;

/** The demo rows that moved (or vanished) in `r`, by name. */
export function movedDemoRows(r: SessionReport): string[] {
  return DEMO_ROWS.filter((row) => {
    const ms = r.mutants.filter(
      (m) => m.procedureName === row.proc && (row.op === undefined || m.operatorName === row.op),
    );
    return ms.length === 0 || ms.some((m) => m.verdict !== row.verdict);
  }).map((row) => row.name);
}

export const RESTORE = "git checkout -- docs/campaign/2026-08-16-gift-card/";

/** The figures the runbook quotes, from the frozen report, as the runbook's own phrases. */
export function figures(r: SessionReport): string[] {
  const block = r.mutants.filter(
    (m) => m.procedureName === "BlockExpiredCards" && m.verdict === "no-coverage",
  ).length;
  const score = r.mutationScore === null ? "n/a" : `${(r.mutationScore * 100).toFixed(1)}%`;
  const wall = (r.timings.totalMs / 1000).toFixed(1);
  const { killed, survived, noCoverage } = r.counts;
  return [
    `deployed ${r.mutants.length}, killed ${killed}, survived ${survived}, no-coverage ${noCoverage}, score ${score}, wall time ${wall} s`,
    "",
    "--- paste: docs/directions-emea-2026-runbook.md, replace each phrase after a successful run ---",
    `intro:   ${r.mutants.length} mutants, and the last measured run took **${wall} seconds**.`,
    `§4 lead: Times are from the measured ${wall} s run`,
    `§4 0:40: "${killed} killed, ${survived} survived, ${noCoverage} no-coverage.`,
    `§4 2:10: "${block} mutants, no test executed any of them.`,
    `§4 1:00 and the GH-24b note: the planted bug's rank, read off: bun packages/runner/src/cli.ts explain ${FROZEN_REPORT} --top 10`,
    "--- end paste ---",
  ];
}

async function refreeze(deps: RefreezeDeps, print: (s: string) => void): Promise<void> {
  if (deps.preflight !== undefined) await deps.preflight();
  if (!(await deps.reachable())) {
    throw new BcDemoUnreachable(
      deps.laptopHost === undefined
        ? `bc-demo-unreachable: ${DEMO_SERVER} does not answer on ${HOST}:${DEMO_PORTS.dev}; nothing was run. Only the owner can start it:\n${ownerSteps().join("\n")}`
        : `bc-demo-unreachable: ${DEMO_SERVER} does not answer on ${deps.laptopHost}:${DEMO_PORTS.dev}; nothing was run.\n${laptopStartSteps(deps.laptopHost).join("\n")}`,
    );
  }
  print(`commit ${deps.commit()}`);
  const reports: SessionReport[] = [];
  const paths: string[] = [];
  for (let i = 1; i <= RUNS; i++) {
    const out = join(deps.scratch, `run-${i}.report.json`);
    const code = await deps.run(out, join(deps.scratch, `run-${i}.events.ndjson`));
    if (code !== 0) throw new RefreezeRefused(`run ${i} exited ${code}; nothing was frozen`);
    const r = JSON.parse(readFileSync(out, "utf8")) as SessionReport;
    if (r.identityScheme !== IDENTITY_SCHEME) {
      throw new RefreezeRefused(
        `run ${i} is at identity scheme ${r.identityScheme ?? "unrecorded"}, not ${IDENTITY_SCHEME}: a baseline frozen from it would compare UNVERIFIED. Nothing was frozen.`,
      );
    }
    print(`run ${i}: ${r.mutants.length} mutants, ${(r.timings.totalMs / 1000).toFixed(1)} s`);
    reports.push(r);
    paths.push(out);
  }
  const [first, ...rest] = reports;
  const [firstPath] = paths;
  if (first === undefined || firstPath === undefined) throw new Error("no runs");
  const eventsPath = join(deps.scratch, "run-1.events.ndjson");
  for (const [i, r] of rest.entries()) {
    const { differences } = compareMutants(
      normalizeForComparison(first),
      normalizeForComparison(r),
      { sameScheme: true },
    );
    if (differences.length > 0) {
      throw new RefreezeRefused(
        `run ${i + 2} differs from run 1 in ${differences.length} mutant(s); nothing was frozen:\n${differences.map((d) => `  - ${d}`).join("\n")}`,
      );
    }
  }
  // Everything checkable is checked before `freeze` deletes the committed baseline.
  const source = unredactedAt(deps.dest, first);
  if (source > 0) {
    throw new RefreezeRefused(
      `${deps.dest} is not a proven first-party report, and the report carries ${source} unredacted source field(s); nothing was written there`,
    );
  }
  if (first.mutants.length !== EXPECTED_DEPLOYED) {
    throw new RefreezeRefused(
      `run 1 deployed ${first.mutants.length} mutants, not the pre-committed ${EXPECTED_DEPLOYED}; nothing was frozen`,
    );
  }
  if (!isCoverageMode(first.coverageMode)) {
    throw new RefreezeRefused(
      `run 1 records no coverageMode (got ${JSON.stringify(first.coverageMode)}); nothing was frozen`,
    );
  }
  const moved = movedDemoRows(first);
  if (moved.length > 0) {
    throw new RefreezeRefused(
      `demo row(s) moved: ${moved.join("; ")}. rehearsal.precommit.md says these carry the demo; nothing was frozen`,
    );
  }
  try {
    await deps.freeze(firstPath, eventsPath);
    if (!(await deps.redactCheck(deps.dest))) {
      throw new RefreezeRefused(
        `redact-campaign-report.ts --check failed on ${deps.dest}: do NOT commit it`,
      );
    }
  } catch (err) {
    throw new RefreezeRefused(
      `${err instanceof Error ? err.message : String(err)}\nThe stage may be half-written. Restore the committed one with:\n  ${RESTORE}`,
    );
  }
  print(`frozen: ${deps.dest} and its baseline; runs 1-${RUNS} agree per mutant`);
  for (const line of figures(first)) print(line);
}

export async function main(deps: RefreezeDeps, print = console.log): Promise<number> {
  try {
    await refreeze(deps, print);
    return 0;
  } catch (err) {
    print(`REFUSED: ${err instanceof Error ? err.message : String(err)}`);
    return err instanceof BcDemoUnreachable ? 2 : 1;
  }
}

const spawn = async (cmd: string[]): Promise<number> =>
  await Bun.spawn(cmd, { cwd: REPO, stdout: "inherit", stderr: "inherit" }).exited;

if (import.meta.main) {
  const scratch = mkdtempSync(join(tmpdir(), "gift-card-refreeze-"));
  const cli = join(REPO, "packages", "runner", "src", "cli.ts");
  // R663b: `--laptop` (docs/talk-laptop.md). Without it, nothing below changes.
  const io = realIo();
  const laptopHost = process.argv.includes(LAPTOP_FLAG)
    ? (io.env.LETHAL_DEMO_HOST ?? DEFAULT_LAPTOP_HOST)
    : undefined;
  process.exit(
    await main({
      ...(laptopHost !== undefined ? { laptopHost, preflight: () => laptopPreflight(io) } : {}),
      reachable: laptopHost !== undefined ? () => probe(laptopHost) : DEMO_DEPS.reachable,
      run: (out, events) =>
        spawn([
          "bun",
          cli,
          "run",
          "--project",
          join(REPO, "examples", "gift-card"),
          "--tests",
          join(REPO, "examples", "gift-card-tests"),
          "--backend",
          "bcdev",
          "--config",
          DEMO_CONFIG,
          "--out",
          out,
          "--progress-out",
          events,
        ]),
      freeze: async (report, events) => {
        rmSync(join(RECORDS, `${STAGE}.baseline.json`), { force: true });
        await runCampaignFreeze({
          manifestPath: join(RECORDS, "campaign.json"),
          stage: STAGE,
          reportPath: report,
          expectedMutantCount: EXPECTED_DEPLOYED,
        });
        // `campaign freeze` does not touch the events stream; schemas.test.ts validates the
        // committed one line by line, so it is replaced with the frozen run's, never deleted.
        copyFileSync(events, join(RECORDS, `${STAGE}.events.ndjson`));
      },
      redactCheck: async (path) =>
        (await spawn([
          "bun",
          join(REPO, "scripts", "redact-campaign-report.ts"),
          "--check",
          path,
        ])) === 0,
      // `-dirty` marks a tree that is not the commit it names.
      commit: () =>
        Bun.spawnSync(["git", "describe", "--always", "--dirty", "--abbrev=40", "--exclude=*"], {
          cwd: REPO,
        })
          .stdout.toString()
          .trim(),
      scratch,
      dest: FROZEN_REPORT,
    }),
  );
}
