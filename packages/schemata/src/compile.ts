import type { ALSyntaxNode, MutationSpec } from "@lethal/engine";
import { emitFile } from "./compile-emit";
import { planFile } from "./compile-plan";
import type { IdedSpec } from "./ids";

export {
  CARRIER_KINDS,
  canCarryMutationSelectorVar,
  describeObjectKinds,
  latchAnchorInVarSection,
} from "./compile-plan";

/**
 * R-307 O5: a composition. PLAN (`planFile`: every decision and every throw) then EMIT (`emitFile`:
 * the text, from the frozen plan alone). It holds no instrumentation logic of its own.
 */
export function compileSchemataForFile(
  source: string,
  root: ALSyntaxNode,
  specs: readonly MutationSpec[],
  ided?: readonly IdedSpec[],
  /** Target file path, used only to name the file in a refusal. Single-file callers (tests) may
   *  omit it. */
  filePath?: string,
): string {
  return emitFile(planFile(source, root, specs, ided, filePath));
}
