# Join the LethAL autonomous run

Work out which of the four sessions you are, then start it. Runbook:
`docs/superpowers/runbooks/autonomy/`. Inside a kraken container nothing here waits for the owner.

## 1. Find your role

Run `bun scripts/coord-join-role.ts`. It prints one JSON line:
`{ session, roleFile, kraken, skipRename, loopFromStart }`. Exit 1: say what it printed and stop.

With `KRAKEN_PROJECT` set the role comes from `KRAKEN_AGENT`; otherwise from the directory.

## 2. Check the role is free

Call `ListAgents`. Another live session already has your name: do not take it; tell the user
which role is missing and its directory, then stop. This session already has the name: go to
step 4.

## 3. Get the name

If `skipRename` is false: you cannot rename yourself. Tell the user:

> I am `<session>`. Please run `/rename <session>` so the other session can reach me.

Wait for confirmation, then check `ListAgents` shows the new name.

If `skipRename` is true: the session was named by `--name` when it started. Check `ListAgents`
shows `<session>`. Do not ask the owner for anything.

## 4. Acknowledge (kraken only)

If `kraken` is true, run `kraken tentacle ack` now. Run it only after steps 2 and 3 passed, and
before any other work. If it fails, report its output and stop (the tentacle retries the join).
If `kraken` is false, skip this step.

## 5. Start the role

- `orchestrator.md`: read it. If `loopFromStart` is true, do NOT ask the owner to type `/loop`;
  the loop arrives as your next prompt. Otherwise tell the user to start the loop with
  `/loop You are lethal-orchestrator. Follow docs/superpowers/runbooks/autonomy/orchestrator.md: run its start procedure if you have not done so in this session, then do one sweep.`
- `lane.md`: read it and follow its "On every start" section.

## 6. Tell the orchestrator

Every lane (`lethal-code`, `lethal-bugs`, `lethal-preproc`): the last start step messages
`lethal-orchestrator` that you are online; never skip it, the orchestrator waits for it after a
`/clear`.

Report which of the other roles are live, and the directory of each that is not.
