import { z } from "zod";

export const propsSchema = z.strictObject({
  name: z.string(),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
export type IslandProps = z.infer<typeof propsSchema>;
export const validateProps = (value: unknown): IslandProps => propsSchema.parse(value);
