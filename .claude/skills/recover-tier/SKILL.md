---
name: recover-tier
description: Recover a LethAL tier that is quarantined or holding a stranded operation marker — recycle the environment, force-reset the lease, clear the quarantine. Use when a run refuses with "tier ... is quarantined", "container-needs-recycle", or "operation-orphaned". Publishes to and force-clears state on a live environment, so it is user-invoked only.
disable-model-invocation: true
---

# Recover a quarantined tier

A stranded mutant leaves TWO pieces of state behind, in different places, and clearing either one
alone leaves the tier refusing work:

| state | lives in | cleared by |
|---|---|---|
| durable quarantine record | `~/.lethal/quarantine/<hash>.json` (local) | `lethal clear-quarantine` |
| op marker on the `LC Lease` row | the environment's DATABASE | `lethal force-reset-lease` |

**An environment restart clears neither.** It kills sessions; the lease row is a table. That is
exactly why design §8 makes the restart and `ForceResetLease` separate steps, and it is the
mistake to expect: a restart looks like it should have been enough.

## When this applies

A run refuses with one of:

- `tier <server>|<instance> is quarantined (test-run: test in-flight-unknown running ...)`
- `LeaseUnavailableError: container-needs-recycle: AcquireLease reported operation-orphaned twice
  with an UNCHANGED marker`

Both usually mean a mutant did not terminate (R53's class — a negated loop-exit condition
reproduces this every time) and its attempt was abandoned mid-flight.

## The safety precondition, which is the whole reason this is user-invoked

`force-reset-lease` bumps the epoch, mints a new server generation and clears the op marker. That
is only SAFE once the stranded AL is actually dead. If the operation is still executing, a fresh
session can now take the lease while mutated code runs underneath it — a false verdict, which is
the failure class this whole layer exists to prevent.

So the restart is not optional and it is not a formality. Do it, confirm the environment reports
`Running` again, and only then reset. Do not reason from `serverGeneration` in the error message:
`operation-orphaned` means "op marker set, lease lapsed past grace" (`ControlState.Codeunit.al`)
and says nothing at all about whether a restart happened.

## Steps

### 1. Identify the tier

The refusal names it as `<server>|<instance>`, e.g.
`https://demoportaldev.continiaonline.com|a8f54c93-641a-4eb5-ac16-461e21a7bada`. For a container
the instance is the BC instance name; for an environment-tool environment it is the environment id.

### 2. Recycle

Container:

```bash
docker context use desktop-windows
Restart-BcContainer -containerName Cronus281       # PowerShell tool
```

Environment tool:

```bash
cd U:/Git
./CLI/continia.exe env stop <envId>
./CLI/continia.exe env start <envId>
# then WAIT for Running — starting is not started
until ./CLI/continia.exe env get <envId> | grep -qE "Status:\s+Running"; do sleep 20; done
```

### 3. Force-reset the lease

`force-reset-lease` reads the `bcdev` section DIRECTLY and does no environment-tool resolution, so
it needs `server`, `serverInstance`, `username` and `password` spelled out. For an env-tool config
those are resolved at runtime and absent from the file on disk.

`scripts/materialize-config.ts` (bundled with this skill) writes a resolved copy **outside the
repo**, prints nothing sensitive, and is deleted immediately after use:

```bash
bun .claude/skills/recover-tier/scripts/materialize-config.ts <envId> <base-config.json> U:/Git/.tier-recover.json
bun packages/runner/src/cli.ts force-reset-lease --server <server> --instance <instance> --config U:/Git/.tier-recover.json
rm -f U:/Git/.tier-recover.json
```

Never write that file inside the repository — the `no-committed-secrets` PreToolUse hook blocks it,
and the rule it enforces is the standing one about plaintext credentials.

### 4. Clear the quarantine

```bash
bun packages/runner/src/cli.ts clear-quarantine --server <server> --instance <instance>
```

Expect `cleared`. `not-quarantined` means the tier key did not match — check the server/instance
spelling against the refusal message verbatim.

### 5. Re-run, and do not let the same mutant strand again

A non-terminating mutant reproduces every time. `--resume` skips it by design:

```
1 stranded the tier on a prior run and will be SKIPPED rather than re-executed
```

Raising `--mutant-timeout-ms` does NOT help a mutant that never terminates — measured at both 30 s
and 120 s on the same mutant.

**`--resume` is fine for finishing a run. It is NOT a valid input to a differential gate:** it
carries prior verdicts while recomputing attribution, so each row mixes two runs. See the
`coverage-differential` skill.

## Report honestly

Say which steps ran, that the restart preceded the reset, and the epoch/generation transition
`force-reset-lease` printed. A recovery whose precondition was skipped is worth knowing about
later, when a verdict looks strange.
