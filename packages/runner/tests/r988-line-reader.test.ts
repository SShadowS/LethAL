import { describe, expect, test } from "bun:test";
import { LineReader } from "../src/al-runner-server";

/** A stream that yields exactly these byte chunks, then ends. */
function chunked(...parts: (string | Uint8Array)[]): AsyncIterable<Uint8Array> {
  const enc = new TextEncoder();
  return {
    async *[Symbol.asyncIterator]() {
      for (const p of parts) yield typeof p === "string" ? enc.encode(p) : p;
    },
  };
}

async function readAll(r: LineReader): Promise<string[]> {
  const out: string[] = [];
  for (;;) {
    const o = await r.next(5_000);
    if (o.kind !== "line") return [...out, o.kind];
    out.push(o.line);
  }
}

describe("R988: LineReader joins a line's pieces once, whatever the chunking", () => {
  test("a line split over many chunks, lines sharing a chunk, a line end on a chunk edge", async () => {
    const r = new LineReader(
      chunked('{"a":', "1", ',"b":2}\n{"c"', ":3}\n\n", '{"d":4}', "\n", "tail"),
    );
    expect(await readAll(r)).toEqual(['{"a":1,"b":2}', '{"c":3}', '{"d":4}', "eof"]);
  });

  test("a long line in small chunks comes back whole", async () => {
    const long = "x".repeat(100_000);
    const parts = Array.from({ length: 100 }, (_, i) => long.slice(i * 1000, (i + 1) * 1000));
    const r = new LineReader(chunked(...parts, "\nnext\n"));
    expect(await readAll(r)).toEqual([long, "next", "eof"]);
  });

  test("a multi-byte character split across two chunks decodes whole", async () => {
    const bytes = new TextEncoder().encode("æøå\n");
    const r = new LineReader(chunked(bytes.slice(0, 1), bytes.slice(1)));
    expect(await readAll(r)).toEqual(["æøå", "eof"]);
  });
});
