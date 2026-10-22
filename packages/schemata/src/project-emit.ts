import { emitFile } from "./compile-emit";
import type { FilePlan } from "./project-plan";

/**
 * R-307 O6. The EMIT half of `instrumentOneFile`: one file's instrumented text, from its frozen
 * `FilePlan` alone. It reads no node, makes no decision and cannot refuse (see `compile-emit.ts`
 * for the one crash, I4, that EMIT can still raise).
 */
export function emitOneFile(plan: FilePlan): string {
  return emitFile(plan.compile);
}
