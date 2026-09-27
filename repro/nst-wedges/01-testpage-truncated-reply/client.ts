// Repro 01 client. Runs N sessions; each session does W warm-up calls (passing test, small answer)
// then ONE arm call, all over one keep-alive socket, then checks $metadata and Ping for a wedge.
//
//   bun client.ts --arm testpage --sessions 10          # the failing arm
//   bun client.ts --arm control  --sessions 10          # passing test padded to the same size
//
// Options: --warmup 21  --timeout-ms 120000  --pad-to 6600  --stop-on-wedge 1
//
// The arm call is read from a raw TCP socket (not fetch), so the output can say whether the chunked
// terminator ("0\r\n\r\n") arrived and exactly how many body bytes did.
import net from "node:net";
import { AUTH, BC_URL, QUERY, arg, healthy, log, probeHealth } from "../common";

const SERVICE = "NstRepro01";
const arm = arg("arm", "testpage");
if (arm !== "testpage" && arm !== "control") throw new Error("--arm must be testpage or control");
const sessions = Number(arg("sessions", "10"));
const warmup = Number(arg("warmup", "21"));
const timeoutMs = Number(arg("timeout-ms", "120000"));
const padTo = Number(arg("pad-to", "6600"));
const stopOnWedge = arg("stop-on-wedge", "1") === "1";

const url = new URL(BC_URL);
const host = url.hostname;
const port = Number(url.port || "80");

interface RawResult {
  status?: number;
  headersMs?: number;
  transferEncoding?: string;
  contentLength?: string;
  wireBytes: number;
  bodyBytes: number;
  terminatorSeen: boolean;
  ending: "complete" | "timeout" | "socket-close" | "socket-error";
  ms: number;
  error?: string;
  bodyTail?: string;
}

/** One keep-alive HTTP/1.1 connection, one request at a time. Reconnects after any bad ending. */
class Conn {
  private sock: net.Socket | undefined;

  request(path: string, body: string, limitMs: number): Promise<RawResult> {
    let s = this.sock;
    if (s === undefined || s.destroyed) {
      s = net.connect(port, host);
      this.sock = s;
    }
    const sock = s;
    const head = [
      `POST ${path} HTTP/1.1`,
      `Host: ${url.host}`,
      `Authorization: ${AUTH}`,
      "Accept: application/json",
      "Content-Type: application/json",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "Connection: keep-alive",
      "\r\n",
    ].join("\r\n");
    return new Promise((resolve) => {
      const t0 = performance.now();
      const r: RawResult = {
        wireBytes: 0,
        bodyBytes: 0,
        terminatorSeen: false,
        ending: "socket-close",
        ms: 0,
      };
      let buf = Buffer.alloc(0);
      let bodyStart = -1;
      let pos = 0; // next unparsed byte (chunked)
      let partial = 0; // bytes of an unfinished chunk already received
      let partialAt = 0;
      let closeAfter = false;
      const parts: Buffer[] = [];
      let done = false;

      const finish = (ending: RawResult["ending"], error?: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        sock.off("data", onData);
        sock.off("close", onClose);
        sock.off("error", onError);
        r.ending = ending;
        r.ms = Math.round(performance.now() - t0);
        r.bodyBytes += partial;
        if (partial > 0) parts.push(buf.subarray(partialAt, partialAt + partial));
        if (error !== undefined) r.error = error;
        const text = Buffer.concat(parts).toString("utf8");
        r.bodyTail = text.slice(-120);
        if (ending !== "complete" || closeAfter) {
          sock.destroy();
          this.sock = undefined;
        }
        resolve(r);
      };

      const parse = () => {
        if (bodyStart < 0) {
          const i = buf.indexOf("\r\n\r\n");
          if (i < 0) return;
          r.headersMs = Math.round(performance.now() - t0);
          const lines = buf.toString("latin1", 0, i).split("\r\n");
          r.status = Number(lines[0]?.split(" ")[1]);
          for (const l of lines.slice(1)) {
            const [k, ...v] = l.split(":");
            const key = (k ?? "").trim().toLowerCase();
            const val = v.join(":").trim();
            if (key === "transfer-encoding") r.transferEncoding = val;
            if (key === "content-length") r.contentLength = val;
            if (key === "connection" && val.toLowerCase() === "close") closeAfter = true;
          }
          bodyStart = i + 4;
          pos = bodyStart;
        }
        if (r.transferEncoding?.toLowerCase().includes("chunked")) {
          for (;;) {
            const le = buf.indexOf("\r\n", pos);
            if (le < 0) return;
            const size = Number.parseInt(buf.toString("latin1", pos, le).split(";")[0] ?? "", 16);
            if (size === 0) {
              // Last chunk. No trailers expected, so the terminator is "0\r\n\r\n".
              if (buf.length >= le + 4) {
                r.terminatorSeen = true;
                finish("complete");
              }
              return;
            }
            if (buf.length < le + 2 + size + 2) {
              partial = Math.min(size, buf.length - (le + 2));
              partialAt = le + 2;
              return;
            }
            partial = 0;
            parts.push(buf.subarray(le + 2, le + 2 + size));
            r.bodyBytes += size;
            pos = le + 2 + size + 2;
          }
        }
        const got = buf.length - bodyStart;
        r.bodyBytes = got;
        parts.length = 0;
        parts.push(buf.subarray(bodyStart));
        if (r.contentLength !== undefined && got >= Number(r.contentLength)) finish("complete");
      };

      const onData = (chunk: Buffer) => {
        r.wireBytes += chunk.length;
        buf = Buffer.concat([buf, chunk]);
        parse();
      };
      const onClose = () => finish("socket-close");
      const onError = (e: Error) => finish("socket-error", String(e));
      const timer = setTimeout(() => finish("timeout"), limitMs);
      sock.on("data", onData);
      sock.on("close", onClose);
      sock.on("error", onError);
      sock.write(head + body);
    });
  }
}

const path = `${url.pathname.replace(/\/$/, "")}/ODataV4/${SERVICE}_RunTest${QUERY}`;
const testMethod = arm === "testpage" ? "OpenCardPage" : "Passes";
let lost = 0;

for (let s = 1; s <= sessions; s++) {
  const conn = new Conn();
  for (let w = 1; w <= warmup; w++) {
    const r = await conn.request(
      path,
      JSON.stringify({ testMethod: "Passes", padTo: 0 }),
      timeoutMs,
    );
    if (r.ending !== "complete") log({ session: s, warmup: w, ...r });
  }
  const r = await conn.request(path, JSON.stringify({ testMethod, padTo }), timeoutMs);
  const ok = r.ending === "complete" && r.status === 200;
  if (!ok) lost++;
  log({ session: s, arm, testMethod, ok, ...r });
  const health = await probeHealth(SERVICE);
  log({ session: s, check: "health", healthy: healthy(health), ...health });
  if (!healthy(health)) {
    log({
      session: s,
      verdict: "WEDGE: OData no longer answers. Restart the server tier or container.",
    });
    if (stopOnWedge) break;
  }
}
log({ summary: true, arm, sessions, lost });
process.exit(0);
