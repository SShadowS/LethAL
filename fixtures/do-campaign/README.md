# Rung-3 workspace contract

This is what the DO campaign's rung-3 `claude -p` agent gets, what it does not get, and — this is
the part that matters — **which guarantee comes from where, and how strong each one actually is**.
Four fix rounds went into this (full detail, probe matrix and bypass history in
`fence-probe-matrix.md`, committed alongside this file): round 1 hardened a hook that
an adversarial review then defeated with shell-level obfuscation; round 2 hardened it again and the
same review defeated it a second time, with a different obfuscation class. Round 3 is a course
correction, not another hardening pass — see the threat model below for why, and read this document
as the honest version of the claims, not the aspirational one. Round 4 fixed a fault in the other
direction: the hook was denying the agent's OWN workspace, because `\blethal\b` matches inside
`do-lethal`.

## Threat model

**The threat model for rung 3 is ACCIDENT, not adversary.** The agent is a Claude agent doing a
legitimate measurement task. It has no motive to evade a fence it isn't even told about, and no
reason to construct `Leth$()AL` or `$A$B` when `LethAL` and its own narrowed `--only`/`--tests-only`
values work fine and are what the task actually calls for.

What that buys: protection against the ordinary ways a legitimate agent could go wrong by mistake —
misreading a path, running `lethal run` without narrowing because it forgot, reaching for a
plausible-looking shell idiom that happens to touch the wrong tree. The probe matrix in
`fence-probe-matrix.md` covers this class and the hook denies all of it.

**And the fence must not fire on ordinary work.** A false deny is not the harmless direction here:
rung 3 files a roadmap row for every agent confusion (plan Task 8 step 4), so a fence that refuses
`cd U:/Git/do-lethal && bun run ...` manufactures the exact signal the campaign is trying to
measure. Cases 26–34 of the matrix hold that line, from both sides.

What it does NOT buy: any assurance against deliberate evasion. Three rounds produced three bypass
classes of the same underlying shape — text-matching a Bash command string is not a parser, and
every review that tried found a new way to make text that says one thing execute as another
(`$()`, `$VAR`, quote-splitting, path traversal, mount-form aliasing). The reviewer is right that
only OS-level isolation — a container, a VM, a locked-down account with no access to
`U:/Git/LethAL` at the filesystem layer — would actually hold against an adversarial actor, and this
campaign does not have that. If the threat model ever needs to include "the agent, or something
prompting it, is trying to get around the fence," this design is not sufficient and should not be
treated as if it were.

## What the agent gets

- The DO worktree: `U:/Git/do-lethal` (a sibling checkout of `U:/Git/LethAL`, created by
  `git worktree add`, pinned to a recorded commit).
- The standalone compiled LethAL binary: `build/lethal-0.1.0-alpha.1-windows-x64.exe`. It is
  self-contained (R49/R50 — both wasm assets embedded), so nothing else from the LethAL repo needs
  to be present for it to run.
- A narrowed invocation shape: `lethal run --project U:/Git/do-lethal/Cloud --only <glob>
  --tests-only <glob> --stop-hung-sessions` (see the design doc,
  `docs/superpowers/specs/2026-08-03-do-live-campaign-design.md:183-189`, for where this exact
  shape comes from).
- A budget (`--max-budget-usd`).

## What the agent does NOT get

- **A copy of the LethAL source checkout in its own workspace.** Not `U:/Git/LethAL`, not a clone
  of it, not a worktree of it other than the DO one named above. This removes the *accidental*
  path to touching it — nothing in the agent's normal working set references it, so it would have
  to go out of its way. It does **not** make the tree unreachable: read the guarantee table below
  before assuming more than that.
- **A raw, unnarrowed `lethal run`.** The product refuses one on its own — see below.
- **`--allow-large-run` or `--retry-stranded`, under the accident threat model.** These exist in
  the product (R48, R53) for legitimate operator use outside this campaign; inside it, they are
  exactly the two flags that turn a safe default into an unsafe or costly one, and the hook denies
  their plain-text appearance. A deliberately obfuscated invocation defeats this — see below.

## Which guarantee comes from where

Do not read the fence hook as "the thing that stops the agent." Read it as the last of several
layers, and know — honestly, not optimistically — which layer is actually load-bearing for each
rule:

