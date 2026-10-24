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

import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { Mutation } from "./schema";
import { runMutation, type MutationOutcome, type MutationError } from "./runtime/mutation-client";
export type { MutationOutcome, MutationError };
export interface MutationState<I, O> {
  readonly status: "idle" | "pending" | "success" | "failure" | "outcome-unknown";
  readonly pending: boolean;
  readonly data?: O;
  readonly error?: MutationError;
  run(input: I): Promise<MutationOutcome<O>>;
}
export function useMutation<I, O>(contract: Mutation<I, O>): MutationState<I, O> {
  const [state, setState] = useState<Omit<MutationState<I, O>, "run">>({ status: "idle", pending: false });
  const pending = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const run = useCallback(async (input: I): Promise<MutationOutcome<O>> => {
    if (pending.current) return { status: "failure", delivery: "not-sent", error: { code: "ALREADY_PENDING" } };
    pending.current = true;
    if (mounted.current) setState({ status: "pending", pending: true });
    try {
      const outcome = await runMutation(contract, input);
      if (mounted.current) setState({ status: outcome.status, pending: false, ...(outcome.status === "success" ? { data: outcome.data } : outcome.status === "failure" ? { error: outcome.error } : {}) });
      return outcome;
    } finally { pending.current = false; }
  }, [contract]);
  return { ...state, run };
}
