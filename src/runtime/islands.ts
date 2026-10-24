import { createContext, h, type ComponentChild } from "preact";
import { useContext } from "preact/hooks";
import type { Schema } from "../schema";
export interface IslandDefinition { schema: Schema; validate(value: unknown): unknown; render(value: unknown): ComponentChild; }
export const islands = new WeakMap<object, IslandDefinition>();
export const islandNames = new Map<object, string>();
const IslandParent = createContext(false);
let renderer: ((island: object, value: unknown) => ComponentChild) | undefined;
export function renderIsland(island: object, value: unknown): ComponentChild {
  const registered = islands.get(island);
  if (!registered) throw new Error("Unregistered island");
  const nested = useContext(IslandParent);
  // The outer boundary hydrates its entire component tree. Nested islands still
  // validate their own props, but must not create a second hydration root.
  const content = renderer && !nested ? renderer(island, value) : registered.render(value);
  return h(IslandParent.Provider, { value: true }, content);
}
export async function withIslandRenderer<T>(render: (island: object, value: unknown) => ComponentChild, run: () => Promise<T>): Promise<T> {
  if (renderer) throw new Error("Nested render authority");
  renderer = render;
  try { return await run(); } finally { renderer = undefined; }
}
