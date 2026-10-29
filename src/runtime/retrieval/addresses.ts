import { isIP } from "node:net";

/**
 * `public` addresses are admitted for any declared destination. `loopback` and
 * `private` need the exact trusted local-service exception. Link-local,
 * metadata and reserved addresses are never admitted.
 */
export type AddressClass = "public" | "loopback" | "private" | "link-local" | "metadata" | "reserved";
const metadata = new Set(["169.254.169.254", "169.254.170.2", "100.100.100.200", "192.0.0.192"]);
function ipv4(address: string): number {
  const parts = address.split(".").map(Number);
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}
const v4 = (base: string, bits: number): [number, number] => [ipv4(base), bits];
const ipv4Ranges: readonly [[number, number], AddressClass][] = [
  [v4("0.0.0.0", 8), "reserved"], [v4("10.0.0.0", 8), "private"], [v4("100.64.0.0", 10), "private"],
  [v4("127.0.0.0", 8), "loopback"], [v4("169.254.0.0", 16), "link-local"], [v4("172.16.0.0", 12), "private"],
  [v4("192.0.0.0", 24), "reserved"], [v4("192.0.2.0", 24), "reserved"], [v4("192.88.99.0", 24), "reserved"],
  [v4("192.168.0.0", 16), "private"], [v4("198.18.0.0", 15), "reserved"], [v4("198.51.100.0", 24), "reserved"],
  [v4("203.0.113.0", 24), "reserved"], [v4("224.0.0.0", 4), "reserved"], [v4("240.0.0.0", 4), "reserved"],
];
function classifyIPv4(address: string): AddressClass {
  if (metadata.has(address)) return "metadata";
  const value = ipv4(address);
  for (const [[base, bits], kind] of ipv4Ranges) if (((value ^ base) >>> (32 - bits)) === 0) return kind;
  return "public";
}
/** Expands an IPv6 literal into eight 16-bit groups. */
function groups(address: string): number[] {
  let text = address.toLowerCase().replace(/%.*$/, "");
  const embedded = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (embedded) {
    const value = ipv4(embedded[1]!);
    text = text.slice(0, -embedded[1]!.length) + `${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
  }
  const [head, tail] = text.split("::") as [string, string | undefined];
  const left = head ? head.split(":") : [], right = tail ? tail.split(":") : [];
  const middle = tail === undefined ? [] : Array(8 - left.length - right.length).fill("0");
  return [...left, ...middle, ...right].map(part => parseInt(part, 16));
}
const embeddedIPv4 = (parts: number[], offset: number) => [parts[offset]! >> 8, parts[offset]! & 255, parts[offset + 1]! >> 8, parts[offset + 1]! & 255].join(".");
function classifyIPv6(address: string): AddressClass {
  const parts = groups(address);
  const [a, b] = parts as [number, number];
  if (parts.every(part => part === 0)) return "reserved";
  if (parts.slice(0, 7).every(part => part === 0) && parts[7] === 1) return "loopback";
  // IPv4-mapped and NAT64 addresses reach the embedded IPv4 destination.
  if (parts.slice(0, 5).every(part => part === 0) && parts[5] === 0xffff) return classifyIPv4(embeddedIPv4(parts, 6));
  if (a === 0x64 && b === 0xff9b && parts.slice(2, 6).every(part => part === 0)) return classifyIPv4(embeddedIPv4(parts, 6));
  if (a === 0x2002) return classifyIPv4(embeddedIPv4(parts, 1)) === "public" ? "public" : "reserved";
  if (a === 0xfd00 && b === 0x0ec2 && parts.slice(2, 7).every(part => part === 0) && parts[7] === 0x254) return "metadata";
  if ((a & 0xfe00) === 0xfc00 || (a & 0xffc0) === 0xfec0 || (a === 0x64 && b === 0xff9b)) return "private";
  if ((a & 0xffc0) === 0xfe80) return "link-local";
  // Teredo, ORCHID, documentation and anything outside global unicast.
  if ((a === 0x2001 && (b === 0 || b === 0x0db8 || (b & 0xfff0) === 0x10 || (b & 0xfff0) === 0x20)) || (a & 0xe000) !== 0x2000) return "reserved";
  return "public";
}
export function classifyAddress(address: string): AddressClass {
  const family = isIP(address);
  if (family === 4) return classifyIPv4(address);
  if (family === 6) return classifyIPv6(address);
  throw new Error("Invalid address");
}
