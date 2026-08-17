export { assignMutantIds } from "./ids";
export type { IdedSpec } from "./ids";
export {
  emitMutationSelector,
  emitRegisterInstall,
  emitRegisterUpgrade,
  emitStaticSelector,
} from "./selector";
export type { SelectorConfig } from "./selector";
export { wrapStatement } from "./wrap";
export type { WrapInput } from "./wrap";
export { liftExpression } from "./lift";
export type { LiftInput, LiftArtifacts } from "./lift";
export { duplicateEnclosing } from "./duplicate";
export type { DuplicateInput } from "./duplicate";
export {
  CARRIER_KINDS,
  compileSchemataForFile,
  canCarryMutationSelectorVar,
  describeObjectKinds,
} from "./compile";
export {
  writeInstrumentedProject,
  scanDeclaredObjects,
  CONTROL_SELECTOR_FILENAME,
  CONTROL_REGISTER_FILENAME,
  CONTROL_UPGRADE_FILENAME,
  MAX_MUTATION_TEXT,
  clipMutationText,
} from "./project";
export type {
  InstrumentedFile,
  WriteInput,
  MutantManifest,
  MutantManifestEntry,
} from "./project";
export { resolveSite, isMutableSite } from "./enclosing";
export type { ResolvedSite } from "./enclosing";
export { parseIdRanges, pickSelectorIds, validateSelectorIds } from "./id-ranges";
export type { AppIdRange, DeclaredObject } from "./id-ranges";
// R92: exported so `runSession` (packages/runner) can compute the post-dedup "deployed" count
// alongside `generateMutationSet`'s raw site count for `mutation-set-generated` — the same
// per-file dedup `writeInstrumentedProject` runs at compile time (see `dedupeSpecs`'s own doc
// comment for why identity is per-file, not project-wide).
export { dedupeSpecs } from "./dedup";
export type { TierResolver } from "./dedup";
