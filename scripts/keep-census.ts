#!/usr/bin/env bun
/**
 * PR-54: a keep census. For each class of al-runner refusal, is a `serve` daemon still clean after the refused test?
 * "Clean" means a reader test that runs next sees what it sees after a plain passing setter, on every round.
 *
 *   bun scripts/keep-census.ts --family <name> --out <dir> [--bin <al-runner>] [--refusers <n>]
 *   bun scripts/keep-census.ts --repros --out <dir> [--bin <al-runner>] [--refusers <n>]
 *
 * PR-93: `--refusers <n>` (default 3) is how many refusers per class are measured, different full texts first. Raise it so
 * every distinct text of a class with more texts is a measured refuser (a keep entry covers measured texts only).
 *
 * Run it under `scripts/heavy-slot.sh --wait --peak serve other`. Invented AL only: every family cell and upstream repro is
 * invented. R-967's kit (state, setter and reader, ids 50940-50999) is added to each app, and each family cell starts with the
 * standard writes. The method is PR-53's `serve-refusals.ts`, per class: a kept daemon (cold reader, setter then reader = the
 * control, then per refuser 3 rounds of [refuser, reader] and 1 request holding both), then 3 fresh daemons per refuser.
 */
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isV3RefusalText } from "../packages/runner/src/al-runner-rows";
import { mergeChildEnv, v3ChildEnv } from "../packages/runner/src/al-runner-v3-seed";
import {
  type Cell,
  type CellResult,
  FAMILIES,
  type Family,
  REFUSAL_FAMILY_BC_VERSION,
  classOf,
  classify,
  emitApp,
  refusalText,
} from "./refusal-family";
import { REPRO_ROOT, type Repro, readManifest, rowsOf } from "./upstream-repros";

export const KIT_FROM = 50940;
export const KIT_TO = 50999;
export const KIT_SETTER = 50941;
export const KIT_READER = 50942;
export const WRITES = "State.DoWrites();";
export const STATE_VAR = 'State: Codeunit "R937 State";';

/** R-967's kit, invented. `Observe` reads the state a refused test could have left (GlobalLanguage included). */
export const KIT_AL = `// PR-54 census kit (from R-937 / R-967). Invented, no corpus source text.
dotnet
{
    assembly("mscorlib")
    {
        type("System.Text.StringBuilder"; R937SB) { }
        type("System.IO.MemoryStream"; R937MS) { }
        type("System.Convert"; R937Conv) { }
        type("System.Environment"; R937Env) { }
    }
}

table 50940 "R937 Row"
{
    fields
    {
        field(1; "Key"; Code[20]) { }
        field(2; Value; Integer) { }
    }
    keys
    {
        key(PK; "Key") { Clustered = true; }
    }
}

codeunit 50940 "R937 State"
{
    SingleInstance = true;

    var
        Txt: Text;
        SB: DotNet R937SB;

    procedure DoWrites()
    var
        Row: Record "R937 Row";
    begin
        Row.Init();
        Row."Key" := 'K' + Format(Row.Count() + 1);
        Row.Value := 7;
        Row.Insert();
        Txt := 'set-by-test';
        SB := SB.StringBuilder();
        SB.Append('sb-text');
        IsolatedStorage.Set('R937KEY', 'v1', DataScope::Module);
        if not NumberSequence.Exists('R937SEQ') then
            NumberSequence.Insert('R937SEQ');
        WorkDate(DMY2Date(2, 3, 2031));
    end;

    procedure Observe(): Text
    var
        Row: Record "R937 Row";
        Env: DotNet R937Env;
        MS: DotNet R937MS;
        Conv: DotNet R937Conv;
        SBText: Text;
        IsoVal: Text;
        B64: Text;
    begin
        if IsNull(SB) then
            SBText := 'null'
        else
            SBText := 'obj:' + SB.ToString();
        if IsolatedStorage.Contains('R937KEY', DataScope::Module) then
            IsoVal := 'present'
        else
            IsoVal := 'absent';
        MS := MS.MemoryStream();
        MS.WriteByte(65);
        MS.WriteByte(66);
        B64 := Conv.ToBase64String(MS.ToArray());
        exit(
            'OBS rows=' + Format(Row.Count()) +
            ' txt=[' + Txt + ']' +
            ' sb=[' + SBText + ']' +
            ' iso=' + IsoVal +
            ' seq=' + Format(NumberSequence.Exists('R937SEQ')) +
            ' workdate=' + Format(WorkDate(), 0, 9) +
            ' env=[' + Env.GetEnvironmentVariable('R937PROBE') + ']' +
            ' lang=' + Format(GlobalLanguage()) +
            ' dotnet=[len=' + Format(MS.Length()) + ' b64=' + B64 + ']');
    end;
}

codeunit 50941 "R937 Setter"
{
    Subtype = Test;

    var
        State: Codeunit "R937 State";

    [Test]
    procedure Sets()
    begin
        State.DoWrites();
    end;
}

codeunit 50942 "R937 Reader"
{
    Subtype = Test;

    var
        State: Codeunit "R937 State";

    [Test]
    procedure Reads()
    begin
        Error(State.Observe());
    end;
}
`;

