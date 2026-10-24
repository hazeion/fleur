import { h, type ComponentChildren, type VNode } from "preact";
import type { Schema } from "./schema";
import { objectFields, routeSchemas } from "./runtime/schema-metadata";

export interface Page<P = unknown> { readonly path: string; readonly params: Schema<P>; }
type PathKeys<S extends string> = S extends `${string}:${infer Key}/${infer Rest}` ? Key | PathKeys<`/${Rest}`> : S extends `${string}:${infer Key}` ? Key : never;
type ExactParams<Path extends string, P> = P extends Record<keyof P, string> ? Exclude<keyof P, PathKeys<Path>> extends never ? Exclude<PathKeys<Path>, keyof P> extends never ? unknown : never : never : never;
export function definePage<const Path extends string, P>(options: { path: Path; params: Schema<P> } & ExactParams<Path, P>): Page<P> {
  if (!/^\/(?:[a-zA-Z0-9_-]+|:[a-zA-Z][a-zA-Z0-9_]*)(?:\/(?:[a-zA-Z0-9_-]+|:[a-zA-Z][a-zA-Z0-9_]*))*$/.test(options.path) && options.path !== "/") throw new Error("Invalid page path");
  const keys = options.path.split("/").filter(part => part.startsWith(":")).map(part => part.slice(1));
  const fields = objectFields.get(options.params);
  if (!routeSchemas.has(options.params) || !fields || keys.length !== fields.length || new Set(keys).size !== keys.length || keys.some(key => !fields.includes(key))) throw new Error("Route parameters must match schema fields");
  return Object.freeze({ ...options });
}
export function href<P>(page: Page<P>, params: NoInfer<P>): string {
  const validated = page.params.parse(params) as Record<string, unknown>;
  return page.path.split("/").map(part => {
    if (!part.startsWith(":")) return part;
    const value = validated[part.slice(1)];
    if (typeof value !== "string" || value.length === 0 || value === "." || value === "..") throw new Error("Invalid route parameter");
    return encodeURIComponent(value);
  }).join("/");
}
export function matchPage<P>(page: Page<P>, pathname: string): P | null {
  const expected = page.path.split("/"), actual = pathname.split("/");
  if (expected.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < expected.length; index++) {
    const segment = expected[index]!;
    if (!segment.startsWith(":")) { if (segment !== actual[index]) return null; }
    else {
      const value = decodeURIComponent(actual[index]!);
      if (!value || value === "." || value === "..") throw new Error("Invalid route parameter");
      params[segment.slice(1)] = value;
    }
  }
  return page.params.parse(params);
}
export function Link<P>(props: { to: Page<P>; params: NoInfer<P>; children?: ComponentChildren }): VNode {
  return h("a", { href: href(props.to, props.params) }, props.children);
}
export function navigate<P>(page: Page<P>, params: NoInfer<P>): void { globalThis.location.assign(href(page, params)); }
