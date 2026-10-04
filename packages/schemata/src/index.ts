export { assignMutantIds } from "./ids";
export type { IdedSpec } from "./ids";
export {
  emitMutationSelector,
  emitRegisterInstall,
  emitRegisterUpgrade,
  emitResourceSelector,
  emitStaticSelector,
  SELECTOR_RESOURCE_FOLDER,
  SELECTOR_RESOURCE_NAME,
  SELECTOR_RESOURCE_NONE,
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
  identityTupleOf,
  instrumentOneFile,
  looseIdentityTupleOf,
  assignIdentityOrdinals,
  identitySiteKey,
  identityFieldsOf,
  identityEntriesOf,
  numberIdentityOrdinals,
  runIdentityOrdinals,
  withRunIdentityOrdinals,
  IDENTITY_SCHEME,
  gapIdOf,
  coverageArmNamesComputed,
} from "./project";
export type {
  InstrumentedFile,
  WriteInput,
  IdentityEntry,
  MutantManifest,
  MutantManifestEntry,
} from "./project";
export {
  REACH_MARKER,
  planReachGrains,
  reachGrainOf,
  reachLatchRefusedOwner,
  varSectionUnparsed,
} from "./dispatch";
export type { ReachGrain } from "./dispatch";
export { resolveSite, resolveStatement, isMutableSite } from "./enclosing";
// R-307 O6: the trial runs PLAN only (`planOneFile`); `emitOneFile` is exported so a test can pin
// that the trial never calls it.
export { planOneFile } from "./project-plan";
export type { FilePlan, PlannedMutant } from "./project-plan";
export { emitOneFile } from "./project-emit";
export type { ResolvedSite } from "./enclosing";
export { parseIdRanges, pickSelectorIds, validateSelectorIds } from "./id-ranges";
export type { AppIdRange, DeclaredObject } from "./id-ranges";
// R92: exported so `runSession` (packages/runner) can compute the post-dedup "deployed" count
// alongside `generateMutationSet`'s raw site count for `mutation-set-generated` — the same
// per-file dedup `writeInstrumentedProject` runs at compile time (see `dedupeSpecs`'s own doc
// comment for why identity is per-file, not project-wide).
export { dedupeSpecs } from "./dedup";
export type { TierResolver } from "./dedup";
