import { z } from "zod";
import { initTRPC, inferRouterInputs, inferRouterOutputs } from "@trpc/server";
const t = initTRPC.create();
export const router = t.router({
  exercise: t.procedure.input(z.strictObject({ id: z.number().int().positive() }))
    .output(z.strictObject({ id: z.number().int(), notes: z.string().nullable(), weight: z.string().nullable() }))
    .query(({ input }) => ({ id: input.id, notes: null, weight: "12.50" })),
});
const acceptedInput: inferRouterInputs<typeof router>["exercise"] = { id: 1 };
const acceptedOutput: inferRouterOutputs<typeof router>["exercise"] = { id: 1, notes: null, weight: "12.50" };
export const accepted = { acceptedInput, acceptedOutput };
