import { h, hydrate, type ComponentType } from "preact";
import { islands } from "./islands";
import { validatePublicValue } from "../schema";

export function hydrateAdmitted(exports: Readonly<Record<string, unknown>>): void {
  const payload = document.getElementById("fleur-islands");
  if (!payload || payload.tagName !== "SCRIPT" || payload.getAttribute("type") !== "application/json") throw new Error("Invalid hydration data");
  const text = payload.textContent ?? "";
  if (new TextEncoder().encode(text).length > 1048576) throw new Error("Invalid hydration data");
  const descriptors: unknown = JSON.parse(text);
  validatePublicValue(descriptors);
  if (!Array.isArray(descriptors) || descriptors.length > 500) throw new Error("Invalid hydration data");
  const prepared: { component: ComponentType<Record<string, unknown>>; props: Record<string, unknown>; element: Element }[] = [];
  const keys = new Set<string>();
  for (const item of descriptors) {
    if (!item || typeof item !== "object" || Object.keys(item).length !== 3 || typeof item.key !== "string" || !/^island-[0-9]{1,3}$/.test(item.key) || keys.has(item.key) || typeof item.id !== "string" || !Object.hasOwn(exports, item.id)) throw new Error("Invalid hydration data");
    keys.add(item.key);
    const component = exports[item.id];
    if (typeof component !== "function") throw new Error("Unregistered island");
    const definition = islands.get(component);
    if (!definition) throw new Error("Unregistered island");
    const props = definition.validate(item.props);
    if (!props || typeof props !== "object" || Array.isArray(props)) throw new Error("Invalid island props");
    const elements = document.querySelectorAll(`[data-fleur-island="${item.key}"]`);
    if (elements.length !== 1) throw new Error("Invalid island boundary");
    prepared.push({ component: component as ComponentType<Record<string, unknown>>, props: props as Record<string, unknown>, element: elements[0]! });
  }
  // Validate every descriptor before any component gains browser execution.
  for (const item of prepared) hydrate(h(item.component, item.props), item.element);
  document.documentElement.dataset.fleurHydrated = "true";
}
