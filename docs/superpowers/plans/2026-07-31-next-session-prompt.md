# Next-session prompt — TestPage spike, then the open queue

Paste/load this as the opening instruction of a fresh session.

---

Continue LethAL roadmap execution. Work autonomously; only stop to ask when a decision is genuinely
mine (a product call, or spending money / starting infrastructure beyond what is authorised below).

## Read first

- `ROADMAP.md` — the durable record. Every open item has its evidence pointer.
- `docs/superpowers/plans/2026-07-31-roadmap-execution-2.md` — the battleplan: wave order, the fixed
  9-step per-item cycle, the injection rule, stop conditions. Follow the cycle.
- `CLAUDE.md` — build/test loop (the dist trap is real), conventions, gate commands.
- Specs written last session, all three worth skimming before touching their areas:
  `docs/superpowers/specs/2026-07-31-r30-pageextension-scope-design.md`,
  `…-r59-runner-disagreement-design.md`, `…-r33-tier2-phase2-design.md`.

## FIRST TASK — the TestPage spike (R69). Do this before anything else.

**The question.** LethAL produces every verdict from a fenced OData session
(`GuiAllowed=No`, `ClientType=ODataV4`). Measured 2026-07-31: a test that opens a `TestPage` fails
there in **87 ms** with
`Unexpected CLR exception thrown.: System.NotSupportedException: Specified method is not supported.
 at Microsoft.Dynamics.Nav.Runtime.NavSession.CreateNavTestService()`.
The same test through the bc-dev-mcp hub (`GuiAllowed=Yes`/`ClientType=Web`) **works** (1766 ms).
So it is a session-TYPE limit, not permissions/licence/config. **9 of Continia Document Output's
104 test files declare a `TestPage`** (38+ declarations), so this silently drops a real slice of a
customer suite.

**The design to prove.** `U:/Git/bc-mcp/` speaks BC's **native client-services WebSocket protocol**
in TypeScript — "no OData, no APIs, no browser automation". A page action's AL runs in that client
session, which is the session type that CAN create a test service. So: LethAL seeds a work queue
(mutant × test) into a control-app table over OData → opens a control-app page and invokes ONE
action over the WebSocket → the action loops **in-session**: `WriteActive` → run one method →
capture result + `AttestationObservedAny()` → write a result row → LethAL reads results back over
OData. One WebSocket session per BATCH, not per run.

Why this beats the alternatives: our own AL runs in the capable session, so the
`LC Control State.Loaded` cache is correct by construction (we activate in-session, per iteration),
attestation survives, and single-method selection plus the `TryBeginRun` lease proof carry over
unchanged. Routing through the hub instead loses attestation and hits that cache trap; the
bccontainerhelper `ClientContext` route needs a PowerShell sidecar.

**The spike itself — zero new AL required.**

1. `.mcp.json`'s `bc` server points at `http://Cronus28/BC`, which does not exist in this topology —
   that is why `bc_list_companies` returns `Session creation failed after all retry attempts`.
   Repoint it to `http://Cronus281/BC` (same `sshadows` / `1234`). Worth fixing regardless.
2. Do NOT drive it through the MCP round-trip. `U:/Git/bc-mcp/scripts/` is full of standalone TS
   probes against `src/connection` + `src/api` (`probe-action-enabled.ts`, `continia-smoke.ts`,
   `dump-control-tree.ts`, `gate-a-isexecuting.ts`) — copy that shape.
3. Open page **130451** (AL Test Tool) on Cronus281. Point its suite at codeunit **79218
   `Test Page Probe`**, method `ReportsTestPageOpen` — already published there (probes 1.0.8.0).
   If populating the suite through the page is awkward, seed `Test Method Line` over OData and have
   the script only invoke Run.
4. Invoke Run; read the result line.

**Success criterion, unambiguous because the fenced control already exists:** the same method fails
on the fenced path in 87 ms with the `CreateNavTestService` refusal. If through a client-services
session it PASSES — or reaches the probe's own
`MEASURED testpage-open=OK | GuiAllowed=Yes | ClientType=Web` raise — the premise is proven end to
end and the batch-runner becomes an engineering task rather than a bet. If it fails the same way,
say so loudly and the whole approach is dead; that is a fine outcome, recorded.

**Still a product call, not mine to make:** everything on that path runs `GuiAllowed=Yes`, so those
verdicts carry interactive semantics (R55/R57 — an unhandled `Confirm` raises instead of returning
its default). Scoping it to the tests the fence REFUSES, with per-test runner provenance in the
report, keeps it honest — but it touches R58's one-runner doctrine, so surface it rather than decide
it.

Fable's fuller option ranking (per-test runner affinity via the hub; a `StartSession` background
child, ~15–25% prior; the Command Line TestTool via client services; "make the fenced session
capable", probably dead) is summarised in R69's roadmap row. There is also a **Probe 0** worth an
hour whatever happens: ILSpy `Microsoft.Dynamics.Nav.Ncl.dll` out of a container and enumerate which
`NavSession` subclasses override `CreateNavTestService` — that prices every option from the binary
instead of from priors, and R58 set the precedent by verifying `DevHostStartup` the same way.

## Then, the open queue (ranked by risk)

