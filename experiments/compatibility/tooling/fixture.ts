import { z } from "zod";
import { initTRPC, inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import { pgTable, text, integer, numeric } from "drizzle-orm/pg-core";

export const exercises = pgTable("exercises", {
  id: integer().primaryKey(),
  name: text().notNull(),
  notes: text(),
  weight: numeric({ precision: 8, scale: 2 }),
});

export const input = z.strictObject({ id: z.number().int().positive() });
export const output = z.strictObject({
  id: z.number().int(), name: z.string(), notes: z.string().nullable(),
  weight: z.string().nullable(),
});
const t = initTRPC.create();
export const router = t.router({
  exercise: t.procedure.input(input).output(output).query(({ input }) => ({
    id: input.id, name: "Squat", notes: null, weight: "12.50",
  })),
});
type Inputs = inferRouterInputs<typeof router>;
type Outputs = inferRouterOutputs<typeof router>;
const validInput: Inputs["exercise"] = { id: 1 };
const validOutput: Outputs["exercise"] = { id: 1, name: "Squat", notes: null, weight: "12.50" };
const selected: typeof exercises.$inferSelect = validOutput;
export const valid = { validInput, validOutput, selected };
