import { h, type VNode, type FunctionComponent } from "preact";
import type { Schema } from "./schema";
import { validators } from "./runtime/schema-metadata";
import { islands, renderIsland } from "./runtime/islands";

export type Island<P> = FunctionComponent<P>;
export function defineIsland<P extends object>(options: { props: Schema<P>; component: (props: P) => VNode }): Island<P> {
  const { props: propsSchema, component: renderComponent } = options;
  if (!validators.has(propsSchema)) throw new Error("Invalid island schema");
  const component: Island<P> = props => renderIsland(component, propsSchema.parse(props));
  islands.set(component, Object.freeze({
    schema: propsSchema,
    validate: (value: unknown) => propsSchema.parse(value),
    render: (value: unknown) => h(renderComponent, propsSchema.parse(value)),
  }));
  return Object.freeze(component);
}
