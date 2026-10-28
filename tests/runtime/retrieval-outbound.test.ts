import { afterAll, beforeAll, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema } from "../../src/schema";
import { classifyAddress, type AddressClass } from "../../src/runtime/retrieval/addresses";
import { RetrievalError, type DestinationDefinition } from "../../src/runtime/retrieval/destinations";
import { OutboundBroker, type RetrievalConfiguration } from "../../src/runtime/retrieval/outbound";

// Controlled local fixtures stand in for external providers; no test reaches the internet.
const secret = "fixture-credential-7f3a9c";
const hits = new Map<string, number>();
const seen: { authorization?: string | null; host?: string | null; query?: string }[] = [];
let server: ReturnType<typeof Bun.serve>, tlsServer: ReturnType<typeof Bun.serve>, certificate = "", certificates = "";
const hit = (path: string) => hits.set(path, (hits.get(path) ?? 0) + 1);
const never = () => new Promise<never>(() => {});
beforeAll(async () => {
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(request) {
    const url = new URL(request.url);
    hit(url.pathname);
    seen.push({ authorization: request.headers.get("authorization"), host: request.headers.get("host"), query: url.search });
    if (url.pathname.startsWith("/v1/items/")) return Response.json({ id: decodeURIComponent(url.pathname.slice(10)), name: "Item", internal: "server-only-field", nested: { visible: 1, hidden: 2 } }, { headers: { etag: '"v1"', "set-cookie": "session=1", "x-private": "no" } });
    if (url.pathname === "/redirect") return new Response(null, { status: 302, headers: { location: "/v1/items/redirected" } });
    if (url.pathname === "/status") return new Response("unavailable " + secret, { status: 503 });
    if (url.pathname === "/slow-headers") return never();
    if (url.pathname === "/slow-body") return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"id":')); } }));
    if (url.pathname === "/chunked") return new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(65536).fill(32)); } }));
    if (url.pathname === "/declared") return new Response("x".repeat(2 * 1048576), { headers: { "content-type": "application/json" } });
    if (url.pathname === "/bomb") return new Response(new ReadableStream({ start(controller) { controller.enqueue(gzipSync(new Uint8Array(32 * 1048576).fill(32))); controller.close(); } }), { headers: { "content-encoding": "gzip" } });
    if (url.pathname === "/text") return new Response("<html>not json</html>");
    if (url.pathname === "/missing") return Response.json({ id: "1" });
    if (url.pathname === "/echo") return Response.json({ id: "1", name: request.headers.get("authorization") ?? url.searchParams.get("appid") ?? "none" });
    if (url.pathname === "/large-ok") return Response.json({ id: "1", name: "small", internal: "n".repeat(1_500_000) });
    if (url.pathname === "/large-selected") return Response.json({ id: "1", name: "n".repeat(1_500_000) });
    return new Response("not found", { status: 404 });
  } });
  const directory = await mkdtemp(join(tmpdir(), "fleur-retrieval-tls-"));
  try {
    const openssl = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem"), "-days", "2", "-subj", "/CN=api.example.test", "-addext", "subjectAltName=DNS:api.example.test"], { stderr: "pipe" });
    if (openssl.exitCode !== 0) throw new Error("openssl failed");
    certificate = await readFile(join(directory, "cert.pem"), "utf8");
    tlsServer = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { key: await readFile(join(directory, "key.pem"), "utf8"), cert: certificate }, fetch(request) { hit("tls:" + new URL(request.url).pathname); return Response.json({ id: "tls", name: request.headers.get("host") }); } });
    certificates = certificate;
  } finally { await rm(directory, { recursive: true, force: true }); }
});
afterAll(async () => { await server?.stop(true); await tlsServer?.stop(true); });