/** The family with the kit's objects beside its own and the standard writes first in every cell. */
export function withKit(f: Family): Family {
  const cells: Cell[] = f.cells.map((c) => ({
    ...c,
    vars: [STATE_VAR, ...(c.vars ?? [])],
    setup: [WRITES, ...(c.setup ?? [])],
  }));
  return { ...f, support: `${f.support}\n${kitAl(f)}`, cells };
}

/**
 * PR-191: the kit's AL, with a family's `readers` folded into `Observe` before `dotnet=` (the part OBS captures, so the
 * kept daemon, the control and the fresh daemons compare them). A family without readers gets KIT_AL unchanged.
 */
export function kitAl(f: Family): string {
  const readers = f.readers ?? [];
  if (readers.length === 0) return KIT_AL;
  const vars = readers.flatMap((r) => r.vars).map((v) => `        ${v}\n`);
  const obs = readers.map((r) => `            ' ${r.name}=[' + ${r.expr} + ']' +\n`);
  const a = "        B64: Text;\n    begin\n";
  const b = "            ' dotnet=[len=' + Format(MS.Length()) + ' b64=' + B64 + ']');";
  if (!KIT_AL.includes(a) || !KIT_AL.includes(b))
    throw new Error("keep-census: the kit's Observe changed; update kitAl");
  return KIT_AL.replace(a, () => `        B64: Text;\n${vars.join("")}    begin\n`).replace(
    b,
    () => `${obs.join("")}${b}`,
  );
}

/** app.json with the kit's id range and the resource folder the entries' `active-mutant.txt` override needs. */
export function kitAppJson(json: string): string {
  const j = JSON.parse(json) as {
    idRanges?: { from: number; to: number }[];
    resourceFolders?: string[];
  };
  j.idRanges = [...(j.idRanges ?? []), { from: KIT_FROM, to: KIT_TO }];
  j.resourceFolders = [...(j.resourceFolders ?? []), "LethALResources"];
  return `${JSON.stringify(j, null, 2)}\n`;
}

/** The family's census app: files by path. */
export function emitCensusApp(f: Family): Record<string, string> {
  const files = emitApp(withKit(f));
  return {
    ...files,
    "app.json": kitAppJson(files["app.json"] ?? ""),
    "LethALResources/active-mutant.txt": "NONE",
  };
}

/** True when an AL source text declares an object whose id falls in the kit's range. */
export function usesKitIds(al: string): boolean {
  const re =
    /\b(?:table|tableextension|page|pageextension|codeunit|report|xmlport|query|enum|enumextension|interface)\s+(\d+)\b/gi;
  for (const m of al.matchAll(re)) {
    const n = Number(m[1]);
    if (n >= KIT_FROM && n <= KIT_TO) return true;
  }
  return false;
}

