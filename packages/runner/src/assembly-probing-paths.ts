import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * R900: the folders alc searches for the .NET assemblies a `dotnet { assembly(...) }` declaration,
 * or a dependency's symbols, name (alc's `/assemblyprobingpaths:`). Without them such a project
 * compiles in VS Code and fails every LethAL compile with AL0451 and AL0185.
 *
 * Resolution, the first source present wins (never merged):
 * 1. the LethAL config's top-level `assemblyProbingPaths`;
 * 2. the project's `.vscode/settings.json` `al.assemblyProbingPaths` (the AL extension's setting,
 *    read as JSON with comments). User settings and `.code-workspace` files are not read: they are
 *    not part of the project, so a run could not be reproduced from it;
 * 3. the extension's default `./.netpackages`, only when that folder exists;
 * 4. none: no `/assemblyprobingpaths:` at all, so alc's command line is what it was before R900.
 *
 * Relative entries resolve against the PROJECT folder (as the extension does), so they still point
 * at the right place when alc compiles LethAL's staged copy somewhere else.
 */

export type AssemblyProbingSource = "config" | "vscode-settings" | "default" | "none";

export interface ResolvedAssemblyProbingPaths {
  /** Absolute, forward slashes, in the order given (alc searches them in order). */
  readonly paths: readonly string[];
  readonly source: AssemblyProbingSource;
}

/** A listed probing folder that does not exist or is not a folder. */
export class AssemblyProbingPathMissingError extends Error {
  constructor(entry: string, absolute: string, where: string) {
    super(
      `${where}: assembly probing path ${JSON.stringify(entry)} (${absolute}) does not exist or is not a folder. alc would ignore it and fail later with AL0451 or AL0185 on each DotNet type it should hold. Fix the path, or remove it from the list (R900).`,
    );
    this.name = "AssemblyProbingPathMissingError";
  }
}

/**
 * A probing folder whose path holds `,` or `;`. alc splits `/assemblyprobingpaths:` on BOTH
 * (measured 2026-11-10 with alc 18.0 on Linux: two folders joined by either compiled, one folder
 * alone did not), so such a path would reach alc as two paths nobody wrote.
 */
export class AssemblyProbingPathSeparatorError extends Error {
  constructor(entry: string, where: string) {
    super(
      `${where}: assembly probing path ${JSON.stringify(entry)} contains "," or ";", which alc reads as a list separator in /assemblyprobingpaths:. Move or link the folder to a path without them (R900).`,
    );
    this.name = "AssemblyProbingPathSeparatorError";
  }
}

const SEPARATOR_RE = /[,;]/;

/** The `.vscode/settings.json` key the AL extension reads. */
export const VSCODE_SETTINGS_KEY = "al.assemblyProbingPaths";

function stringList(raw: unknown, where: string, allowEmpty: boolean): readonly string[] {
  if (
    !Array.isArray(raw) ||
    raw.some((e) => typeof e !== "string" || e.trim() === "") ||
    (!allowEmpty && raw.length === 0)
  ) {
    throw new Error(
      `${where} must be ${allowEmpty ? "an" : "a non-empty"} array of non-empty folder paths, got ${JSON.stringify(raw)} (R900)`,
    );
  }
  return raw as string[];
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function absolutePaths(
  projectDir: string,
  entries: readonly string[],
  where: string,
): Promise<readonly string[]> {
  const out: string[] = [];
  for (const entry of entries) {
    if (SEPARATOR_RE.test(entry)) throw new AssemblyProbingPathSeparatorError(entry, where);
    const abs = resolve(projectDir, entry).replaceAll("\\", "/");
    if (!(await isDirectory(abs))) throw new AssemblyProbingPathMissingError(entry, abs, where);
    out.push(abs);
  }
  return out;
}

/**
 * Resolves the list for a project. `configValue` is the LethAL config's raw `assemblyProbingPaths`
 * (`undefined` when the key is absent); `configLabel` names that file in messages.
 */
export async function resolveAssemblyProbingPaths(
  projectDir: string,
  configValue: unknown,
  configLabel = "lethal.config.json",
): Promise<ResolvedAssemblyProbingPaths> {
  if (configValue !== undefined) {
    const where = `${configLabel} "assemblyProbingPaths"`;
    const entries = stringList(configValue, where, false);
    return { paths: await absolutePaths(projectDir, entries, where), source: "config" };
  }
  const settingsPath = join(projectDir, ".vscode", "settings.json");
  const settingsFile = Bun.file(settingsPath);
  if (await settingsFile.exists()) {
    let settings: unknown;
    try {
      // VS Code settings are JSON with comments and trailing commas.
      settings = Bun.JSONC.parse(await settingsFile.text());
    } catch (err) {
      throw new Error(
        `${settingsPath} is not readable JSON with comments, so LethAL cannot tell whether it sets "${VSCODE_SETTINGS_KEY}": ${err instanceof Error ? err.message : String(err)} (R900)`,
      );
    }
    const raw =
      settings !== null && typeof settings === "object"
        ? (settings as Record<string, unknown>)[VSCODE_SETTINGS_KEY]
        : undefined;
    if (raw !== undefined) {
      const where = `${settingsPath} "${VSCODE_SETTINGS_KEY}"`;
      // An empty list there is the user saying "none", as VS Code reads it.
      const entries = stringList(raw, where, true);
      return { paths: await absolutePaths(projectDir, entries, where), source: "vscode-settings" };
    }
  }
  const netpackages = resolve(projectDir, ".netpackages").replaceAll("\\", "/");
  if (await isDirectory(netpackages)) {
    if (SEPARATOR_RE.test(netpackages)) {
      throw new AssemblyProbingPathSeparatorError(netpackages, "the default ./.netpackages");
    }
    return { paths: [netpackages], source: "default" };
  }
  return { paths: [], source: "none" };
}

/** One line for stderr and doctor: the list and where it came from. */
export function describeAssemblyProbingPaths(r: ResolvedAssemblyProbingPaths): string {
  if (r.paths.length === 0) {
    return r.source === "none"
      ? "none (no assemblyProbingPaths in the config, no al.assemblyProbingPaths in .vscode/settings.json, no ./.netpackages folder)"
      : `none (${r.source} lists an empty array)`;
  }
  return `${r.paths.join(", ")} (from ${r.source})`;
}

/**
 * The line `AlcCompileError` gains when alc reports AL0451 (an assembly not found in the probing
 * paths): which paths were passed, and where LethAL reads them.
 */
export function al0451Note(paths: readonly string[]): string {
  const passed =
    paths.length === 0
      ? "LethAL passed alc no assembly probing paths"
      : `LethAL passed alc these assembly probing paths: ${paths.join(", ")}`;
  return `AL0451: ${passed}. LethAL reads them from "assemblyProbingPaths" in the LethAL config, else "${VSCODE_SETTINGS_KEY}" in the project's .vscode/settings.json, else ./.netpackages when it exists; list the folders that hold the missing assemblies (R900).`;
}
