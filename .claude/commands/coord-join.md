# Join the LethAL autonomous run

Work out which of the two sessions you are, then start it. Runbook:
`docs/superpowers/runbooks/autonomy/`.

## 1. Your role comes from your directory

Run `git rev-parse --show-toplevel`:

| Top level | Session name | Role file |
| --- | --- | --- |
| `U:/Git/LethAL` | `lethal-orchestrator` | `orchestrator.md` |
| `U:/Git/LethAL-wt/lane-code` | `lethal-code` | `lane.md` |

Anything else: say this directory has no role and stop.

## 2. Check the role is free

Call `ListAgents`. Another live session already has your name: do not take it; tell the user
which role is missing and its directory, then stop. This session already has the name: go to
step 4.

## 3. Get the name

You cannot rename yourself. Tell the user:

> I am `<session name>`. Please run `/rename <session name>` so the other session can reach me.

Wait for confirmation, then check `ListAgents` shows the new name.

## 4. Start the role

- `lethal-orchestrator`: read `orchestrator.md` and tell the user to start the loop with
  `/loop You are lethal-orchestrator. Follow docs/superpowers/runbooks/autonomy/orchestrator.md: run its start procedure if you have not done so in this session, then do one sweep.`
- `lethal-code`: read `lane.md` and follow its "On every start" section.

Report whether the other role is live, and its directory if not.