export interface Refuser {
  /** The entry's `test` text. */
  readonly selector: string;
  readonly label: string;
  readonly text: string;
}

/** Refused results grouped by the generator's class key, each with its cells' index. */
export function groupClasses(
  results: readonly CellResult[],
  baseId: number,
): Map<string, { index: number; id: number; result: CellResult }[]> {
  const groups = new Map<string, { index: number; id: number; result: CellResult }[]>();
  results.forEach((result, index) => {
    if (result.outcome !== "refused") return;
    const k = classOf(result.message ?? "");
    groups.set(k, [...(groups.get(k) ?? []), { index, id: baseId + 1 + index, result }]);
  });
  return groups;
}

/** PR-93: refusers measured per class (`--refusers`; 3 as PR-54 measured). */
let refuserCount = 3;

/** Up to `n` refusers: different full texts first (the sibling texts of one class), then the rest, in order. */
export function pickRefusers<T extends { text: string }>(all: readonly T[], n = 3): T[] {
  const picked: T[] = [];
  const seen = new Set<string>();
  for (const r of all) {
    if (picked.length < n && !seen.has(r.text)) {
      picked.push(r);
      seen.add(r.text);
    }
  }
  for (const r of all) if (picked.length < n && !picked.includes(r)) picked.push(r);
  return picked;
}

export interface Judgement {
  readonly verdict: "CLEAN" | "NOT CLEAN" | "NOT MEASURED";
  readonly why: string;
}

export interface Evidence {
  readonly control: string | undefined;
  readonly coldReader: string | undefined;
  readonly keptReaders: readonly string[];
  readonly freshReaders: readonly string[];
  /** Per refuser, how many times its row was a refusal under serve (kept and fresh daemons together). */
  readonly refusalsPerRefuser: readonly number[];
  /** `engineKept` of each kept-daemon reader request after a refusal: true is real evidence the engine was reused. */
  readonly keptEngineFlags: readonly boolean[];
  readonly panics: readonly string[];
  readonly keptAliveAtEnd: boolean;
}

/**
 * PR-53's rule: every reader equals the control, no panic text, and EACH refuser refused at least once. On the kept daemon
 * every reader request reports `engineKept` (the engine was reused, not rebuilt). The pid is not evidence: it is constant by
 * construction while the process lives, so only "still alive at the end" is checked.
 */
export function judge(e: Evidence): Judgement {
  if (e.control === undefined || !e.control.startsWith("OBS "))
    return {
      verdict: "NOT MEASURED",
      why: `the control reader gave no OBS line: ${e.control ?? "none"}`,
    };
  if (e.refusalsPerRefuser.length === 0 || e.refusalsPerRefuser.some((n) => n === 0))
    return {
      verdict: "NOT MEASURED",
      why: `a refuser did not refuse under serve (refusals per refuser: ${e.refusalsPerRefuser.join(",") || "no refuser"})`,
    };
  if (e.keptReaders.length === 0 || e.freshReaders.length === 0)
    return { verdict: "NOT MEASURED", why: "no reader answers after a refusal" };
  const bad: string[] = [];
  const dk = e.keptReaders.filter((o) => o !== e.control).length;
  if (dk > 0) bad.push(`${dk} kept reader(s) differ from the control`);
  const df = e.freshReaders.filter((o) => o !== e.control).length;
  if (df > 0) bad.push(`${df} fresh reader(s) differ from the control`);
  const nk = e.keptEngineFlags.filter((f) => !f).length;
  if (e.keptEngineFlags.length === 0 || nk > 0)
    bad.push(
      `engineKept was not true on ${e.keptEngineFlags.length === 0 ? "any" : `${nk} of ${e.keptEngineFlags.length}`} kept reader request(s): reuse not shown`,
    );
  if (!e.keptAliveAtEnd) bad.push("the kept daemon did not survive");
  if (e.panics.length > 0) bad.push(`panic text: ${e.panics[0]}`);
  return bad.length === 0
    ? {
        verdict: "CLEAN",
        why: `${e.keptReaders.length} kept + ${e.freshReaders.length} fresh readers equal the control, engineKept on all ${e.keptEngineFlags.length} kept reader requests, each of ${e.refusalsPerRefuser.length} refuser(s) refused (${e.refusalsPerRefuser.join("+")}), no panic text`,
      }
    : { verdict: "NOT CLEAN", why: bad.join("; ") };
}

