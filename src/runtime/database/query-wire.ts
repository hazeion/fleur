import { connect, type Socket } from "node:net";
import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

const int16 = (value: number) => { const bytes = Buffer.alloc(2); bytes.writeInt16BE(value); return bytes; };
const int32 = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeInt32BE(value); return bytes; };
const cstring = (value: string) => Buffer.from(value + "\0");
const message = (type: string, ...parts: Buffer[]) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from(type), int32(body.length + 4), body]); };
export interface WireColumn { readonly name: string; readonly oid: number; readonly modifier: number }
export interface WireResult { readonly columns: WireColumn[]; readonly rows: (string | null)[][]; readonly truncated: boolean }
export class PostgresQueryError extends Error {
  readonly fields: Record<string, string>;
  constructor(body: Buffer) {
    const fields: Record<string, string> = {};
    for (let offset = 0; offset < body.length && body[offset];) {
      const key = String.fromCharCode(body[offset++]!), end = body.indexOf(0, offset);
      if (end < offset) break;
      fields[key] = body.toString("utf8", offset, end); offset = end + 1;
    }
    super(fields.M ?? "PostgreSQL rejected the statement."); this.fields = fields;
  }
}
/**
 * A fresh development-only PostgreSQL 18 session. Bun SQL selects binary codecs and omits RowDescription metadata;
 * this small text-protocol adapter preserves duplicate names, type OIDs and exact PostgreSQL output strings.
 * It accepts only loopback endpoints from verified Docker ownership, SCRAM-SHA-256 and extended-protocol queries.
 */
