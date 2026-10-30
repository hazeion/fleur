import { assertPresentationTree, restrictBrowserRealms } from "./browser-realms";
import { installMutationTransport } from "./mutation-client";
// This entry evaluates before any admitted application module.
const fetchResponse = globalThis.fetch.bind(globalThis);
let development = document.head.querySelector<HTMLMetaElement>('meta[name="fleur-development"]')?.content;
export function setDevelopmentGeneration(value: string): void {
  if (!/^[a-zA-Z0-9:-]{1,128}$/.test(value)) throw new Error("SOURCE_CHANGED");
  development = value;
}
function send(path: string, init: RequestInit, version = development): Promise<Response> {
  const headers = new Headers(init.headers);
  if (version) headers.set("X-Fleur-Development", version);
  return fetchResponse(path, { ...init, headers });
}
const parse = DOMParser.prototype.parseFromString;
const stylesheetHref = Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype, "href")!.set!;
/** Only the trusted lifecycle transport can replace compiler-owned Tailwind CSS. */
export function replaceStylesheet(path: string): void {
  if (!/^\/assets\/styles-[a-f0-9]+\.css$/.test(path)) throw new Error("SOURCE_CHANGED");
  const link = document.head.querySelector<HTMLLinkElement>('link[rel="stylesheet"]');
  if (link) Reflect.apply(stylesheetHref, link, [path]);
}
export const reactiveSend = send;
export function parseServerHTML(html: string): Document {
  // An explicit body context keeps leading region anchors in place; a bare
  // fragment would hoist a leading <template> into the parsed head.
  const document = Reflect.apply(parse, new DOMParser(), [`<!doctype html><html><head></head><body>${html}`, "text/html"]) as Document;
  assertPresentationTree(document);
  return document;
}
installMutationTransport({ send, online: () => navigator.onLine });
const denied = () => { throw new Error("UNSUPPORTED_CAPABILITY"); };
for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "Worker", "SharedWorker", "WebTransport", "RTCPeerConnection", "webkitRTCPeerConnection", "AudioContext", "webkitAudioContext", "OfflineAudioContext", "BroadcastChannel", "importScripts"]) {
  Object.defineProperty(globalThis, name, { value: denied, writable: false, configurable: false });
}
Object.defineProperty(navigator, "sendBeacon", { value: denied, writable: false, configurable: false });

Object.defineProperty(Navigator.prototype, "sendBeacon", { value: denied, writable: false, configurable: false });
Object.defineProperty(Navigator.prototype, "serviceWorker", { get: denied, configurable: false });
if (typeof CSS !== "undefined" && "paintWorklet" in CSS) Object.defineProperty(CSS, "paintWorklet", { get: denied, configurable: false });

restrictBrowserRealms();