// ---- the serve daemon (LethAL's spawnDaemon argv and request body, as PR-53's driver)

type Line = Record<string, unknown>;
type Sink = { write(s: string): void; flush(): void };
const OBS = /OBS rows=.*dotnet=\[[^\]]*\]/;

class Daemon {
  readonly proc: ReturnType<typeof Bun.spawn>;
  readonly pid: number;
  private readonly rd: { read(): Promise<{ value?: Uint8Array | undefined; done: boolean }> };
  private buf = "";
  panics: string[] = [];
  /** Refusal rows seen per refuser selector. */
  readonly refusals = new Map<string, number>();
  /** `timings.engineKept` of the last summary. */
  lastEngineKept: boolean | undefined;
  constructor(
    private readonly bin: string,
    private readonly app: string,
    private readonly pkgs: string,
    private readonly args: readonly string[],
    private readonly hasDeps: boolean,
    private readonly log: string[],
  ) {
    const sidecar = join(bin, "..", "dotnet-sidecar", "AlDotNetSidecar.dll");
    this.proc = Bun.spawn(
      [
        bin,
        "serve",
        "--package-cache",
        pkgs,
        "--test-timeout",
        "20",
        // PR-377: the families' one exact build (a bare `28` resolves to a build whose .NET runtime al-runner fetches)
        "--bc-version",
        REFUSAL_FAMILY_BC_VERSION,
        ...(hasDeps ? [] : ["--no-download"]),
        "--dotnet-sidecar",
        sidecar,
      ],
      {
        cwd: app,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
        env: mergeChildEnv(v3ChildEnv()), // PR-360: LethAL's own pins (seed, replay off), not the shell's
      },
    );
    this.pid = this.proc.pid;
    this.rd = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
  }
  private async nextLine(): Promise<string | undefined> {
    for (;;) {
      const nl = this.buf.indexOf("\n");
      if (nl >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        return line;
      }
      const { value, done } = await this.rd.read();
      if (done) return undefined;
      this.buf += new TextDecoder().decode(value);
    }
  }
  async ready(): Promise<void> {
    await this.nextLine();
  }
  alive(): boolean {
    return this.proc.exitCode === null;
  }
  /** One request; returns the reader's OBS answers. `refuserName` counts the refuser rows that were refusals. */
  async request(label: string, tests: string[], refuserName?: string): Promise<string[]> {
    const s = this.proc.stdin as unknown as Sink;
    s.write(
      `${JSON.stringify({
        command: "runTests",
        sourcePaths: [this.app],
        testIsolation: "test",
        // serve takes no --no-client: LethAL sends it as the request field
        ...(this.args.includes("--no-client") ? { noClient: true } : {}),
        entries: tests.map((t, i) => ({
          id: `e${i}`,
          resources: { "active-mutant.txt": "NONE" },
          test: t,
        })),
      })}\n`,
    );
    s.flush();
    const lines: Line[] = [];
    const guard = setTimeout(() => this.proc.kill(), 240_000);
    try {
      for (;;) {
        const raw = await this.nextLine();
        if (raw === undefined) {
          this.log.push(`### ${label}: stdout closed`);
          break;
        }
        const obj = JSON.parse(raw) as Line;
        lines.push(obj);
        if (obj.type === "summary" || (obj.type === undefined && "error" in obj)) break;
      }
    } finally {
      clearTimeout(guard);
    }
    this.log.push(`### ${label} pid=${this.pid} tests=${JSON.stringify(tests)}`);
    const obs: string[] = [];
    for (const l of lines) {
      const { coverage, perTestCoverage, ...rest } = l;
      const j = JSON.stringify(rest);
      if (l.type === "test" || l.type === "summary" || "error" in l)
        this.log.push(`  ${j.slice(0, 600)}`);
      if (/panic/i.test(j)) this.panics.push(`${label}: ${j.slice(0, 160)}`);
      if (l.type === "summary")
        this.lastEngineKept =
          (l.timings as { engineKept?: unknown } | undefined)?.engineKept === true;
      if (l.type !== "test" || typeof l.message !== "string") continue;
      const name = String(l.name);
      if (name.startsWith(`Codeunit${KIT_READER}.`))
        obs.push(OBS.exec(l.message)?.[0] ?? `NO-OBS ${l.message.slice(0, 200)}`);
      else if (
        refuserName !== undefined &&
        name.startsWith(refuserName) &&
        (l.notRun === true || isV3RefusalText(l.message))
      )
        this.refusals.set(refuserName, (this.refusals.get(refuserName) ?? 0) + 1);
    }
    return obs;
  }
  async stop(): Promise<void> {
    try {
      const s = this.proc.stdin as unknown as Sink;
      s.write(`${JSON.stringify({ command: "shutdown" })}\n`);
      s.flush();
      await Promise.race([this.nextLine(), Bun.sleep(5000)]);
    } catch {
      // gone
    }
    this.proc.kill();
    await this.proc.exited;
  }
}

