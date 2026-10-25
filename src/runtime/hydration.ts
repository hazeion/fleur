import { nameMutationExports } from "./mutation-client";
import { nameQueryExports } from "./query-client";
import { startReactiveView } from "./reactive-browser";
import { parseServerHTML } from "./browser-transport";
import { h, hydrate, render, type ComponentType } from "preact";
import { islands } from "./islands";
import { validatePublicValue } from "../schema";

export function hydrateAdmitted(exports: Readonly<Record<string, unknown>>): void {
  nameMutationExports(exports);
  nameQueryExports(exports);
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
  const view = document.getElementById("fleur-view");
  if (view) {
    if (view.tagName !== "SCRIPT" || view.getAttribute("type") !== "application/json") throw new Error("Invalid view data");
    const root = document.getElementById("fleur-page");
    if (!root) throw new Error("Missing page root");
    type Mounted = { id: string; component: ComponentType<Record<string, unknown>>; element: Element };
    const mounted = new Map<string, Mounted>();
    for (const item of prepared) {
      const identity = item.element.getAttribute("data-fleur-identity");
      if (!identity || mounted.has(identity)) throw new Error("Invalid island identity");
      mounted.set(identity, { id: item.element.getAttribute("data-fleur-island")!, component: item.component, element: item.element });
    }
    startReactiveView(JSON.parse(view.textContent ?? ""), page => {
      const parsed = parseServerHTML(page.html);
      const fresh = parsed.body;
      const updates = new Map<string, { component: ComponentType<Record<string, unknown>>; props: Record<string, unknown>; element: Element }>();
      const descriptorKeys = new Set<string>();
      for (const descriptor of page.islands) {
        if (descriptorKeys.has(descriptor.key)) throw new Error("Duplicate island key");
        descriptorKeys.add(descriptor.key);
        const component = exports[descriptor.id];
        if (typeof component !== "function") throw new Error("Unregistered island");
        const definition = islands.get(component);
        if (!definition) throw new Error("Unregistered island");
        const props = definition.validate(descriptor.props);
        if (!props || typeof props !== "object" || Array.isArray(props)) throw new Error("Invalid island props");
        const elements = fresh.querySelectorAll(`[data-fleur-island="${descriptor.key}"]`);
        if (elements.length !== 1) throw new Error("Invalid island boundary");
        const element = elements[0]!, identity = element.getAttribute("data-fleur-identity");
        if (!identity || updates.has(identity)) throw new Error("Invalid island identity");
        updates.set(identity, { component: component as ComponentType<Record<string, unknown>>, props: props as Record<string, unknown>, element });
      }
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      const selection = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? { start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection } : undefined;
      const nodeKey = (node: Node): string | undefined => node instanceof Element ? ["data-fleur-identity", "data-fleur-region", "data-fleur-end", "data-fleur-key"].map(name => node.hasAttribute(name) ? `${name}:${node.getAttribute(name)}` : undefined).find(Boolean) : undefined;
      const compatible = (old: Node, next: Node) => old.nodeType === next.nodeType && (!(old instanceof Element) || next instanceof Element && old.tagName === next.tagName) && nodeKey(old) === nodeKey(next);
      const attributes = (old: Element, next: Element) => {
        for (const attribute of Array.from(old.attributes)) if (!next.hasAttribute(attribute.name)) old.removeAttribute(attribute.name);
        for (const attribute of next.attributes) if (old.getAttribute(attribute.name) !== attribute.value) old.setAttribute(attribute.name, attribute.value);
      };
      const reconcile = (old: Node, next: Node): void => {
        if (!(old instanceof Element) || !(next instanceof Element)) { if (old.nodeValue !== next.nodeValue) old.nodeValue = next.nodeValue; return; }
        const identity = next.getAttribute("data-fleur-identity");
        if (identity) {
          const update = updates.get(identity), existing = mounted.get(identity);
          if (!update) throw new Error("Missing island descriptor");
          if (existing?.component === update.component && existing.element === old) {
            attributes(old, next);
            render(h(update.component, update.props), old);
            return;
          }
        }
        // A failed region keeps its last complete subtree. Healthy siblings are
        // reconciled independently and no missing initial result becomes data.
        if (next.hasAttribute("data-fleur-error") && old.getAttribute("data-fleur-region") === next.getAttribute("data-fleur-region")) {
          attributes(old, next); return;
        }
        attributes(old, next); children(old, next);
      };
      const children = (old: Node, next: Node): void => {
        let cursor = old.firstChild;
        const desiredChildren = [...next.childNodes];
        for (let index = 0; index < desiredChildren.length; index++) {
          const desired = desiredChildren[index]!;
          const key = nodeKey(desired);
          let found: Node | undefined = key ? [...old.childNodes].find(node => nodeKey(node) === key && compatible(node, desired)) : cursor && !nodeKey(cursor) && compatible(cursor, desired) ? cursor : undefined;
          if (found instanceof Element && desired instanceof Element && desired.hasAttribute("data-fleur-error") && desired.hasAttribute("data-fleur-region")) {
            const id = desired.getAttribute("data-fleur-region");
            const end = [...old.childNodes].find(node => node instanceof Element && node.getAttribute("data-fleur-end") === id);
            const nextEnd = desiredChildren.findIndex((node, childIndex) => childIndex > index && node instanceof Element && node.getAttribute("data-fleur-end") === id);
            if (!end || nextEnd < 0) throw new Error("Invalid server region");
            attributes(found, desired);
            // Region anchors are legal in table/select content models. Move
            // their existing range intact when a failed region is reordered.
            let item: Node | null = found;
            while (item) {
              const following: Node | null = item.nextSibling;
              if (item !== cursor) old.insertBefore(item, cursor);
              cursor = item.nextSibling;
              if (item === end) break;
              item = following;
            }
            index = nextEnd;
            continue;
          }
          if (!found) {
            found = desired.cloneNode(true);
            old.insertBefore(found, cursor);
          } else {
            if (found !== cursor) old.insertBefore(found, cursor);
            reconcile(found, desired);
          }
          cursor = found.nextSibling;
        }
        while (cursor) { const next = cursor.nextSibling; old.removeChild(cursor); cursor = next; }
      };
      children(root, fresh);
      for (const [identity, item] of mounted) if (!root.contains(item.element)) { render(null, item.element); mounted.delete(identity); }
      for (const [identity, update] of updates) {
        const element = [...root.querySelectorAll("[data-fleur-identity]")].find(item => item.getAttribute("data-fleur-identity") === identity);
        if (!element) continue;
        if (!mounted.has(identity)) { hydrate(h(update.component, update.props), element); mounted.set(identity, { id: identity, component: update.component, element }); }
      }
      if (active?.isConnected && document.activeElement !== active) {
        active.focus({ preventScroll: true });
        if (selection && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) active.setSelectionRange(selection.start, selection.end, selection.direction ?? undefined);
      }
    });
  }
  document.documentElement.dataset.fleurHydrated = "true";
}
