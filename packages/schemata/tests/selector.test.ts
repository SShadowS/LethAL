import { describe, expect, test } from "bun:test";
import {
  emitMutationActiveTable,
  emitMutationControl,
  emitMutationSelector,
  emitRegisterInstall,
  emitRegisterUpgrade,
  emitStaticSelector,
  emitWebServicesXml,
} from "../src/selector";

const cfg = {
  selectorId: 50000,
  controlId: 50001,
  tableId: 50002,
  artifactId: "fedcba9876543210fedcba9876543210",
};

// A target app id (the target project's own app.json `id`) — the first element of the
// (targetAppId, artifactId, mutantId) tuple the control extension keys its state on.
const TARGET = "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a";

describe("emitMutationActiveTable", () => {
  test("emits single-row table, cross-company", () => {
    const src = emitMutationActiveTable(cfg);
    expect(src).toContain('table 50002 "Mutation Active"');
    expect(src).toContain("DataPerCompany = false;");
    expect(src).toContain("field(1; PrimaryKey; Code[10])");
    expect(src).toContain("field(2; ActiveId; Text[64])");
  });
});

describe("emitMutationSelector", () => {
  test("delegates the active check to the LethAL Control extension", () => {
    // Task 4: the active-mutant state moved OUT of the target into the LethAL Control
    // extension. Active() is now a thin delegate to LC Control State.IsActive over the
    // full (targetAppId, artifactId, mutantId) tuple — it no longer owns a table, caches
    // nothing, and is not SingleInstance (the control extension holds all of that).
    const src = emitMutationSelector({ ...cfg, targetAppId: TARGET });
    expect(src).toContain('codeunit 50000 "Mutation Selector"');
    expect(src).toContain("procedure Active(MutantId: Text): Boolean");
    expect(src).toContain('ControlState: Codeunit "LC Control State"');
    expect(src).toContain(
      `exit(ControlState.IsActive('${TARGET}', '${cfg.artifactId}', MutantId));`,
    );
    // The old in-target state surface is gone — the control extension owns it now.
    expect(src).not.toContain("SingleInstance = true;");
    expect(src).not.toContain('Record "Mutation Active"');
    expect(src).not.toContain("CachedId");
  });

  test("still exposes ArtifactId (the target's baked identity)", () => {
    const src = emitMutationSelector({ ...cfg, targetAppId: TARGET });
    expect(src).toContain("procedure ArtifactId(): Text");
    expect(src).toContain(`exit('${cfg.artifactId}')`);
  });
});

describe("emitRegisterInstall", () => {
  test("emits an Install codeunit that reads identity from the selector, not from args", () => {
    // The freed controlId (the in-target Mutation Control is gone) becomes this Install
    // codeunit's object id. On install it registers (targetAppId -> artifactId) so
    // RunMutant's artifact guard can read the deployed artifact without depending on the target.
    // Task 8: identity is read from `Mutation Selector` (single-sourced) instead of being
    // passed in as separate args, so registration can never diverge from what `Active` uses.
    const src = emitRegisterInstall({ objectId: cfg.controlId });
    expect(src).toContain('codeunit 50001 "Mutation Register"');
    expect(src).toContain("Subtype = Install;");
    expect(src).toContain("trigger OnInstallAppPerCompany()");
    expect(src).toContain('State: Codeunit "LC Control State"');
    expect(src).toContain('Selector: Codeunit "Mutation Selector"');
    expect(src).toContain("State.RegisterArtifact(Selector.TargetAppId(), Selector.ArtifactId());");
    expect(src).not.toContain(TARGET);
    expect(src).not.toContain(cfg.artifactId);
  });
});

describe("emitMutationControl", () => {
  test("writes the table, commits, echoes the id", () => {
    const src = emitMutationControl(cfg);
    expect(src).toContain('codeunit 50001 "Mutation Control"');
    expect(src).toContain("procedure SetActive(MutantId: Text): Text");
    expect(src).toContain("procedure ClearActive()");
    expect(src).toContain("Commit();");
    expect(src).toContain("exit(MutantId);");
  });
});

describe("emitStaticSelector", () => {
  test("hardcodes the active id for in-memory backends", () => {
    const src = emitStaticSelector({
      objectId: 50000,
      activeId: "M0007",
      artifactId: cfg.artifactId,
      targetAppId: TARGET,
    });
    expect(src).toContain('codeunit 50000 "Mutation Selector"');
    expect(src).toContain("exit(MutantId = 'M0007');");
  });
  test("empty id means always inactive", () => {
    const src = emitStaticSelector({
      objectId: 50000,
      activeId: "",
      artifactId: cfg.artifactId,
      targetAppId: TARGET,
    });
    expect(src).toContain("exit(false);");
  });
});

