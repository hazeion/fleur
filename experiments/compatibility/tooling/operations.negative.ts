import { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import { router } from "./operations";
export const rejectedInput: inferRouterInputs<typeof router>["exercise"] = { id: "wrong" };
export const missingNullable: inferRouterOutputs<typeof router>["exercise"] = { id: 1, weight: null };
export const numericDecimal: inferRouterOutputs<typeof router>["exercise"] = { id: 1, notes: null, weight: 12.5 };
