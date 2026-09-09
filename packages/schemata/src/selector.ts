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

/** The resource file `emitResourceSelector` reads, relative to the declared resource folder. */
export const SELECTOR_RESOURCE_NAME = "active-mutant.txt";

/** The folder added to the instrumented app's `resourceFolders` to hold that file. */
export const SELECTOR_RESOURCE_FOLDER = "LethALResources";

/** Written to the resource file for the BASELINE, where no mutant is active. */
export const SELECTOR_RESOURCE_NONE = "NONE";

/**
 * R222 — a selector that reads the active mutant from a RESOURCE FILE at runtime, so the bundle is
 * compiled ONCE and each further mutant costs a test run instead of a compile.
 *
 * ## Why this can work at all
 *
 * al-runner reads a source-backed resource with `File.ReadAllBytes` on EVERY AL read, memoising
 * only the folder list (`AlRunner/Patches/NavAppResourcePatches.cs`), and its output-cache key
 * enumerates `"*.al"` plus a manifest fragment and the dependency list, so resource CONTENTS never
 * enter it (`AlRunner/ProgramSupport/Dependencies.cs`). Rewriting the file therefore changes what
 * compiled AL sees while the compile stays a cache HIT.
 *
 * MEASURED end to end before this was written, on one warm server with every `.al` byte-identical
 * and only the text file changing:
 *
 * ```text
 *   resource M0001 -> pass, cached=false, 8.8 s   (the one compile)
 *   resource M0002 -> FAIL, cached=true,  0.1 s
 *   resource M0001 -> pass, cached=true,  0.1 s
 * ```
 *
 * Against `emitStaticSelector`, which bakes the id in as a constant and costs a recompile per
 * mutant: 12.5 s cold and 0.4 s warm-incremental on a two-file fixture, and 65 s per invocation on
 * a 553-file application.
 *
 * ## Why `SingleInstance` and the lazy load are not incidental
 *
 * `Active()` is called at EVERY mutated site, so a naive implementation does filesystem I/O per
 * guard. `SingleInstance` plus a `Loaded` flag makes it one read per instance lifetime; al-runner
 * clears SingleInstance state at its isolation resets, so the value is re-read after each reset and
 * cannot go stale WITHIN a request, while a request only ever scores one mutant anyway.
 *
 * ## The parity rule
 *
 * `emitMutationSelector`, `emitStaticSelector` and this MUST expose an identical procedure set:
 * a caller swapping one for another must not lose a procedure the instrumented AL calls.
 */
export function emitResourceSelector(cfg: {
  objectId: number;
  artifactId: string;
  targetAppId: string;
}): string {
  return `codeunit ${cfg.objectId} "Mutation Selector"
{
    SingleInstance = true;

    var
        Loaded: Boolean;
        ActiveId: Text;

    procedure Active(MutantId: Text): Boolean
    begin
        if not Loaded then begin
            ActiveId := NavApp.GetResourceAsText('${SELECTOR_RESOURCE_NAME}', TextEncoding::UTF8);
            Loaded := true;
        end;
        exit(MutantId = ActiveId);
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