const item = schema.object({ id: schema.string(), name: schema.string(), nested: schema.object({ visible: schema.number() }).optional() });
const destination = (origin: string, path: string, extra: Partial<DestinationDefinition> = {}): DestinationDefinition => ({ origin, path, response: item, headers: [], ...extra });
const local = () => `http://fixture.invalid:${server.port}`;
function broker(destinations: Record<string, DestinationDefinition>, configuration: RetrievalConfiguration = {}) {
  return new OutboundBroker(new Map(Object.entries(destinations)), { localServices: [local()], resolveHost: async host => host === "fixture.invalid" ? ["127.0.0.1"] : [], ...configuration });
}
async function failure(work: Promise<unknown>): Promise<RetrievalError> {
  const error = await work.then(() => undefined, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(RetrievalError);
  return error as RetrievalError;
}
const get = (name: string, params: Record<string, string> = {}, query: Record<string, string> = {}) => ({ destination: name, method: "GET", params, query });

test("addresses are classified before any connection is admitted", () => {
  const table: Record<string, AddressClass> = {
    "93.184.215.14": "public", "2606:2800:21f:cb07:6820:80da:af6b:8b2c": "public",
    "127.0.0.1": "loopback", "::1": "loopback", "10.1.2.3": "private", "172.20.0.1": "private", "192.168.1.1": "private", "100.64.0.1": "private", "fd12::1": "private",
    "169.254.169.254": "metadata", "fd00:ec2::254": "metadata", "100.100.100.200": "metadata", "169.254.1.1": "link-local", "fe80::1": "link-local",
    "0.0.0.0": "reserved", "::": "reserved", "224.0.0.1": "reserved", "255.255.255.255": "reserved", "198.51.100.7": "reserved", "2001:db8::1": "reserved",
    "::ffff:127.0.0.1": "loopback", "::ffff:169.254.169.254": "metadata", "64:ff9b::a00:1": "private", "2002:7f00:1::": "reserved",
  };
  expect(Object.fromEntries(Object.keys(table).map(address => [address, classifyAddress(address)]))).toEqual(table);
});

test("a declared destination returns only selected public fields over the pinned, validated address", async () => {
  const resolved: string[] = [];
  const outbound = broker({ items: destination(local(), "/v1/items/:id", { headers: ["etag"] }) }, { resolveHost: async host => { resolved.push(host); return ["127.0.0.1"]; } });
  const result = await outbound.request(get("items", { id: "a/b c" }, { lang: "en" }), outbound.deadline());
  expect(result).toEqual({ status: 200, headers: { etag: '"v1"' }, body: { id: "a/b c", name: "Item", nested: { visible: 1 } } });
  expect(JSON.stringify(result)).not.toContain("server-only-field");
  // fixture.invalid cannot resolve through system DNS: the request reached the
  // fixture only through the single admitted address, with the declared Host.
  expect(resolved).toEqual(["fixture.invalid"]);
  expect(seen.at(-1)).toMatchObject({ host: `fixture.invalid:${server.port}`, query: "?lang=en" });
});

test("undeclared destinations, methods, parameters and URL credentials are denied without a request", async () => {
  const outbound = broker({ items: destination(local(), "/v1/items/:id") });
  const before = hits.get("/v1/items/x") ?? 0;
  for (const request of [
    get("other", { id: "x" }), { ...get("items", { id: "x" }), method: "POST" }, get("items"), get("items", { id: "x", extra: "y" }),
    get("items", { id: ".." }), { ...get("items", { id: "x" }), url: "http://127.0.0.1/" }, get("items", { id: "x" }, { ["bad key"]: "v" }),
  ]) expect((await failure(outbound.request(request, outbound.deadline()))).code).toBe("RETRIEVAL_DESTINATION_DENIED");
  expect(hits.get("/v1/items/x") ?? 0).toBe(before);
  for (const origin of ["https://user:pass@api.example.test", "https://api.example.test/path", "https://api.example.test?x=1", "ftp://api.example.test", "https://API.example.test"]) {
    expect(() => broker({ bad: destination(origin, "/") })).toThrow();
  }
});

test("plain HTTP is denied unless the exact local service is declared in trusted configuration", async () => {
  const before = hits.get("/v1/items/plain") ?? 0;
  const outbound = broker({ plain: destination(`http://fixture.invalid:${server.port}`, "/v1/items/:id") }, { localServices: [] });
  expect((await failure(outbound.request(get("plain", { id: "plain" }), outbound.deadline()))).code).toBe("RETRIEVAL_DESTINATION_DENIED");
  const otherPort = broker({ plain: destination(`http://fixture.invalid:${server.port}`, "/v1/items/:id") }, { localServices: [`http://fixture.invalid:${server.port! + 1}`] });
  expect((await failure(otherPort.request(get("plain", { id: "plain" }), otherPort.deadline()))).code).toBe("RETRIEVAL_DESTINATION_DENIED");
  expect(hits.get("/v1/items/plain") ?? 0).toBe(before);
});

test("DNS answers naming loopback, private, link-local or metadata addresses are denied at connection admission", async () => {
  const before = hits.get("tls:/") ?? 0;
  for (const answer of [["127.0.0.1"], ["93.184.215.14", "10.0.0.1"], ["::1"], ["::ffff:127.0.0.1"], ["169.254.169.254"]]) {
    const outbound = broker({ api: destination(`https://api.example.test:${tlsServer.port}`, "/") }, { resolveHost: async () => answer, certificateAuthorities: [certificates] });
    expect((await failure(outbound.request(get("api"), outbound.deadline()))).code).toBe("RETRIEVAL_DESTINATION_DENIED");
  }
  // Even the exact local exception never admits link-local or metadata addresses.
  const metadata = broker({ items: destination(local(), "/v1/items/:id") }, { resolveHost: async () => ["169.254.169.254"] });
  expect((await failure(metadata.request(get("items", { id: "m" }), metadata.deadline()))).code).toBe("RETRIEVAL_DESTINATION_DENIED");
  expect(hits.get("tls:/") ?? 0).toBe(before);
});

test("HTTPS verifies the declared hostname on the pinned connection", async () => {
  const origin = `https://api.example.test:${tlsServer.port}`;
  const trusted = broker({ api: destination(origin, "/") }, { localServices: [origin], resolveHost: async () => ["127.0.0.1"], certificateAuthorities: [certificates] });
  expect((await trusted.request(get("api"), trusted.deadline())).body).toEqual({ id: "tls", name: `api.example.test:${tlsServer.port}` });
  const untrusted = broker({ api: destination(origin, "/") }, { localServices: [origin], resolveHost: async () => ["127.0.0.1"] });
  expect((await failure(untrusted.request(get("api"), untrusted.deadline()))).code).toBe("RETRIEVAL_TRANSPORT_FAILURE");
  const wrongName = `https://other.example.test:${tlsServer.port}`;
  const mismatch = broker({ api: destination(wrongName, "/") }, { localServices: [wrongName], resolveHost: async () => ["127.0.0.1"], certificateAuthorities: [certificates] });
  expect((await failure(mismatch.request(get("api"), mismatch.deadline()))).code).toBe("RETRIEVAL_TRANSPORT_FAILURE");
});

test("redirects are never followed and HTTP and transport failures stay distinct", async () => {
  const outbound = broker({ redirect: destination(local(), "/redirect"), status: destination(local(), "/status"), closed: destination("http://closed.invalid:9", "/") }, { localServices: [local(), "http://closed.invalid:9"] });
  const before = hits.get("/v1/items/redirected") ?? 0;
  const redirect = await failure(outbound.request(get("redirect"), outbound.deadline()));
  expect([redirect.code, redirect.details]).toEqual(["RETRIEVAL_REDIRECT_DENIED", { status: 302 }]);
  expect(hits.get("/v1/items/redirected") ?? 0).toBe(before);
  const status = await failure(outbound.request(get("status"), outbound.deadline()));
  expect([status.code, status.details]).toEqual(["RETRIEVAL_HTTP_FAILURE", { status: 503 }]);
  const closed = broker({ closed: destination("http://closed.invalid:9", "/") }, { localServices: ["http://closed.invalid:9"], resolveHost: async () => ["127.0.0.1"] });
  expect((await failure(closed.request(get("closed"), closed.deadline()))).code).toBe("RETRIEVAL_TRANSPORT_FAILURE");
});

for (let repeat = 1; repeat <= 2; repeat++) test(`one whole-operation deadline covers DNS, response headers and body, repeat ${repeat}`, async () => {
  const outbound = broker({ headers: destination(local(), "/slow-headers"), body: destination(local(), "/slow-body") }, { timeoutMs: 600 });
  for (const name of ["headers", "body"]) {
    const started = performance.now();
    expect((await failure(outbound.request(get(name), outbound.deadline()))).code).toBe("RETRIEVAL_TIMEOUT");
    expect(performance.now() - started).toBeGreaterThanOrEqual(550);
    expect(performance.now() - started).toBeLessThan(1500);
  }
  const dns = broker({ items: destination(local(), "/v1/items/:id") }, { timeoutMs: 600, resolveHost: never });
  const started = performance.now();
  expect((await failure(dns.request(get("items", { id: "d" }), dns.deadline()))).code).toBe("RETRIEVAL_TIMEOUT");
  expect(performance.now() - started).toBeLessThan(1500);
  // A deadline already consumed by queueing leaves nothing for the request.
  expect((await failure(dns.request(get("items", { id: "d" }), performance.now() - 1))).code).toBe("RETRIEVAL_TIMEOUT");
}, 10_000);

test("decoded streaming bytes are bounded before parsing, with or without Content-Length", async () => {
  const outbound = broker({ chunked: destination(local(), "/chunked"), declared: destination(local(), "/declared"), bomb: destination(local(), "/bomb"), large: destination(local(), "/large-ok") });
  for (const name of ["chunked", "declared", "bomb", "large"]) expect((await failure(outbound.request(get(name), outbound.deadline()))).code).toBe("RETRIEVAL_TOO_LARGE");
  // A raised limit admits a large provider document; only selected public data
  // crosses to application code, under the 1 MiB public value bound.
  const raised = broker({ large: destination(local(), "/large-ok"), selected: destination(local(), "/large-selected") }, { maxBytes: 2 * 1048576 });
  expect((await raised.request(get("large"), raised.deadline())).body).toEqual({ id: "1", name: "small" });
  expect((await failure(raised.request(get("selected"), raised.deadline()))).code).toBe("RETRIEVAL_TOO_LARGE");
});

test("non-JSON and schema-mismatched responses are invalid output", async () => {
  const outbound = broker({ text: destination(local(), "/text"), missing: destination(local(), "/missing") });
  for (const name of ["text", "missing"]) expect((await failure(outbound.request(get(name), outbound.deadline()))).code).toBe("RETRIEVAL_INVALID_OUTPUT");
});

test("HEAD returns only declared metadata and no body", async () => {
  const outbound = broker({ items: destination(local(), "/v1/items/:id", { headers: ["etag"] }) });
  expect(await outbound.request({ ...get("items", { id: "h" }), method: "HEAD" }, outbound.deadline())).toEqual({ status: 200, headers: { etag: '"v1"' } });
  expect(() => broker({ items: destination(local(), "/v1/items/:id", { headers: ["set-cookie"] }) })).toThrow();
});

test("the broker attaches a bound credential only to its own origin and never discloses it", async () => {
  const bound = { origin: local(), header: "authorization", value: `Bearer ${secret}` };
  const outbound = broker({ items: destination(local(), "/v1/items/:id", { credential: "fixture" }), echo: destination(local(), "/echo", { credential: "fixture" }), status: destination(local(), "/status", { credential: "fixture" }) }, { credentials: { fixture: bound } });
  const result = await outbound.request(get("items", { id: "c" }), outbound.deadline());
  expect(seen.at(-1)?.authorization).toBe(`Bearer ${secret}`);
  expect(JSON.stringify(result)).not.toContain(secret);
  // A provider that echoes the secret cannot return it to application code.
  const echoed = await failure(outbound.request(get("echo"), outbound.deadline()));
  expect(echoed.code).toBe("RETRIEVAL_INVALID_OUTPUT");
  const status = await failure(outbound.request(get("status"), outbound.deadline()));
  for (const error of [echoed, status]) expect(JSON.stringify([error.message, error.details, error.stack, Object.entries(error)])).not.toContain(secret);
  // Undeclared destinations never receive the credential.
  const plain = broker({ items: destination(local(), "/v1/items/:id") }, { credentials: { fixture: bound } });
  await plain.request(get("items", { id: "p" }), plain.deadline());
  expect(seen.at(-1)?.authorization).toBeNull();
  const query = broker({ echo: destination(local(), "/echo", { credential: "key" }), items: destination(local(), "/v1/items/:id", { credential: "key" }) }, { credentials: { key: { origin: local(), query: "appid", value: secret } } });
  await query.request(get("items", { id: "q" }), query.deadline());
  expect(seen.at(-1)?.query).toBe(`?appid=${secret}`);
  expect((await failure(query.request(get("items", { id: "q" }, { appid: "attacker" }), query.deadline()))).code).toBe("RETRIEVAL_DESTINATION_DENIED");
  expect((await failure(query.request(get("echo"), query.deadline()))).code).toBe("RETRIEVAL_INVALID_OUTPUT");
});

test("credential bindings and limits are trusted startup configuration", () => {
  const items = { items: destination(local(), "/v1/items/:id", { credential: "fixture" }) };
  expect(() => broker(items)).toThrow("CONFIGURATION_MISSING");
  expect(() => broker(items, { credentials: { fixture: { origin: "https://attacker.example.test", header: "authorization", value: secret } } })).toThrow("CONFIGURATION_INVALID");
  expect(() => broker({}, { timeoutMs: 30_001 })).toThrow("CONFIGURATION_INVALID");
  expect(() => broker({}, { maxBytes: 10 * 1048576 + 1 })).toThrow("CONFIGURATION_INVALID");
  const defaults = broker({});
  expect([defaults.timeoutMs, defaults.maxBytes]).toEqual([10_000, 1048576]);
  const raised = broker({}, { timeoutMs: 30_000, maxBytes: 10 * 1048576 });
  expect([raised.timeoutMs, raised.maxBytes]).toEqual([30_000, 10 * 1048576]);
});
