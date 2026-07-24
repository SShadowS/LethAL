export interface SelectorConfig {
  readonly selectorId: number;
  readonly controlId: number;
  readonly tableId: number;
}

// Since Layer 5C-A Task 4 the active-mutant state lives in the `LethAL Control` extension
// (extensions/lethal-control/): it owns the `LC Mutation Active` table, the SetActive/ClearActive
// control surface, and the OData web service. The instrumented target only emits the delegating
// `Mutation Selector` + the register-install/upgrade codeunits below. The former in-target
// `emitMutationActiveTable`/`emitMutationControl`/`emitWebServicesXml` emitters were removed as
// dead code (Layer 5C-A cleanup) — see git history for the historical shape.

/**
 * The instrumented target's `Mutation Selector` — since Layer 5C-A Task 4 a thin DELEGATE into
 * the `LethAL Control` extension. `Active(MutantId)` forwards the full identity tuple
 * `(targetAppId, artifactId, mutantId)` to `LC Control State.IsActive`, which owns the active
 * state (the target no longer holds a `Mutation Active` table or caches anything). The dispatch
 * seam is UNCHANGED — guards still emit `MutationSelector.Active('<id>')` and `compile.ts` still
 * injects `var MutationSelector: Codeunit "Mutation Selector";`; only what `Active` DOES changed.
 *
 * `LC Control State` resolves by unqualified name across the `LethAL Control` app dependency
 * (added to the target's `app.json` — see `project.ts` / orchestrator). No `using LethAL.Control;`
 * directive: the target declares no namespace, so a `using` would be ignored anyway (alc AL0789)
 * — verified live on Cronus281 that the bare reference resolves without it.
 *
 * al-runner never compiles this: `AlRunnerBackend.activate()` overwrites the whole selector file
 * with `emitStaticSelector` (self-contained, no control dependency) before its lazy `alc` run.
 * The procedure set here (`Active`, `ArtifactId`, `TargetAppId`) MUST stay identical to
 * `emitStaticSelector`'s (parity rule — see that emitter's doc comment for why).
 *
 * `TargetAppId()` (Layer 5C-A Task 8) makes this codeunit the SINGLE source of the baked
 * `(targetAppId, artifactId)` identity tuple: `emitRegisterInstall`/`emitRegisterUpgrade` now
 * read both values off this selector instead of taking them as separate string args, so
 * registration can never diverge from the id `Active` presents to the guard.
 */
export function emitMutationSelector(
  cfg: SelectorConfig & { artifactId: string; targetAppId: string },
): string {
  return `codeunit ${cfg.selectorId} "Mutation Selector"
{
    procedure Active(MutantId: Text): Boolean
    var
        ControlState: Codeunit "LC Control State";
    begin
        exit(ControlState.IsActive('${cfg.targetAppId}', '${cfg.artifactId}', MutantId));
    end;

    procedure ArtifactId(): Text
    begin
        exit('${cfg.artifactId}');
    end;

    procedure TargetAppId(): Text
    begin
        exit('${cfg.targetAppId}');
    end;
}
`;
}

/**
 * The instrumented target's install codeunit — registers this target's identity into the
 * `LethAL Control` extension on a FRESH install (OnInstallAppPerCompany fires only then).
 * Identity is read from `Mutation Selector` so registration can NEVER diverge from the id
 * `Active` presents to the guard (design §A). Object id: the freed `controlId`.
 */
export function emitRegisterInstall(cfg: { objectId: number }): string {
  return `codeunit ${cfg.objectId} "Mutation Register"
{
    Subtype = Install;

    trigger OnInstallAppPerCompany()
    var
        State: Codeunit "LC Control State";
        Selector: Codeunit "Mutation Selector";
    begin
        State.RegisterArtifact(Selector.TargetAppId(), Selector.ArtifactId());
    end;
}
`;
}

/**
 * The instrumented target's upgrade codeunit — re-registers identity on every republish
 * (OnUpgradePerCompany fires on a ForceSync republish with an increased version; live-probed
 * 2026-07-22, mem:runmutant_odata). Same identity-from-selector rule as install. Object id:
 * the freed `tableId` (the in-target Mutation Active table is gone).
 */
export function emitRegisterUpgrade(cfg: { objectId: number }): string {
  return `codeunit ${cfg.objectId} "Mutation Upgrade"
{
    Subtype = Upgrade;

    trigger OnUpgradePerCompany()
    var
        State: Codeunit "LC Control State";
        Selector: Codeunit "Mutation Selector";
    begin
        State.RegisterArtifact(Selector.TargetAppId(), Selector.ArtifactId());
    end;
}
`;
}

export function emitStaticSelector(cfg: {
  objectId: number;
  activeId: string;
  artifactId: string;
  targetAppId: string;
}): string {
  const body =
    cfg.activeId === "" ? "        exit(false);" : `        exit(MutantId = '${cfg.activeId}');`;
  // ArtifactId and TargetAppId must be present here too: AlRunnerBackend.activate() replaces
  // the entire generated selector with this output on every activation, so an emitter missing a
  // procedure a caller relies on would break the NEXT compile. This is the parity rule —
  // emitMutationSelector and emitStaticSelector MUST expose the identical procedure set.
  return `codeunit ${cfg.objectId} "Mutation Selector"
{
    procedure Active(MutantId: Text): Boolean
    begin
${body}
    end;

    procedure ArtifactId(): Text
    begin
        exit('${cfg.artifactId}');
    end;

    procedure TargetAppId(): Text
    begin
        exit('${cfg.targetAppId}');
    end;
}
`;
}
