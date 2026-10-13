import { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import { router, exercises } from "./fixture";
const wrongInput: inferRouterInputs<typeof router>["exercise"] = { id: "wrong" };
const omittedNullable: inferRouterOutputs<typeof router>["exercise"] = { id: 1, name: "Squat", weight: null };
const numericDecimal: typeof exercises.$inferSelect = { id: 1, name: "Squat", notes: null, weight: 12.5 };
export { wrongInput, omittedNullable, numericDecimal };