export interface ClassResult {
  readonly source: string;
  readonly cls: string;
  readonly refusedCells: number;
  readonly refusers: readonly Refuser[];
  readonly verdict: Judgement["verdict"];
  readonly why: string;
  readonly control?: string;
  readonly texts: readonly string[];
}

export interface Target {
  readonly source: string;
  readonly app: string;
  readonly args: readonly string[];
  readonly hasDeps: boolean;
  readonly bin: string;
  readonly pkgs: string;
  readonly outDir: string;
}

/**
 * The raw log's file name for one class: `serve.<source>.<index>-<class text cut to 60>.log`. The
 * index keeps two classes that share their first 60 characters from overwriting each other's log
 * (PR-74 lost two raw logs that way).
 */
export function classLogName(source: string, index: number, cls: string): string {
  return `serve.${source}.${index}-${cls.replace(/[^\w]+/g, "_").slice(0, 60)}.log`;
}

/** Drives one class: 1 kept daemon (control, then per refuser 3 rounds + 1 two-entry request), then 3 fresh daemons per refuser. */
export async function measureClass(
  t: Target,
  cls: string,
  refusedCells: number,
  refusers: readonly Refuser[],
  classIndex: number,
): Promise<ClassResult> {
  const log: string[] = [];
  const base = {
    source: t.source,
    cls,
    refusedCells,
    refusers,
    texts: refusers.map((r) => r.text),
  };
  const mk = () => new Daemon(t.bin, t.app, t.pkgs, t.args, t.hasDeps, log);
  const READER = `Codeunit${KIT_READER}.`;
  const kept: string[] = [];
  const fresh: string[] = [];
  const engineFlags: boolean[] = [];
  const panics: string[] = [];
  const refusals = new Map<string, number>();
  const addRefusals = (d: Daemon) => {
    for (const [k, n] of d.refusals) refusals.set(k, (refusals.get(k) ?? 0) + n);
  };
  let control: string | undefined;
  let cold: string | undefined;
  let aliveEnd = false;
  const open: Daemon[] = [];
  try {
    const d = mk();
    open.push(d);
    await d.ready();
    cold = (await d.request("cold reader", [READER]))[0];
    await d.request("setter", [`Codeunit${KIT_SETTER}.`]);
    control = (await d.request("reader after setter", [READER]))[0];
    for (const r of refusers) {
      for (let i = 1; i <= 3; i++) {
        await d.request(`${r.label} round ${i} refuser`, [r.selector], r.selector);
        kept.push(...(await d.request(`${r.label} round ${i} reader`, [READER])));
        engineFlags.push(d.lastEngineKept === true);
      }
      kept.push(...(await d.request(`${r.label} entries`, [r.selector, READER], r.selector)));
      engineFlags.push(d.lastEngineKept === true);
    }
    aliveEnd = d.alive();
    addRefusals(d);
    panics.push(...d.panics);
    await d.stop();
    for (const r of refusers)
      for (let i = 1; i <= 3; i++) {
        const f = mk();
        open.push(f);
        await f.ready();
        await f.request(`${r.label} fresh ${i} refuser`, [r.selector], r.selector);
        fresh.push(...(await f.request(`${r.label} fresh ${i} reader`, [READER])));
        addRefusals(f);
        panics.push(...f.panics);
        await f.stop();
      }
  } catch (err) {
    return {
      ...base,
      verdict: "NOT MEASURED",
      why: `the drive failed: ${String(err).slice(0, 300)}`,
    };
  } finally {
    for (const d of open) if (d.alive()) d.proc.kill();
    writeFileSync(join(t.outDir, classLogName(t.source, classIndex, cls)), `${log.join("\n")}\n`);
  }
  const j = judge({
    control,
    coldReader: cold,
    keptReaders: kept,
    freshReaders: fresh,
    refusalsPerRefuser: refusers.map((r) => refusals.get(r.selector) ?? 0),
    keptEngineFlags: engineFlags,
    panics,
    keptAliveAtEnd: aliveEnd,
  });
  return { ...base, ...j, ...(control !== undefined ? { control } : {}) };
}

