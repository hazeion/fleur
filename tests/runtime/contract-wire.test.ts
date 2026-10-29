import { expect, test } from "bun:test";
import { schema } from "../../src/schema";
import { describeSchema, restoreSchema } from "../../src/runtime/schema-wire";

test("contracts crossing the worker boundary retain strict date, decimal and omission rules", () => {
  const declaration = schema.object({ name: schema.string().min(1).max(3), day: schema.localDate(), amount: schema.decimal({ maxScale: 2, nonnegative: true }).optional(), note: schema.string().nullable() });
  const received = restoreSchema(JSON.parse(JSON.stringify(describeSchema(declaration))));
  expect(received.parse({ name: "🧂", day: "2024-02-29", note: null })).toEqual({ name: "🧂", day: "2024-02-29", note: null });
  for (const input of [
    { name: "too long", day: "2024-02-29", note: null },
    { name: "ok", day: "2023-02-29", note: null },
    { name: "ok", day: "2024-02-29", amount: "1.001", note: null },
    { name: "ok", day: "2024-02-29", amount: "-1", note: null },
    { name: "ok", day: "2024-02-29" },
    { name: "ok", day: "2024-02-29", note: null, secret: "private" },
  ]) expect(() => received.parse(input)).toThrow();
});
