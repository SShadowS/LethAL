# Rung-3 workspace contract

This is what the DO campaign's rung-3 `claude -p` agent gets, what it does not get, and — this is
the part that matters — **which guarantee comes from where**. Fix round 2 replaced a hook-only
fence (defeated by an adversarial review, see `task-4-report.md`) with this contract: violations
become impossible by construction where that's achievable, and the hook is defence-in-depth on top
of that, not the sole guarantee.

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

- **The LethAL source checkout.** Not `U:/Git/LethAL`, not a clone of it, not a worktree of it
  other than the one named above. The agent's workspace has nothing under that path to write into.
- **A raw, unnarrowed `lethal run`.** The product refuses one on its own — see below.
- **`--allow-large-run` or `--retry-stranded`.** These exist in the product (R48, R53) for
  legitimate operator use outside this campaign; inside it, they are exactly the two flags that
  turn a safe default into an unsafe or costly one, so the hook denies them unconditionally.

## Which guarantee comes from where

Do not read the fence hook as "the thing that stops the agent." Read it as the last of three
layers, and know which layer is actually load-bearing for each rule:

| Rule | Real guarantee | What layer it is |
|---|---|---|
| No writes under `U:/Git/LethAL` | **Workspace structure.** The tree isn't there. | Structural — nothing to defeat |
| No unnarrowed `lethal run` (>1000 sites) | **The product itself.** `assertRunSizeAcceptable` (`packages/runner/src/orchestrator.ts`, `LARGE_RUN_MUTANT_THRESHOLD = 1_000`) is a pre-flight refusal, on by default, before anything publishes. | Product-level — independent of this fixture entirely |
| No `--allow-large-run` / `--retry-stranded` | **`fence-hook.ts`'s Bash rule.** Text-matching on the command string. | Best-effort hook — see the honesty check below |
| No writes via other tools (Bash redirect, MCP tools, unknown future tools) | **`fence-hook.ts`**, tiers (a)/(b)/(c). | Best-effort hook |

The hook is real and has been hardened twice (round 1: MCP-tool and multi-line-regex bypasses;
round 2: the git-bash mount form, `..` traversal, quote-splitting, and split-field bypasses an
adversarial review demonstrated — full detail in `task-4-report.md`). It is **not** claimed
airtight. Text-matching a Bash command string is not a parser; a capable-enough adversary with
shell tricks (variable indirection, a wrapper script built by a prior command, base64) can defeat
substring matching in principle. `fence-hook.ts`'s own header comment says this plainly and names
the one bypass deliberately left open (a bare relative `..` traversal with no drive letter or
mount prefix — closing it reliably would mean trusting the hook subprocess's own cwd to match the
agent's actual shell cwd, which is not guaranteed, and guessing wrong risked false-denying a
legitimate relative `--tests-only` glob instead).

This is why the write rule's REAL guarantee is structural (no tree to write into) rather than the
hook, and why the run-size rule's REAL guarantee is the product's own refusal rather than the
`--only`/`--tests-only` presence check. The hook still matters — it is what turns a mistake into an
immediate, legible denial instead of a run that fails 40 minutes later for a reason the agent has
to go dig for — but nothing here is designed to depend on it being unbeatable.

## The preflight requirement

**Rung 3 must not start until `bun fixtures/do-campaign/preflight.ts <settings-file>` exits 0.**

Reason: Claude Code's `PreToolUse` hooks **fail open**. Only exit code 2 (or a well-formed JSON
`deny`) blocks a tool call — a hook subprocess that fails to spawn, crashes, emits malformed JSON,
or is named by a settings file pointing at a script that doesn't exist, all let the tool call
through **silently**. There is no error, no warning, nothing in the transcript that says the fence
was never there.

That is not hypothetical: it is exactly what `fixtures/do-campaign/settings.json`, as committed,
does **right now**. It names `bun U:/Git/LethAL/fixtures/do-campaign/fence-hook.ts` — the
MAIN-checkout path, correct for after this branch merges — but pre-merge that path does not exist.
Running `claude -p` against the committed settings file before merging gives the rung-3 agent **no
fence at all**, and the agent (and anyone watching) would have no way to know from the run itself.

`preflight.ts` closes this by reading the same settings file rung 3 will use, extracting every
configured hook command from it (never hardcoding a path — a wrong path is exactly what it needs
to catch), running each one exactly as the harness would (a probe event piped to it on stdin), and
requiring a well-formed `deny` back. It exits non-zero the moment that doesn't happen. Verified
both directions: it fails against the settings file as currently committed (pre-merge — the real
bug, not a synthetic one), and passes against a settings file naming a hook copy that actually
exists. See `task-4-report.md` for the full transcript of both runs.
