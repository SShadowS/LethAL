# R766 follow-up probe: does AL state carry inside one serve daemon?

A SingleInstance counter codeunit (50760) and three test codeunits (50761-50763). `drive.ts` runs each test codeunit one-shot, then sends two identical multi-entry requests to ONE `al-runner serve` daemon and writes every row whole to `/coord/handoff/R-766/carryover/`.

    flock -n /coord/locks/heavy.<n> bun scripts/r766-probe/drive.ts

No alc build: al-runner reads the AL source. It needs the Microsoft packages (`R766_DEPS` overrides the default folder). Result and build: see the handoff README (answer: no carry, 2026-10-25, al-runner edge.20261024).
