// Decides which coord role a session is, for /coord-join. The command file is prose an agent
// follows; the decision lives here so it can be tested.
export interface JoinRole {
  session: string;
  roleFile: "orchestrator.md" | "lane.md";
  kraken: boolean;
  skipRename: boolean;
  loopFromStart: boolean;
  /** lane.md's COORD-ONLY section: true only for the host preproc lane, which runs on another
   *  account and cannot rely on messages. Inside kraken every lane shares the account. */
  coordOnly: boolean;
}

const HOST: Record<string, [string, JoinRole["roleFile"], boolean]> = {
  "u:/git/lethal": ["lethal-orchestrator", "orchestrator.md", false],
  "u:/git/lethal-wt/lane-code": ["lethal-code", "lane.md", false],
  "u:/git/lethal-wt/lane-bugs": ["lethal-bugs", "lane.md", false],
  "h:/lethal-wt/lane-preproc": ["lethal-preproc", "lane.md", true],
};

const LANES = ["lane-code", "lane-bugs", "lane-preproc"];

export function role(top: string, env: Record<string, string | undefined>): JoinRole {
  if (env.KRAKEN_PROJECT) {
    const agent = env.KRAKEN_AGENT;
    if (!agent) throw new Error("KRAKEN_AGENT is not set");
    const isOrch = agent === "orchestrator";
    if (!isOrch && !LANES.includes(agent)) throw new Error(`KRAKEN_AGENT ${agent}: unknown agent`);
    const want = isOrch ? "/work/lethal" : `/work/lethal-wt/${agent}`;
    if (top.replaceAll("\\", "/").replace(/\/+$/, "") !== want) {
      throw new Error(`KRAKEN_AGENT ${agent} in ${top}: not its worktree`);
    }
    return {
      session: isOrch ? "lethal-orchestrator" : `lethal-${agent.slice("lane-".length)}`,
      roleFile: isOrch ? "orchestrator.md" : "lane.md",
      kraken: true,
      skipRename: true,
      loopFromStart: isOrch,
      coordOnly: false,
    };
  }
  const hit = HOST[top.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()];
  if (!hit) throw new Error(`no role for ${top}`);
  return {
    session: hit[0],
    roleFile: hit[1],
    kraken: false,
    skipRename: false,
    loopFromStart: false,
    coordOnly: hit[2],
  };
}

if (import.meta.main) {
  try {
    const top = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"]).stdout.toString().trim();
    console.log(JSON.stringify(role(top, process.env)));
  } catch (e) {
    console.log(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