export class QueryWire {
  readonly #socket: Socket;
  #buffer = Buffer.alloc(0);
  #wake: (() => void) | undefined;
  #failure: Error | undefined;
  backend: number | undefined;
  private constructor(socket: Socket) {
    this.#socket = socket;
    socket.on("data", bytes => { socket.pause(); this.#buffer = Buffer.concat([this.#buffer, typeof bytes === "string" ? Buffer.from(bytes) : bytes]); this.#wake?.(); });
    socket.on("error", () => { this.#failure = new Error("DATABASE_UNAVAILABLE"); this.#wake?.(); });
    socket.on("close", () => { this.#failure ??= new Error("DATABASE_UNAVAILABLE"); this.#wake?.(); });
  }
  close() { this.#socket.destroy(); }
  async #bytes(size: number): Promise<Buffer> {
    while (this.#buffer.length < size) {
      if (this.#failure) throw this.#failure;
      await new Promise<void>(resolve => { this.#wake = resolve; this.#socket.resume(); });
      this.#wake = undefined;
    }
    const result = this.#buffer.subarray(0, size); this.#buffer = this.#buffer.subarray(size); return result;
  }
  async #frame(maximum: number): Promise<{ type: string; body: Buffer | null }> {
    const header = await this.#bytes(5), type = String.fromCharCode(header[0]!), size = header.readInt32BE(1) - 4;
    if (size < 0 || size > 1073741824) throw new Error("DATABASE_UNAVAILABLE");
    if (size <= maximum) return { type, body: await this.#bytes(size) };
    // Drain oversized rows without buffering a whole PostgreSQL value. The caller reports truncation.
    for (let remaining = size; remaining > 0;) { const amount = Math.min(remaining, 65536); await this.#bytes(amount); remaining -= amount; }
    return { type, body: null };
  }
  static async open(url: URL, register: (session: QueryWire) => void): Promise<QueryWire> {
    if (url.hostname !== "127.0.0.1") throw new Error("DATABASE_UNAVAILABLE");
    const socket = connect({ host: url.hostname, port: Number(url.port) });
    const wire = new QueryWire(socket); register(wire);
    const startup = Buffer.concat([int32(196608), cstring("user"), cstring(decodeURIComponent(url.username)), cstring("database"), cstring(url.pathname.slice(1)), cstring("client_encoding"), cstring("UTF8"), Buffer.from([0])]);
    socket.write(Buffer.concat([int32(startup.length + 4), startup]));
    let first = "", expected = Buffer.alloc(0), serverVerified = false;
    const nonce = randomBytes(24).toString("base64");
    for (;;) {
      const { type, body } = await wire.#frame(65536);
      if (!body) throw new Error("DATABASE_UNAVAILABLE");
      if (type === "E") throw new Error("DATABASE_UNAVAILABLE");
      if (type === "K") wire.backend = body.readInt32BE(0);
      if (type === "R") {
        const method = body.readInt32BE(0);
        if (method === 10) {
          if (!body.subarray(4).toString().split("\0").includes("SCRAM-SHA-256")) throw new Error("DATABASE_UNAVAILABLE");
          first = `n=,r=${nonce}`;
          const initial = Buffer.from(`n,,${first}`);
          socket.write(message("p", cstring("SCRAM-SHA-256"), int32(initial.length), initial));
        } else if (method === 11) {
          const challenge = body.subarray(4).toString(), fields = Object.fromEntries(challenge.split(",").map(part => [part.slice(0, 1), part.slice(2)]));
          const iterations = Number(fields.i);
          if (!fields.r?.startsWith(nonce) || fields.r.length <= nonce.length || !fields.s || !Number.isInteger(iterations) || iterations < 4096 || iterations > 1000000 || fields.m) throw new Error("DATABASE_UNAVAILABLE");
          const salted = pbkdf2Sync(decodeURIComponent(url.password).normalize("NFKC"), Buffer.from(fields.s, "base64"), iterations, 32, "sha256");
          const hmac = (key: Buffer, value: string) => createHmac("sha256", key).update(value).digest();
          const clientKey = hmac(salted, "Client Key"), stored = createHash("sha256").update(clientKey).digest();
          const final = `c=biws,r=${fields.r}`, auth = `${first},${challenge},${final}`, signature = hmac(stored, auth);
          expected = hmac(hmac(salted, "Server Key"), auth);
          const proof = Buffer.from(clientKey.map((byte, index) => byte ^ signature[index]!)).toString("base64");
          socket.write(message("p", Buffer.from(`${final},p=${proof}`)));
        } else if (method === 12) {
          const verification = Buffer.from(body.subarray(4).toString().slice(2), "base64");
          if (!expected.length || verification.length !== expected.length || !timingSafeEqual(expected, verification)) throw new Error("DATABASE_UNAVAILABLE");
          serverVerified = true;
        } else if (method !== 0 || !serverVerified) throw new Error("DATABASE_UNAVAILABLE");
      }
      if (type === "Z") { if (!serverVerified || wire.backend === undefined) throw new Error("DATABASE_UNAVAILABLE"); return wire; }
    }
  }
  async query(sql: string, params: readonly string[] = [], maximumBytes = 1044480): Promise<WireResult> {
    // Explicit text parameter OIDs and text result format, even with no application parameters.
    const values = params.map(value => { const bytes = Buffer.from(value); return Buffer.concat([int32(bytes.length), bytes]); });
    this.#socket.write(Buffer.concat([
      message("P", cstring(""), cstring(sql), int16(params.length), ...params.map(() => int32(25))),
      message("B", cstring(""), cstring(""), int16(0), int16(params.length), ...values, int16(0)),
      message("D", Buffer.from("P"), cstring("")), message("E", cstring(""), int32(0)), message("S"),
    ]));
    const columns: WireColumn[] = [], rows: (string | null)[][] = [];
    let bytes = 2, truncated = false, error: PostgresQueryError | undefined;
    for (;;) {
      const { type, body } = await this.#frame(Math.max(65536, maximumBytes));
      if (!body) { if (type !== "D") throw new Error("DATABASE_UNAVAILABLE"); truncated = true; continue; }
      if (type === "E") error = new PostgresQueryError(body);
      if (type === "T") {
        for (let index = 0, offset = 2; index < body.readInt16BE(0); index++) {
          const end = body.indexOf(0, offset), name = body.toString("utf8", offset, end); offset = end + 1;
          columns.push({ name, oid: body.readUInt32BE(offset + 6), modifier: body.readInt32BE(offset + 12) }); offset += 18;
        }
      }
      if (type === "D" && !truncated) {
        const row: (string | null)[] = [];
        for (let index = 0, offset = 2; index < body.readInt16BE(0); index++) {
          const size = body.readInt32BE(offset); offset += 4;
          row.push(size === -1 ? null : body.toString("utf8", offset, offset + size)); if (size !== -1) offset += size;
        }
        const size = Buffer.byteLength(JSON.stringify(row)) + 1;
        if (bytes + size > maximumBytes) truncated = true;
        else { rows.push(row); bytes += size; }
      }
      if (type === "Z") { if (error) throw error; return { columns, rows, truncated }; }
    }
  }
}