| item | why it ranks there |
|---|---|
| **R70** | The only one pointing the DANGEROUS direction. `buildSymbolTable` keys scope on the bare object name, so `page "CDO Setup"` overwrites `table "CDO Setup"`'s variables — reproduced; **13 such names on Document Output**, the standard card-page convention. Fix is R30's shape one namespace over (`scopeKeyOf(kind, name)`), but it touches 4 call sites (`receiver.ts` `lookupVar`, `types.ts` ×2, `callers.ts`) plus every engine test that asks `globalsOf("Vars Test")` by bare name, and needs a fixture with a cross-kind collision because all four frozen gates are blind to it. |
| **R72 / R73** | `RemoveCommit`'s two debts: BC's "cannot run codeunit in a write transaction" is not distinguished from a genuine kill, and no gate has ever GENERATED a `remove-commit` mutant (both fixture sites are the shadowed negatives). R73's fixture work also settles whether a committed write survives a later uncaught error under test isolation — the operator's actual kill mechanism, still unmeasured. |
| **R66** | Now implementable, not blocked. Measured: `GetLastErrorCode()` returns `DB:ClientInsertDenied` in English AND Danish, and the `(TableData <id> <name> <op>: <suite>)` parenthetical survives translation byte-identically. The parenthetical is the cheap route (no AL change, no `MIN_CONTROL_VERSION` bump). Needs a red-check plus a control proving a non-refusal message with a similar parenthetical is NOT matched. |
| **R71** | `SwapRecXRec` scoped to `OnValidate`/`OnRename`, where `xRec` measurably differs (`differ=Yes` both). Must NOT claim `OnModify`-shaped sites (measured equivalent) — the first Tier-2 operator whose targeting depends on the enclosing TRIGGER KIND rather than the receiver. |
| **R67 / R68** | Safe-direction coverage losses: a plain `page`'s implicit `Rec` is refused though its `SourceTable` is right there (66 sites on DO); a variable declared in a TRIGGER's own `var` section resolves in no object kind. |
| **Exit** | Fresh `superpowers:brainstorming` for the Tier-3 program (R13, which unblocks R11). Own spec, plan, battleplan. |

## Environment / infra state

- Containers **Cronus281** (sandbox-app, sandbox-hang, sandbox-probes) and **Cronus283**
  (sandbox-data) are up. `docker context use desktop-windows` first — the session default is the
  Linux engine.
- Control app **1.0.0.10** on both, in lockstep with `MIN_CONTROL_VERSION`. Touching
  `extensions/lethal-control` means `/control-app`.
- Published fixture app versions: `sandbox-probes` **1.0.8.0** (Cronus281), `sandbox-tests`
  **1.0.0.2** (Cronus281), `sandbox-data-tests` **1.0.0.3** (Cronus283).
- Continia env `lethal-gate-6c` (`a8f54c93-641a-4eb5-ac16-461e21a7bada`) is **Stopped**; ~7.5 min to
  start. Only `itest:envtool` needs it. Authorised to start/stop as needed.
- Frozen gates, all green: `itest:bcdev` **3/10/3** · `itest:tables` **69/9/6** over 84 deployed
  mutants (93 raw specs), `untargetedTriggerCount` 0 · `itest:alrunner` **3/13/0** ·
  `itest:envtool` **3/10/3** · `itest:hang` both legs, self-tearing-down.

## Gotchas learned the hard way last session — do not re-pay for these

- **Fixture apps are TENANT-scoped.** Republish with
  `Publish-BcContainerApp -containerName <c> -appFile <path> -skipVerification -sync -upgrade -install -scope Tenant -tenant default`.
  The Global-scope default cannot see a tenant-scoped dependency and fails its server-side recompile
  with `AL1024`.
- **Bump the app version before republishing** a fixture app, or the upgrade is refused.
- **`[TryFunction]` measures itself.** The platform refuses `COMMIT` and `INSERT` inside a
  TryFunction under `RunTests`, so a probe that wraps them captures the WRAPPER's refusal, not the
  real one. Use `Codeunit.Run` as the catch idiom. This trap fired three times in one session — it
  is R26's canary mistake in a new costume.
- **Probes report by raising** `Error('MEASURED …')`: a passing test surfaces nothing, a failure
  message is carried back verbatim by every runner. Read the result out of the run's SQLite store:
  `select method, outcome, failure_message from test_results order by id desc`.
- Baseline re-record is deliberate: `LETHAL_RERECORD_BASELINE=1`, then PROVE the new file compares
  against itself on a later run (R29 exists because a committed baseline could never match itself).
- `bun run typecheck` → `rm -rf packages/*/dist` → `bun test` → `bun run compile:fixtures`. In that
  order. A PostToolUse hook already refuses an AL edit that breaks a fixture compile (R56).
- Editing files with Python: use `newline=""` on read AND write, or the file silently becomes CRLF
  and biome rewrites the whole thing.

## Working style

Roll straight from one item into the next. Report per item: what shipped, what you verified, and —
explicitly — what you did **not** prove. Say "unproven" when it is unproven; a green gate that does
not exercise the feature proves absence of regression, nothing more. File new findings as `R<n>`
rows the moment you hit them.

**Verify a roadmap item's prescribed fix before implementing it.** Last session R59's stated hazard
(a false kill) turned out to be structurally impossible — a kill already requires an unmutated
FENCED confirmation to pass — and the item's real content was a missing diagnosis. Two items the
session before that were impossible as written. Reading the code first cost minutes and saved days.

**Measure rather than reason about BC.** Last session, five separate platform claims written with
full confidence turned out wrong or overstated: `xRec` never differs headlessly (it does, in
`OnValidate`/`OnRename`); `SetLoadFields` removal is unkillable by construction (the JIT reread
raises); a TestPage HANGS the fenced path (it is refused in 87 ms); R66 needs a localized SERVER (it
needs a session language); Commit is refused in a test (only inside a TryFunction). Every one was
settled in minutes by a probe in `fixtures/sandbox-probes`. The harness is there — use it.

Red-check every fix with `mutation-red-checker` — last session it caught one of my own new tests
passing for the wrong reason. Use the `spec-adversary` agent (on `fable`) for any design that changes
how a verdict is reached; it caught two overreaching claims in the R33 spec that four probes then
settled.
