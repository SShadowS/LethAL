import { describe, expect, test } from "bun:test";
import type { ActivationConfig } from "../src/activation";
import { HarnessVerificationError, HarnessVerifier } from "../src/harness";

/**
 * R847 Part 1: `HarnessVerifier.fetchObjectOwners` / `fetchFieldOwners` against a fake fetch. The
 * control app that serves these actions is NOT published (Part 2), so this pins the client's strict
 * reading of the answer: one row per item read, in order, and anything else throws.
 */

const CFG: ActivationConfig = {
  baseUrl: "http://bc:7048/BC",
  company: "CRONUS",
  username: "u",
  password: "p",
  tenant: "default",
};
const X = "9e8d7c6b-5a49-4382-a1b0-c9d8e7f6a5b4";
const OWNER = { appId: X, appName: "Other App", appPublisher: "Elsewhere", appVersion: "2.0.0.0" };
const APP = { id: X, name: "Other App", publisher: "Elsewhere", version: "2.0.0.0" };

function fakeFetch(inner: unknown, status = 200) {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    return new Response(JSON.stringify({ value: JSON.stringify(inner) }), { status });
  }) as typeof fetch;
  return { calls, fetchFn };
}
const verifier = (f: { fetchFn: typeof fetch }) => new HarnessVerifier(CFG, f.fetchFn);
const ITEMS = [
  { kind: "Codeunit", id: 79291 },
  { kind: "Table", id: 50101 },
];

describe("R847 fetchObjectOwners", () => {
  test("posts ItemsJson and MaxMs to ObjectOwners and reads one row per item", async () => {
    const f = fakeFetch({
      read: 2,
      rows: [
        { kind: "Codeunit", id: 79291, outcome: "owner", ...OWNER, objectName: "Theirs" },
        { kind: "Table", id: 50101, outcome: "none" },
      ],
    });
    const got = await verifier(f).fetchObjectOwners(ITEMS, 8000, 8000);
    expect(got).toEqual({
      read: 2,
      rows: [
        { kind: "Codeunit", id: 79291, outcome: "owner", app: APP },
        { kind: "Table", id: 50101, outcome: "none" },
      ],
    });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe(
      "http://bc:7048/BC/ODataV4/LethALControl_ObjectOwners?company=CRONUS&tenant=default",
    );
    expect(JSON.parse(f.calls[0]?.body ?? "")).toEqual({
      ItemsJson: JSON.stringify(ITEMS),
      MaxMs: 8000,
    });
  });

  test("a short answer is returned as short (read below asked), never padded", async () => {
    const f = fakeFetch({
      read: 1,
      rows: [{ kind: "Codeunit", id: 79291, outcome: "unresolved" }],
    });
    const got = await verifier(f).fetchObjectOwners(ITEMS, 5, 5);
    expect(got.read).toBe(1);
    expect(got.rows).toHaveLength(1);
  });

  test("every answer that is not one row per item throws HarnessVerificationError", async () => {
    const good = { kind: "Codeunit", id: 79291, outcome: "none" };
    const bad: unknown[] = [
      {},
      { read: 2 },
      { read: 1, rows: [] },
      { read: 3, rows: [good, good, good] },
      { read: 1.5, rows: [good] },
      { read: -1, rows: [] },
      { read: "1", rows: [good] },
      { read: 1, rows: ["x"] },
      { read: 1, rows: [{ ...good, kind: "Page" }] },
      { read: 1, rows: [{ ...good, id: 1 }] },
      { read: 1, rows: [{ ...good, outcome: "clean" }] },
      { read: 1, rows: [{ ...good, outcome: "owner" }] },
      { read: 1, rows: [{ ...good, outcome: "owner", ...OWNER, appId: "nope" }] },
      { read: 1, rows: [{ ...good, outcome: "owner", ...OWNER, appVersion: 2 }] },
    ];
    for (const inner of bad) {
      const err = await verifier(fakeFetch(inner))
        .fetchObjectOwners(ITEMS, 5, 5)
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(HarnessVerificationError);
      expect((err as Error).message).toContain("ObjectOwners answered");
    }
  });

  test("an unknown outcome is refused as such even when the row carries a full app", async () => {
    const row = { kind: "Codeunit", id: 79291, outcome: "clean", ...OWNER };
    const err = await verifier(fakeFetch({ read: 1, rows: [row] }))
      .fetchObjectOwners(ITEMS.slice(0, 1), 5, 5)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect((err as Error).message).toContain('outcome "clean"');
  });

  test("a read above the number asked is refused as such, not by whatever follows", async () => {
    const good = { kind: "Codeunit", id: 79291, outcome: "none" };
    const err = await verifier(fakeFetch({ read: 3, rows: [good, good, good] }))
      .fetchObjectOwners(ITEMS, 5, 5)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect((err as Error).message).toContain("read 3 for 2 item(s)");
  });

  test("0 items, over 200, and a MaxMs or timeout not above 0 are refused before any request", async () => {
    const f = fakeFetch({ read: 0, rows: [] });
    const v = verifier(f);
    const many = Array.from({ length: 201 }, (_, i) => ({ kind: "Codeunit", id: i }));
    await expect(v.fetchObjectOwners([], 5, 5)).rejects.toThrow(/1 to 200/);
    await expect(v.fetchObjectOwners(many, 5, 5)).rejects.toThrow(/1 to 200/);
    await expect(v.fetchObjectOwners(ITEMS, 0, 5)).rejects.toThrow(/above 0/);
    await expect(v.fetchObjectOwners(ITEMS, 5, 0)).rejects.toThrow(/above 0/);
    await expect(v.fetchObjectOwners(ITEMS, 1.5, 5)).rejects.toThrow(/above 0/);
    expect(f.calls).toHaveLength(0);
  });

  test("200 items go in one call", async () => {
    const items = Array.from({ length: 200 }, (_, i) => ({ kind: "Codeunit", id: i }));
    const f = fakeFetch({
      read: 200,
      rows: items.map((i) => ({ ...i, outcome: "none" })),
    });
    expect((await verifier(f).fetchObjectOwners(items, 5, 5)).read).toBe(200);
  });

  test("the time left is the client's timeout, not the 30 s default", async () => {
    const hang = (async () => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const err = await new HarnessVerifier(CFG, hang).fetchObjectOwners(ITEMS, 5, 15).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HarnessVerificationError);
    expect((err as Error).message).toContain("ObjectOwners timed out after 15 ms");
  });

  test("a 404 (an older control app) is a plain failure, never a clean answer", async () => {
    const f = fakeFetch("no such action", 404);
    const err = await verifier(f)
      .fetchObjectOwners(ITEMS, 5, 5)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(HarnessVerificationError);
    expect((err as Error).message).toContain("HTTP 404");
  });
});

