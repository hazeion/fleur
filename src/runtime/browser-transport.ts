import { assertPresentationTree, restrictBrowserRealms } from "./browser-realms";
import { installMutationTransport } from "./mutation-client";
// This entry evaluates before any admitted application module.
const send = globalThis.fetch.bind(globalThis);
const parse = DOMParser.prototype.parseFromString;
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