describe("emitWebServicesXml", () => {
  test("exposes Mutation Control as a web service", () => {
    const xml = emitWebServicesXml(cfg);
    // "CodeUnit" (capital U) — verified against the AL compiler's embedded
    // TenantWebServicesV1.xsd and the AL extension's own "twebservices" snippet; the
    // lowercase "Codeunit" this used to assert doesn't validate and gets silently dropped.
    expect(xml).toContain("<ObjectType>CodeUnit</ObjectType>");
    expect(xml).toContain("<ObjectID>50001</ObjectID>");
    expect(xml).toContain("<ServiceName>MutationControl</ServiceName>");
    expect(xml).toContain("<Published>true</Published>");
  });
});

const IDS = { selectorId: 79000, controlId: 79001, tableId: 79002 };
const ARTIFACT = "0123456789abcdef0123456789abcdef";

describe("artifact identity parity", () => {
  test("the generated selector exposes ArtifactId", () => {
    const al = emitMutationSelector({ ...IDS, artifactId: ARTIFACT, targetAppId: TARGET });
    expect(al).toContain("procedure ArtifactId(): Text");
    expect(al).toContain(`exit('${ARTIFACT}')`);
  });

  test("the STATIC selector exposes ArtifactId too, or al-runner activation breaks the next compile", () => {
    const al = emitStaticSelector({
      objectId: 79000,
      activeId: "M0001",
      artifactId: ARTIFACT,
      targetAppId: TARGET,
    });
    expect(al).toContain("procedure ArtifactId(): Text");
    expect(al).toContain(`exit('${ARTIFACT}')`);
  });

  test("both emitters expose the same procedure set", () => {
    const procs = (al: string) => [...al.matchAll(/procedure (\w+)/g)].map((m) => m[1]).sort();
    expect(
      procs(
        emitStaticSelector({
          objectId: 79000,
          activeId: "",
          artifactId: ARTIFACT,
          targetAppId: TARGET,
        }),
      ),
    ).toEqual(procs(emitMutationSelector({ ...IDS, artifactId: ARTIFACT, targetAppId: TARGET })));
  });

  test("MutationControl exposes Identity, reachable as MutationControl_Identity", () => {
    const al = emitMutationControl(IDS);
    expect(al).toContain("procedure Identity(): Text");
    expect(al).toContain("MutationSelector.ArtifactId()");
  });
});

describe("selector single-sourced identity", () => {
  const IDS = { selectorId: 79199, controlId: 79198, tableId: 79197 };
  const APP = "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a";
  const ART = "0123456789abcdef0123456789abcdef";

  test("dynamic selector exposes Active, ArtifactId, TargetAppId", () => {
    const al = emitMutationSelector({ ...IDS, artifactId: ART, targetAppId: APP });
    expect(al).toContain("procedure TargetAppId(): Text");
    expect(al).toContain(`exit('${APP}')`);
    expect(al).toContain(`ControlState.IsActive('${APP}', '${ART}', MutantId)`);
  });

  test("static selector exposes the identical procedure set", () => {
    const dyn = emitMutationSelector({ ...IDS, artifactId: ART, targetAppId: APP });
    const stat = emitStaticSelector({
      objectId: IDS.selectorId,
      activeId: "",
      artifactId: ART,
      targetAppId: APP,
    });
    for (const proc of ["procedure Active(", "procedure ArtifactId(", "procedure TargetAppId("]) {
      expect(dyn).toContain(proc);
      expect(stat).toContain(proc);
    }
  });

  test("install registers identity read from the selector, not from args", () => {
    const al = emitRegisterInstall({ objectId: IDS.controlId });
    expect(al).toContain("Subtype = Install");
    expect(al).toContain('Selector: Codeunit "Mutation Selector"');
    expect(al).toContain("State.RegisterArtifact(Selector.TargetAppId(), Selector.ArtifactId())");
    expect(al).not.toContain(APP); // identity is NOT baked here anymore
  });

  test("upgrade registers the same way on OnUpgradePerCompany, using tableId object id", () => {
    const al = emitRegisterUpgrade({ objectId: IDS.tableId });
    expect(al).toContain(`codeunit ${IDS.tableId} "Mutation Upgrade"`);
    expect(al).toContain("Subtype = Upgrade");
    expect(al).toContain("trigger OnUpgradePerCompany()");
    expect(al).toContain("State.RegisterArtifact(Selector.TargetAppId(), Selector.ArtifactId())");
  });
});
