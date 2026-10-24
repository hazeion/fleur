import type { ComponentChild } from "preact";
import type { Schema } from "../schema";
export interface IslandDefinition { schema: Schema; validate(value: unknown): unknown; render(value: unknown): ComponentChild; }
export const islands = new WeakMap<object, IslandDefinition>();
export const islandNames = new Map<object, string>();
let renderer: ((island: object, value: unknown) => ComponentChild) | undefined;
export function renderIsland(island: object, value: unknown): ComponentChild {
  const registered = islands.get(island);
  if (!registered) throw new Error("Unregistered island");
  return renderer ? renderer(island, value) : registered.render(value);
}
export async function withIslandRenderer<T>(render: (island: object, value: unknown) => ComponentChild, run: () => Promise<T>): Promise<T> {
  if (renderer) throw new Error("Nested render authority");
  renderer = render;
  try { return await run(); } finally { renderer = undefined; }
}