| Rule | Real guarantee | Strength |
|---|---|---|
| No writes under `U:/Git/LethAL` | The workspace does not **contain** the tree, removing the accidental-reference path. `fence-hook.ts`'s write/Bash rules are the remaining layer. | **Partial, not structural.** `U:/Git/LethAL` and `U:/Git/do-lethal` are sibling directories on one drive, one filesystem, one OS account — no container, VM, or ACL boundary anywhere in this design. `ls ..` from the agent's cwd shows `LethAL` sitting right there, reachable by any absolute or resolvable path. The hook is what stands in that gap, and it is demonstrably defeatable by shell obfuscation (see below) — it was NOT, and should not be described as, "nothing to defeat." |
| No unnarrowed `lethal run` (>1000 sites) | **The product itself.** `assertRunSizeAcceptable` (`packages/runner/src/orchestrator.ts`, `LARGE_RUN_MUTANT_THRESHOLD = 1_000`) is a pre-flight refusal, on by default, before anything publishes. | **Strong, and independent of this fixture entirely.** This is the one row where the real guarantee doesn't run through `fence-hook.ts` at all. |
| No `--allow-large-run` / `--retry-stranded` | `fence-hook.ts`'s Bash rule, literal-text matching. | **Defeated by shell substitution, demonstrated.** `--allow-large-ru$()n` and `leth$()al ru$()n --project .` both pass the hook unchanged — `$()` (and `$VAR` indirection generally) is exactly the class this text matcher cannot see, because by the time the shell has evaluated it the literal text the hook read never existed. `--allow-large-run` is precisely the flag that disables `assertRunSizeAcceptable` above, so this is the row where the hook's weakness and the stakes intersect most directly. Accepted as residual per the threat model — not attempted to close in round 3. |
| No writes via other tools (Bash redirect, MCP tools, unknown future tools) | `fence-hook.ts`, tiers (a)/(b)/(c). | **Best-effort, same shell-substitution ceiling as above.** |

Three review rounds, three different bypass classes closed (round 1: MCP-tool and multi-line-regex
bypasses; round 2: git-bash mount form, `..` traversal, quote-splitting, split-field JSON), and a
fourth class (shell substitution) found and deliberately left open in round 3 — not because it
couldn't be described, but because the campaign owner decided closing it isn't worth what it costs
against a threat model that doesn't include deliberate evasion. Full detail and the probe matrix
proving both the closed classes and the accepted residuals: `fence-probe-matrix.md`, whose every
row is a live case in `packages/runner/tests/campaign-fence.test.ts`.

## The preflight requirement

**Rung 3 must not start until `bun fixtures/do-campaign/preflight.ts <settings-file>` exits 0.**

**What a passing preflight actually proves, stated plainly:** the configured hook command responds
with a well-formed `deny` to the small, specific set of known probes `preflight.ts` sends it — one
exercising the write rule, one exercising the `--allow-large-run` flag rule. That is a **wiring and
fail-open check** ("is a hook configured, does it run, does it answer correctly to a case we know
the answer to") — it is **not** a proof that the hook is correct in general, and it is specifically
not evidence against the shell-substitution residual above (a hook that special-cased exactly these
two probe strings and nothing else would also pass preflight; the review that found the
shell-substitution class made this point directly). Preflight's job is narrower than "prove the
fence works," and its README entry should not be read as claiming more.

Reason it exists at all: Claude Code's `PreToolUse` hooks **fail open**. Only exit code 2 (or a
well-formed JSON `deny`) blocks a tool call — a hook subprocess that fails to spawn, crashes, emits
malformed JSON, never responds at all, or is named by a settings file pointing at a script that
doesn't exist, all let the tool call through **silently**. There is no error, no warning, nothing
in the transcript that says the fence was never there.

That is not hypothetical: it is exactly what `fixtures/do-campaign/settings.json`, as committed,
does **right now**. It names `bun U:/Git/LethAL/fixtures/do-campaign/fence-hook.ts` — the
MAIN-checkout path, correct for after this branch merges — but pre-merge that path does not exist.
Running `claude -p` against the committed settings file before merging gives the rung-3 agent **no
fence at all**, and the agent (and anyone watching) would have no way to know from the run itself.

`preflight.ts` closes this by reading the same settings file rung 3 will use, extracting every
configured hook command from it (never hardcoding a path — a wrong path is exactly what it needs
to catch), running each one exactly as the harness would (a probe event piped to it on stdin), and
requiring a well-formed `deny` back within a bounded timeout (10s per probe — round 3 also fixed a
real bug where a hook that reads stdin and then hangs forever used to make `preflight.ts` hang
forever too, with zero diagnostic; it now kills the child and fails loudly, since a hook that never
answers is itself a fail-open case). It exits non-zero the moment any of that doesn't happen.
Verified: it fails against the settings file as currently committed (pre-merge — the real bug, not
a synthetic one), passes against a settings file naming a hook copy that actually exists, and fails
within the timeout against a deliberately hanging hook rather than hanging itself. See
`fence-probe-matrix.md` for what preflight does and does not prove.
