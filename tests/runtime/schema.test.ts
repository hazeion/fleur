import { expect, test } from "bun:test";
import { schema } from "../../src/schema";

test("public object validation distinguishes omission from null and rejects extra fields", () => {
  const contract = schema.object({ name: schema.string(), note: schema.string().optional(), deleted: schema.boolean().nullable() });
  expect(contract.parse({ name: "Sage", deleted: null })).toEqual({ name: "Sage", deleted: null });
  for (const input of [
    { name: "Sage" },
    { name: "Sage", deleted: null, note: undefined },
    { name: "Sage", deleted: null, secret: "private" },
  ]) expect(() => contract.parse(input)).toThrow();
});

test("public values reject nested JavaScript objects and accessor side effects", () => {
  const contract = schema.object({ value: schema.string().optional() });
  for (const value of [new Date(), 1n, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, undefined]) {
    expect(() => contract.parse({ value })).toThrow();
  }
  let accessed = false;
  const input = { get value() { accessed = true; return "private"; } };
  expect(() => contract.parse(input)).toThrow();
  expect(accessed).toBe(false);
  expect(() => schema.object({}).parse(new Date())).toThrow();
});

test("wire scalars retain exact decimals, calendar dates and Unicode limits", () => {
  expect(schema.string().min(1).max(1).parse("🧂")).toBe("🧂");
  expect(String(schema.localDate().parse("2024-02-29"))).toBe("2024-02-29");
  expect(String(schema.timestamp().parse("2024-02-29T12:00:00.000Z"))).toBe("2024-02-29T12:00:00.000Z");
  expect(String(schema.decimal({ maxScale: 2, nonnegative: true }).parse("001.20"))).toBe("001.20");
  for (const date of ["2023-02-29", "2024-02-30", "2024-13-01", "2024-02-29T00:00:00Z"]) expect(() => schema.localDate().parse(date)).toThrow();
  for (const timestamp of ["2024-02-29", "2024-02-30T00:00:00Z", "2024-02-29T24:00:00Z", "2024-02-29T00:00:00+01:00"]) expect(() => schema.timestamp().parse(timestamp)).toThrow();
  for (const value of ["1e2", "-1", "1.001", "NaN"]) expect(() => schema.decimal({ maxScale: 2, nonnegative: true }).parse(value)).toThrow();
  expect(() => schema.safeInteger().parse(1.2)).toThrow();
  expect(() => schema.number().parse(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  expect(schema.array(schema.enum(["g", "ml"])).min(1).max(2).parse(["g"])).toEqual(["g"]);
});

test("schema arrays reject holes, cycles and hidden properties without invoking getters", () => {
  const input: unknown[] = [];
  input.length = 1;
  expect(() => schema.array(schema.string()).parse(input)).toThrow();
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  expect(() => schema.object({}).parse(cycle)).toThrow();
  expect(() => schema.object({}).parse(Object.defineProperty({}, "secret", { value: "hidden" }))).toThrow();
});

test("out-of-range array properties cannot conceal an omitted element", () => {
  const input: string[] = [];
  input.length = 1;
  Object.defineProperty(input, "4294967295", { value: "hidden", enumerable: true });
  expect(() => schema.array(schema.string().optional()).parse(input)).toThrow();
});

test("application schemas cannot replace validation or supply custom parsers", async () => {
  const module = await import("../../src/schema");
  expect("Schema" in module).toBe(false);
  const text = schema.string();
  expect(() => { text.parse = () => "forged"; }).toThrow();
  expect(() => text.parse(42)).toThrow();
});

test("schema constructors cannot be recovered to install arbitrary transforms", () => {
  const Constructor = Object.getPrototypeOf(schema.string()).constructor as new (check: unknown) => { parse(value: unknown): unknown };
  expect(() => new Constructor({ parse: () => new Date(0) }).parse(null)).toThrow();
});

test("derived schema constructors cannot intercept their private construction authority", () => {
  const Constructor = Object.getPrototypeOf(schema.string()).constructor as object;
  expect(() => Object.setPrototypeOf(Constructor, function () {})).toThrow();
});

test("decimal limits do not change when their original options object changes", () => {
  const options = { maxScale: 2, nonnegative: true };
  const decimal = schema.decimal(options);
  options.maxScale = 8;
  options.nonnegative = false;
  expect(() => decimal.parse("-1.123456")).toThrow();
});
