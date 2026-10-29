/** Shared by rendered HTML validation and the browser's DOM boundary. */
export const forbiddenPresentationElements = Object.freeze([
  "iframe", "frame", "frameset", "object", "embed", "script", "portal", "fencedframe",
  "style", "link", "base", "meta", "foreignobject", "animate", "animatemotion", "animatetransform", "set", "discard",
]);
const lowercase = Function.call.bind(String.prototype.toLowerCase) as (value: string) => string;
const trim = Function.call.bind(String.prototype.trim) as (value: string) => string;
const codeAt = Function.call.bind(String.prototype.charCodeAt) as (value: string, index: number) => number;
const exec = Function.call.bind(RegExp.prototype.exec) as (expression: RegExp, value: string) => RegExpExecArray | null;
const split = Function.call.bind(String.prototype.split) as (value: string, separator: string | RegExp) => string[];
const contains = Function.call.bind(Array.prototype.includes) as (values: readonly string[], value: string) => boolean;
const test = (expression: RegExp, value: string): boolean => exec(expression, value) !== null;
const deny = (): never => { throw new Error("UNSUPPORTED_CAPABILITY"); };

export function validatePresentationElement(tag: string): void {
  const name = lowercase(tag);
  for (let index = 0; index < forbiddenPresentationElements.length; index++) if (name === forbiddenPresentationElements[index]) deny();
}

/** Presentation requests are local URLs or HTTPS resources, never code URLs. */
export function validatePresentationURL(value: string): void {
  const url = trim(value);
  for (let index = 0; index < url.length; index++) {
    const code = codeAt(url, index);
    if (code <= 32 || code === 127 || code === 92) deny();
  }
  if (test(/^\/\//, url)) deny();
  if (test(/^[a-zA-Z][a-zA-Z0-9+.-]*:/, url) && !test(/^https:\/\//i, url)) deny();
}

export function validateFontSource(value: string): void {
  // FontFace accepts source descriptors, not full stylesheets. Keep the URL
  // grammar explicit so escapes/comments cannot conceal a different scheme.
  const sources = split(value, ",");
  for (let index = 0; index < sources.length; index++) {
    const source = exec(/^\s*url\(\s*(?:"([^"\\]*)"|'([^'\\]*)'|([^\s()'"\\]+))\s*\)(?:\s+format\(\s*["']?[a-zA-Z0-9-]+["']?\s*\))?\s*$/, sources[index]!);
    if (!source) return deny();
    validatePresentationURL(source[1] ?? source[2] ?? source[3]!);
  }
}

export function validatePresentationAttribute(tag: string, name: string, value: string): void {
  const parts = split(lowercase(name), ":");
  const attribute = parts[parts.length - 1]!, element = lowercase(tag);
  if (test(/^on/i, attribute) || contains(["srcdoc", "nonce", "http-equiv", "ping", "action", "formaction"], attribute)) deny();
  if (contains(["src", "href", "poster", "background"], attribute)) {
    validatePresentationURL(value);
    if (element === "use" && !test(/^#[a-zA-Z0-9_.:-]+$/, value)) deny();
  }
  if (attribute === "srcset") {
    const candidates = split(value, ",");
    for (let index = 0; index < candidates.length; index++) {
      const parts = split(trim(candidates[index]!), /\s+/);
      validatePresentationURL(parts[0] ?? "");
      if (parts.length > 2 || parts.length === 2 && !test(/^(?:[1-9][0-9]*w|(?:[0-9]+\.)?[0-9]+x)$/, parts[1]!)) deny();
    }
  }
}