describe("R847 fetchFieldOwners", () => {
  const byId = { table: 18, id: 50000 };
  const byName = { table: 18, name: "New Field" };

  test("reads an owner row with its field and table names, by id and by name", async () => {
    const f = fakeFetch({
      read: 2,
      rows: [
        { ...byId, outcome: "owner", ...OWNER, fieldName: "Other", tableName: "Customer" },
        { ...byName, outcome: "none" },
      ],
    });
    const got = await verifier(f).fetchFieldOwners([byId, byName], 7000, 7000);
    expect(got.rows).toEqual([
      { ...byId, outcome: "owner", app: APP, fieldName: "Other", tableName: "Customer" },
      { ...byName, outcome: "none" },
    ]);
    expect(f.calls[0]?.url).toContain("LethALControl_FieldOwners");
    expect(JSON.parse(JSON.parse(f.calls[0]?.body ?? "").ItemsJson)).toEqual([byId, byName]);
  });

  test("a row for another item, an owner without its names, or a bad count throws", async () => {
    const bad: unknown[] = [
      { read: 1, rows: [{ table: 19, id: 50000, outcome: "none" }] },
      { read: 1, rows: [{ table: 18, id: 50001, outcome: "none" }] },
      { read: 1, rows: [{ table: 18, name: "New Field", outcome: "none" }] },
      { read: 1, rows: [{ ...byId, outcome: "owner", ...OWNER, tableName: "Customer" }] },
      { read: 1, rows: [{ ...byId, outcome: "owner", ...OWNER, fieldName: "A" }] },
      { read: 2, rows: [{ ...byId, outcome: "none" }] },
    ];
    for (const inner of bad) {
      const err = await verifier(fakeFetch(inner))
        .fetchFieldOwners([byId], 5, 5)
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(HarnessVerificationError);
      expect((err as Error).message).toContain("FieldOwners answered");
    }
    const nameBad = await verifier(
      fakeFetch({ read: 1, rows: [{ table: 18, name: "Other", outcome: "none" }] }),
    )
      .fetchFieldOwners([byName], 5, 5)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(nameBad).toBeInstanceOf(HarnessVerificationError);
  });
});
