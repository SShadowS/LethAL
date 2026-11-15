# PR-38 pre-commitment: impact of four open wrong-answer classes on stored results (2026-11-15)

Written before any count for this question. Method as PR-35 (R1048): over PR-15's 84 BC.History projects (R-975's list plus
Guided Experience) and DO's test app, each project's stored al-runner run. A kill "rests on" a test when its killing test is that
test (joined on the method name, with PR-35's ambiguity guard). A class is **material** in a project when the kills resting on its
at-risk tests are over 1% of that project's kills. Only then is a PR-36-style label proposed.

## The four classes and their predicates
- **#8157** (al-runner fails `XmlElement.AsXmlNode()` on an untouched element; BC passes it):
  - *direct evidence:* a stored baseline failure or killing-test failure whose text is al-runner's own for this call, read off
    the u8157 repro on edge-5a58a0f16 before counting;
  - *by parse:* `AsXmlNode` call sites on an XmlElement variable, in the app and in the test app (context only; whether the element
    is untouched is not decided).
  - A baseline failure with the text is a test BC would pass; a kill with it is a kill BC would not make.
- **#8158** (a read of the `Session` table under Permissions Mock returns on al-runner; on BC's web-service path it fails):
  - in a project that installs the mock, a test that reads a `Record Session` (Get, Find*, IsEmpty, Count, CalcFields, Next) in
    its own codeunit (same-codeunit procedures followed, PR-36's walk);
  - app-code reads of `Session` are counted as sites (context).
- **#8152** (BC keeps the numbers `NumberSequence.Next` handed out across a rollback; al-runner undoes them):
  - a test whose own codeunit calls `NumberSequence.*`;
  - app-code `NumberSequence` sites are counted per project (context: such a project's tests can read a sequence another
    codeunit advanced).
- **#8154** (under `--no-client`, al-runner never calls a bound Confirm, StrMenu, Message, SendNotification, RecallNotification or
  Hyperlink handler, and lets an unhandled Message pass; BC calls them):
  - only stored runs whose report says `noClient: true` (the default is off);
  - a test whose `[HandlerFunctions]` names a procedure carrying one of those handler attributes.

## Predictions
- #8157: no project material; at most a handful of stored rows carry the text.
- #8158: no project material.
- #8152: material in No. Series only, if anywhere; elsewhere 0.
- #8154: material in at least one of the noClient runs that has handler-binding tests.

## What follows
Each class's counts go into its roadmap item (R1038/#8152, R1045/#8157 and #8158, R1039/#8154), or into a new item if none fits.
A label is proposed (not built) only for a material class, as a coord task with the counts.