function oneShot(
  bin: string,
  args: readonly string[],
  cwd: string,
  dir: string,
  extra: string[] = [],
) {
  const p = Bun.spawnSync(
    [
      bin,
      "test",
      "--bc-version",
      REFUSAL_FAMILY_BC_VERSION,
      "--output-json",
      ...args,
      ...extra,
      dir,
    ],
    {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: mergeChildEnv(v3ChildEnv()), // PR-360
      timeout: 900_000,
    },
  );
  return rowsOf(
    p.stdout.toString(),
    p.stderr.toString(),
    p.exitCode,
    p.exitedDueToTimeout === true,
  );
}

async function censusFamily(f: Family, bin: string, out: string): Promise<ClassResult[]> {
  const app = join(out, f.name, "app");
  for (const [file, text] of Object.entries(emitCensusApp(f))) {
    mkdirSync(join(app, file, ".."), { recursive: true });
    writeFileSync(join(app, file), text);
  }
  const pkgs = join(out, f.name, "pkgs");
  mkdirSync(pkgs, { recursive: true });
  const rows = oneShot(bin, f.args ?? [], app, app);
  if ("error" in rows) throw new Error(`${f.name}: ${rows.error}`);
  const results = classify(f, [...rows.values()]);
  const groups = groupClasses(results, 51000);
  const t: Target = {
    source: f.name,
    app,
    args: f.args ?? [],
    hasDeps: (f.dependencies ?? []).length > 0,
    bin,
    pkgs,
    outDir: join(out, f.name),
  };
  const done: ClassResult[] = [];
  for (const [cls, cells] of groups) {
    const all = cells.map((c) => ({
      selector: `Codeunit${c.id}.`,
      label: `C${c.index}`,
      text: refusalText(c.result.message ?? ""),
    }));
    done.push(
      await measureClass(t, cls, cells.length, pickRefusers(all, refuserCount), done.length),
    );
    console.log(`${f.name} | ${cls} | ${done[done.length - 1]?.verdict}`);
  }
  return done;
}

