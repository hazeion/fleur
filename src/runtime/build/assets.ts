import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { extname, join, relative } from "node:path";

export interface PresentationAsset {
  readonly url: string;
  readonly body: Uint8Array;
  readonly type: string;
  readonly cache: "no-cache";
}
const reject = (): never => { throw new Error("SOURCE_REJECTED"); };
const formats: Record<string, { type: string; matches: (bytes: Buffer) => boolean }> = {
  ".png": { type: "image/png", matches: bytes => bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
  ".jpg": { type: "image/jpeg", matches: bytes => bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 },
  ".jpeg": { type: "image/jpeg", matches: bytes => bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 },
  ".gif": { type: "image/gif", matches: bytes => ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6)) },
  ".webp": { type: "image/webp", matches: bytes => bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" },
  ".avif": { type: "image/avif", matches: bytes => bytes.toString("ascii", 4, 8) === "ftyp" && ["avif", "avis"].includes(bytes.toString("ascii", 8, 12)) },
  ".ico": { type: "image/vnd.microsoft.icon", matches: bytes => bytes.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0])) },
  ".woff": { type: "font/woff", matches: bytes => bytes.toString("ascii", 0, 4) === "wOFF" },
  ".woff2": { type: "font/woff2", matches: bytes => bytes.toString("ascii", 0, 4) === "wOF2" },
  ".ttf": { type: "font/ttf", matches: bytes => bytes.subarray(0, 4).equals(Buffer.from([0, 1, 0, 0])) },
  ".otf": { type: "font/otf", matches: bytes => bytes.toString("ascii", 0, 4) === "OTTO" },
  ".mp3": { type: "audio/mpeg", matches: bytes => bytes.toString("ascii", 0, 3) === "ID3" || bytes[0] === 255 && ((bytes[1] ?? 0) & 224) === 224 },
  ".wav": { type: "audio/wav", matches: bytes => bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE" },
  ".ogg": { type: "audio/ogg", matches: bytes => bytes.toString("ascii", 0, 4) === "OggS" },
  ".flac": { type: "audio/flac", matches: bytes => bytes.toString("ascii", 0, 4) === "fLaC" },
  ".m4a": { type: "audio/mp4", matches: bytes => bytes.toString("ascii", 4, 8) === "ftyp" },
  ".mp4": { type: "video/mp4", matches: bytes => bytes.toString("ascii", 4, 8) === "ftyp" },
  ".webm": { type: "video/webm", matches: bytes => bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])) },
  ".ogv": { type: "video/ogg", matches: bytes => bytes.toString("ascii", 0, 4) === "OggS" },
};

// SVG is a document format. Accept only this inert geometry vocabulary, with no
// CSS, external references, entities, event handlers, animation or foreign HTML.
function inertSVG(bytes: Buffer): void {
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return reject(); }
  source = source.replace(/^\uFEFF/, "").replace(/^\s*<\?xml\s+version=["']1\.0["'](?:\s+encoding=["']UTF-8["'])?\s*\?>/i, "").replace(/<!--[\s\S]*?-->/g, "");
  if (/[&]|<\?|<!/.test(source)) return reject();
  const tags = new Set(["svg", "g", "defs", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "linearGradient", "radialGradient", "stop", "clipPath", "mask", "title", "desc", "text", "tspan", "use"]);
  const attributes = new Set(["xmlns", "id", "viewBox", "width", "height", "x", "y", "x1", "x2", "y1", "y2", "cx", "cy", "r", "rx", "ry", "d", "points", "fill", "fill-rule", "fill-opacity", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "stroke-opacity", "opacity", "transform", "preserveAspectRatio", "gradientUnits", "gradientTransform", "offset", "stop-color", "stop-opacity", "clip-path", "clip-rule", "mask", "maskUnits", "maskContentUnits", "font-size", "font-family", "font-weight", "text-anchor", "dominant-baseline", "dx", "dy", "href", "role", "aria-label"]);
  const stack: string[] = [];
  let roots = 0, position = 0;
  for (const token of source.matchAll(/<[^>]*>/g)) {
    const gap = source.slice(position, token.index);
    if (gap.includes("<") || stack.length === 0 && gap.trim() !== "") return reject();
    const text = token[0], close = /^<\/([A-Za-z][A-Za-z0-9]*)\s*>$/.exec(text);
    if (close) { if (stack.pop() !== close[1]) return reject(); }
    else {
      const start = /^<([A-Za-z][A-Za-z0-9]*)(\s[\s\S]*?)?\s*(\/?)>$/.exec(text);
      if (!start || !tags.has(start[1]!)) return reject();
      if (stack.length === 0 && (start[1] !== "svg" || ++roots !== 1)) return reject();
      let rest = (start[2] ?? "").trim();
      const seen = new Set<string>();
      while (rest) {
        const attribute = /^([A-Za-z][A-Za-z0-9:-]*)\s*=\s*(["'])(.*?)\2(?:\s+|$)/s.exec(rest);
        if (!attribute || !attributes.has(attribute[1]!) || seen.has(attribute[1]!)) return reject();
        const name = attribute[1]!, value = attribute[3]!;
        seen.add(name);
        if (/[<>\\]/.test(value) || [...value].some(character => character.charCodeAt(0) < 32) || name === "xmlns" && value !== "http://www.w3.org/2000/svg" || name === "href" && !/^#[A-Za-z][A-Za-z0-9_-]*$/.test(value)) return reject();
        if (/url\s*\(/i.test(value) && !/^url\(#[A-Za-z][A-Za-z0-9_-]*\)$/.test(value)) return reject();
        if (/(?:javascript|data|https?):/i.test(value) && name !== "xmlns") return reject();
        rest = rest.slice(attribute[0].length);
      }
      if (!start[3]) stack.push(start[1]!);
    }
    position = token.index + text.length;
  }
  if (roots !== 1 || stack.length || source.slice(position).trim()) return reject();
}

/** Capture validated presentation bytes once; compilers never reread app files. */
export async function admitPresentationAssets(root: string): Promise<ReadonlyMap<string, PresentationAsset>> {
  const assets = new Map<string, PresentationAsset>();
  const directory = join(root, "assets");
  let total = 0;
  const visit = async (path: string): Promise<void> => {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return reject();
    if (info.isDirectory()) {
      for (const name of await readdir(path)) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return reject();
        await visit(join(path, name));
      }
      return;
    }
    if (!info.isFile() || info.size > 67_108_864 || (total += info.size) > 134_217_728 || assets.size >= 500) return reject();
    const extension = extname(path).toLowerCase(), format = formats[extension];
    if (!format && extension !== ".svg") return reject();
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      const opened = await file.stat();
      if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) return reject();
      const buffer = Buffer.alloc(info.size + 1);
      let used = 0;
      while (used < buffer.length) {
        const { bytesRead } = await file.read(buffer, used, buffer.length - used, null);
        if (bytesRead === 0) break;
        used += bytesRead;
      }
      if (used !== info.size) return reject();
      bytes = buffer.subarray(0, used);
    } finally { await file.close(); }
    if (extension === ".svg") inertSVG(bytes);
    else if (!format!.matches(bytes)) return reject();
    const canonical = await realpath(path);
    if (canonical !== path) return reject();
    const url = "/" + relative(root, path).replaceAll("\\", "/");
    assets.set(canonical, Object.freeze({ url, body: bytes, type: extension === ".svg" ? "image/svg+xml" : format!.type, cache: "no-cache" }));
  };
  try { await lstat(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return assets; throw error; }
  await visit(directory);
  return assets;
}
