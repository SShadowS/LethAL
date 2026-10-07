import { createHash } from "node:crypto";

/**
 * R219: the name a project `.al` file takes in a batch directory, and the way back.
 *
 * Batch directories are written FLAT (`docs/measurements/README.md`, "al-runner v2"), so a file is
 * named by its basename. Two project files can share a basename in different directories (Continia
 * Document Capture: `UserControls/Label/ScannerUI.al` and `UserControls/ScannerUI/ScannerUI.al`),
 * and one would overwrite the other. Such a DUPLICATE (case-insensitive, as Windows and `alc` see
 * it) is named `<stem>.<8 hex>.al` instead, where the hex is the start of the sha256 of its
 * project-relative directory, normalised to `/` with its case kept, so Windows and Linux give one
 * name. A unique basename is unchanged. Neither `alc` nor al-runner cares what a file is called,
 * only what it declares.
 *
 * Every writer and every reader of a flat name goes through ONE instance built over the whole
 * project's `.al` list: a name computed over a subset could differ from the one another writer
 * used for the same file.
 */
export interface FlatNames {
  /** The flat file name of a project-relative path (either separator). Throws on a path the
   *  map was not built over: a name invented here could collide unseen. */
  flatOf(projectPath: string): string;
  /** The project-relative path (forward slashes, as given) a flat name stands for, or
   *  `undefined` when the name is not one of the project's files (LethAL's own scaffolding).
   *  A path is read by its last segment, so a reporter's absolute path to the file resolves. */
  projectPathOf(flatName: string): string | undefined;
  /** Only the files given a disambiguated name: flat name -> project-relative path. Empty when
   *  every basename is unique, which is every project LethAL measured before R219. */
  readonly renamed: ReadonlyMap<string, string>;
}

/**
 * R219: the batch directory's record of `FlatNames.renamed`, written only when it is non-empty,
 * so a batch without duplicates is byte-identical to before. Readers that QUOTE a file of the batch
 * directory to a user (coverage and line-map refusals, alc's own diagnostics) translate through it.
 * Not `.al`, so neither `alc` nor al-runner reads it.
 */
export const FLAT_NAMES_FILENAME = "lethal-flat-names.json";

/** `FLAT_NAMES_FILENAME`'s content for `renamed`, or `undefined` when there is nothing to record. */
export function flatNamesSidecar(renamed: ReadonlyMap<string, string>): string | undefined {
  if (renamed.size === 0) return undefined;
  return `${JSON.stringify(Object.fromEntries([...renamed].sort(([a], [b]) => (a < b ? -1 : 1))), null, 2)}\n`;
}

/**
 * The reverse map read from a batch directory's sidecar text (`undefined`: none written), as a
 * function that names a quoted batch file the way the user knows it: `<project path>` for a
 * renamed file, the path unchanged otherwise. Throws on a sidecar that is not a string map: a
 * corrupt record must not quietly name the wrong file.
 */
export function displayPathsOf(sidecar: string | undefined): (batchPath: string) => string {
  if (sidecar === undefined) return (p) => p;
  const parsed: unknown = JSON.parse(sidecar);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${FLAT_NAMES_FILENAME} is not an object`);
  }
  const map = new Map<string, string>();
  for (const [flat, project] of Object.entries(parsed)) {
    if (typeof project !== "string")
      throw new Error(`${FLAT_NAMES_FILENAME}: "${flat}" is not a path`);
    map.set(flat.toLowerCase(), project);
  }
  return (p) => map.get(splitPath(p).base.toLowerCase()) ?? p;
}

const norm = (p: string): string => p.replaceAll("\\", "/");

function splitPath(p: string): { dir: string; base: string } {
  const n = norm(p);
  const i = n.lastIndexOf("/");
  return i < 0 ? { dir: "", base: n } : { dir: n.slice(0, i), base: n.slice(i + 1) };
}

/** `<stem>.<8 hex of dir>.<ext>`; a name without an extension gets the hex appended. */
function disambiguated(dir: string, base: string): string {
  const hex = createHash("sha256").update(dir).digest("hex").slice(0, 8);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? `${base}.${hex}` : `${base.slice(0, dot)}.${hex}${base.slice(dot)}`;
}

export function flatNamesFor(projectPaths: readonly string[]): FlatNames {
  const byBase = new Map<string, string[]>();
  for (const p of new Set(projectPaths.map(norm))) {
    const key = splitPath(p).base.toLowerCase();
    const group = byBase.get(key);
    if (group === undefined) byBase.set(key, [p]);
    else group.push(p);
  }
  const flatByPath = new Map<string, string>();
  const pathByFlat = new Map<string, string>();
  const renamed = new Map<string, string>();
  for (const group of byBase.values()) {
    for (const p of group) {
      const { dir, base } = splitPath(p);
      const flat = group.length === 1 ? base : disambiguated(dir, base);
      const taken = pathByFlat.get(flat.toLowerCase());
      // Unreachable unless two directories share a hash prefix, or a project already holds a file
      // with the generated name. Refused: one file would overwrite the other, and its AL objects
      // would be missing from the built app without a word.
      if (taken !== undefined) {
        throw new Error(
          `cannot build the batch project: "${taken}" and "${p}" would both be written as "${flat}" in the flat batch directory, so one would silently replace the other and its AL objects would be missing from the published app. Rename one of them.`,
        );
      }
      pathByFlat.set(flat.toLowerCase(), p);
      flatByPath.set(p, flat);
      if (group.length > 1) renamed.set(flat, p);
    }
  }
  return {
    renamed,
    flatOf(projectPath) {
      const flat = flatByPath.get(norm(projectPath));
      if (flat === undefined) {
        throw new Error(
          `flatNamesFor: "${projectPath}" is not one of the ${flatByPath.size} project file(s) the flat names were built over`,
        );
      }
      return flat;
    },
    projectPathOf(flatName) {
      return pathByFlat.get(splitPath(flatName).base.toLowerCase());
    },
  };
}
