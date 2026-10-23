/**
 * R654: the .NET al-runner (v2, backend kind `"al-runner"`) is retired; the Rust al-runner
 * (`"al-runner-v3"`) replaces it. Every input that still names v2 is refused by the one name
 * `al-runner-v2-retired`, never read as "unknown" and never silently ignored: `--backend al-runner`,
 * a stored v2 run (every lend site), and a v2 SessionReport (explain, campaign freeze, anchors and
 * compare). No back-compat before release (owner, 2026-10-18).
 *
 * NOT here (held by the orchestrator, R654 S3): a config file's `alRunner` section.
 */

/** The retired backend kind, as stored run rows and old reports record it. */
export const RETIRED_V2_BACKEND = "al-runner";

export class AlRunnerV2RetiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlRunnerV2RetiredError";
  }
}

/** F1: `--backend al-runner`. */
export const V2_RETIRED_BACKEND_FLAG =
  "al-runner-v2-retired: the .NET al-runner backend was retired (R654); use --backend al-runner-v3";

/** F3: a stored run of the retired backend. */
export function v2RetiredRun(runId: number): string {
  return `al-runner-v2-retired: run ${runId} ran on the retired .NET al-runner (R654); nothing of it is lent`;
}

/** F3: a SessionReport of the retired backend. `where` names the file, or "the report". */
export function refuseRetiredV2Report(report: unknown, where: string): void {
  if (
    typeof report === "object" &&
    report !== null &&
    (report as { readonly backend?: unknown }).backend === RETIRED_V2_BACKEND
  ) {
    throw new AlRunnerV2RetiredError(
      `al-runner-v2-retired: ${where} is a report of the retired .NET al-runner (R654); it is not read`,
    );
  }
}
