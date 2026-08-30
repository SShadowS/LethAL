// NOT `mutation-testing-report-schema/src-generated/schema`: pre-flight verified that specifier
// resolved, but only via Bun's runtime check, which erases a type-only `import type` before ever
// resolving the module. `tsc` rejects it (TS2307) because the package's own `exports` map in
// package.json publishes that same generated file only under `./api`, not `./src-generated/schema`.
import type { MutantStatus } from "mutation-testing-report-schema/api";
import type { MutantErrorCause } from "./report";
import type { MutantVerdict } from "./store";

/**
 * Map a LethAL `MutantVerdict` onto the standard mutation-testing-report-schema's `MutantStatus`,
 * so a LethAL run renders in the off-the-shelf HTML viewer StrykerJS and Stryker.NET also target.
 *
 * `known-survivor` maps to `Survived`, not `Pending`: `Survived` is what was MEASURED (a prior run
 * recorded the mutant surviving), and `Pending` would falsely claim the mutant is still queued.
 * That it was carried rather than re-run in THIS run belongs in `statusReason`, not in `status`.
 */
export function statusOf(o: {
  verdict: MutantVerdict;
  cause?: MutantErrorCause;
  compileCulprit?: boolean;
}): MutantStatus {
  const { verdict, cause, compileCulprit } = o;
  switch (verdict) {
    case "killed":
      return "Killed";
    case "survived":
      return "Survived";
    case "no-coverage":
      return "NoCoverage";
    case "timeout-killed":
      return "Timeout";
    case "known-survivor":
      return "Survived";
    case "error":
      if (compileCulprit === true) {
        return "CompileError";
      }
      // Every MutantErrorCause reads as RuntimeError: the schema has no cause-specific error
      // status, and `cause` (or the absence of a compile culprit) belongs in statusReason.
      return "RuntimeError";
    default:
      throw new Error(
        `unmapped verdict ${JSON.stringify(verdict)}: the standard report schema needs an explicit MutantStatus for every MutantVerdict. Add one here rather than letting it default.`,
      );
  }
}