async function censusRepros(bin: string, out: string, only?: string): Promise<ClassResult[]> {
  const done: ClassResult[] = [];
  for (const r of readManifest().repros as readonly Repro[]) {
    if (only !== undefined && !only.split(",").includes(r.id)) continue;
    const dir = join(out, r.id);
    if (r.apps !== undefined) {
      done.push(skip(r, "a repro of several apps: the kit is not added"));
      continue;
    }
    rmSync(join(dir, "app"), { recursive: true, force: true });
    copyTree(join(REPRO_ROOT, r.id), join(dir, "app"));
    const app = join(dir, "app");
    if (hasKitIds(app)) {
      done.push(skip(r, "an object id in 50940-50999"));
      continue;
    }
    writeFileSync(join(app, "app.json"), kitAppJson(readFileSync(join(app, "app.json"), "utf8")));
    mkdirSync(join(app, "LethALResources"), { recursive: true });
    writeFileSync(join(app, "LethALResources", "active-mutant.txt"), "NONE");
    writeFileSync(join(app, "_Kit.al"), KIT_AL);
    const rows = oneShot(bin, r.args ?? [], app, app);
    if ("error" in rows) {
      done.push(skip(r, `the repro with the kit did not run: ${rows.error.slice(0, 200)}`));
      continue;
    }
    const cells: { name: string; text: string }[] = [];
    for (const row of rows.values())
      if (row.notRun === true || isV3RefusalText(row.message))
        cells.push({ name: row.name, text: refusalText(row.message ?? "") });
    const groups = new Map<string, { selector: string; label: string; text: string }[]>();
    for (const c of cells) {
      const k = classOf(c.text);
      groups.set(k, [...(groups.get(k) ?? []), { selector: c.name, label: c.name, text: c.text }]);
    }
    const t: Target = {
      source: r.id,
      app,
      args: r.args ?? [],
      hasDeps: JSON.parse(readFileSync(join(app, "app.json"), "utf8")).dependencies?.length > 0,
      bin,
      pkgs: join(dir, "pkgs"),
      outDir: dir,
    };
    mkdirSync(t.pkgs, { recursive: true });
    for (const [cls, list] of groups) {
      done.push(
        await measureClass(t, cls, list.length, pickRefusers(list, refuserCount), done.length),
      );
      console.log(`${r.id} | ${cls} | ${done[done.length - 1]?.verdict}`);
    }
  }
  return done;
}

function skip(r: Repro, why: string): ClassResult {
  return {
    source: r.id,
    cls: "(repro not run with the kit)",
    refusedCells: 0,
    refusers: [],
    verdict: "NOT MEASURED",
    why,
    texts: [],
  };
}

function copyTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const e of readdirSync(from, { withFileTypes: true })) {
    if (e.isDirectory()) copyTree(join(from, e.name), join(to, e.name));
    else copyFileSync(join(from, e.name), join(to, e.name));
  }
}

function hasKitIds(dir: string): boolean {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (
      e.isDirectory() ? hasKitIds(p) : e.name.endsWith(".al") && usesKitIds(readFileSync(p, "utf8"))
    )
      return true;
  }
  return false;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const out = opt("--out");
  if (out === undefined)
    throw new Error(
      "usage: keep-census.ts (--family <name> | --repros) --out <dir> [--bin <al-runner>] [--refusers <n>]",
    );
  const bin = opt("--bin") ?? "/work/tools/al-runner-v3/current/al-runner";
  const n = opt("--refusers");
  // a trailing --refusers with no value is refused, never read as the default (it would measure fewer texts)
  if (args.includes("--refusers") && n === undefined) throw new Error("--refusers needs a value");
  if (n !== undefined) {
    const v = Number(n);
    if (!Number.isInteger(v) || v < 1)
      throw new Error(`--refusers needs a whole number of at least 1, got ${n}`);
    refuserCount = v;
  }
  mkdirSync(out, { recursive: true });
  const name = opt("--family");
  const f = name !== undefined ? FAMILIES[name] : undefined;
  if (name !== undefined && f === undefined) throw new Error(`unknown family ${name}`);
  const res =
    f !== undefined ? await censusFamily(f, bin, out) : await censusRepros(bin, out, opt("--only"));
  writeFileSync(
    join(out, `census.${f?.name ?? (opt("--only") !== undefined ? "repros-only" : "repros")}.json`),
    `${JSON.stringify(res, null, 2)}\n`,
  );
}
