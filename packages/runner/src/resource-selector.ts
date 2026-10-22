/**
 * R222's resource selector install and R583's runtime rule for it, shared by the .NET al-runner
 * (`selectorMode: "resource"`), the CLI, and al-runner v3's serve-entries transport (R635). Moved
 * unchanged out of `al-runner-backend.ts` by R654 S1 (plan
 * `docs/superpowers/plans/2026-10-22-r654-retire-dotnet-alrunner.md`).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  SELECTOR_RESOURCE_FOLDER,
  SELECTOR_RESOURCE_NAME,
  SELECTOR_RESOURCE_NONE,
  emitResourceSelector,
} from "@lethal/schemata";

/** R583: the target's `app.json` `runtime` cannot carry the resource selector (below 14.0). */
export class ResourceSelectorRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceSelectorRuntimeError";
  }
}

/**
 * R583: `true` when `runtime` is a readable major.minor below 14.0, or unreadable; `false` at 14.0
 * or above, and when absent (al-runner then compiles at its newest runtime, measured on 069cbf32
 * only). Compared as numbers: as strings "9.0" sorts above "14.0".
 */
export function runtimeBelow14(runtime: unknown): boolean {
  if (runtime === undefined) return false;
  const m = typeof runtime === "string" ? /^(\d+)\.(\d+)$/.exec(runtime.trim()) : null;
  if (m === null) return true;
  return Number(m[1]) < 14;
}

/**
 * R583: refuses the resource selector on a target whose `runtime` is below 14.0. Its selector
 * calls `NavApp.GetResourceAsText`, which alc refuses there (AL0666), and so does al-runner from
 * f23b9b5f on, which compiles at the app's own runtime. No fallback before LethAL's release (R584).
 * Called by the CLI before anything is instrumented, and by `deploy()` on `active/app.json`.
 */
export function assertResourceSelectorRuntime(
  appJson: Readonly<Record<string, unknown>>,
  selectorMode: "static" | "resource",
): void {
  if (selectorMode !== "resource" || !runtimeBelow14(appJson.runtime)) return;
  const shown =
    typeof appJson.runtime === "string" ? appJson.runtime : JSON.stringify(appJson.runtime);
  throw new ResourceSelectorRuntimeError(
    `runtime ${shown} is below 14.0, which the resource selector needs (NavApp.GetResourceAsText, AL0666); set app.json runtime ≥ 17.0 or alRunner.selectorMode static`,
  );
}

/**
 * R222's resource selector install, shared by v2 (`selectorMode: "resource"`) and R635's v3
 * serve-entries transport: declare `LethALResources` in `active/app.json`, seed
 * `active-mutant.txt` with `NONE`, and write the resource-reading selector. v2's bytes unchanged.
 */
export async function installResourceSelector(
  activeDir: string,
  selectorObjectId: number,
  artifactId: string,
): Promise<void> {
  const manifestPath = join(activeDir, "app.json");
  const raw = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(raw) as { resourceFolders?: string[] };
  const folders = Array.isArray(manifest.resourceFolders) ? manifest.resourceFolders : [];
  if (!folders.includes(SELECTOR_RESOURCE_FOLDER)) {
    manifest.resourceFolders = [...folders, SELECTOR_RESOURCE_FOLDER];
    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}
`,
      "utf8",
    );
  }
  await mkdir(join(activeDir, SELECTOR_RESOURCE_FOLDER), { recursive: true });
  // Seeded with the baseline value: the first compile reads the resource, and a missing file
  // would fail that read rather than the run starting at "no mutant active".
  await writeFile(
    join(activeDir, SELECTOR_RESOURCE_FOLDER, SELECTOR_RESOURCE_NAME),
    SELECTOR_RESOURCE_NONE,
    "utf8",
  );
  await writeFile(
    join(activeDir, "MutationSelector.Codeunit.al"),
    emitResourceSelector({ objectId: selectorObjectId, artifactId, targetAppId: "" }),
    "utf8",
  );
}
