import { installMutationTransport } from "./mutation-client";
// This entry evaluates before any admitted application module.
const send = globalThis.fetch.bind(globalThis);
installMutationTransport({ send, online: () => navigator.onLine });
const denied = () => { throw new Error("UNSUPPORTED_CAPABILITY"); };
for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "Worker", "SharedWorker", "WebTransport", "RTCPeerConnection"]) {
  Object.defineProperty(globalThis, name, { value: denied, writable: false, configurable: false });
}
Object.defineProperty(navigator, "sendBeacon", { value: denied, writable: false, configurable: false });

Object.defineProperty(Navigator.prototype, "sendBeacon", { value: denied, writable: false, configurable: false });
