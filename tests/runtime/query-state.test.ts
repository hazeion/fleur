import { expect, test } from "bun:test";
import { defineQuery, schema } from "../../src/schema";
import { observeQuery, publishQueries, queryConnectionState } from "../../src/runtime/query-client";

test("connection interruptions retain the independent query outcome", () => {
  const contract = defineQuery({ name: "connection-test", input: schema.object({}), output: schema.string() });
  const observed = observeQuery(contract, {}, () => {});
  try {
    publishQueries([{ name: "connection-test", input: {}, status: "current", stale: false, data: "stored" }]);
    queryConnectionState("reconnecting");
    expect(observed.get()).toMatchObject({ status: "success", data: "stored", stale: true, connection: "reconnecting" });
    queryConnectionState("maintenance");
    expect(observed.get()).toMatchObject({ status: "success", data: "stored", stale: true, connection: "maintenance" });
    publishQueries([{ name: "connection-test", input: {}, status: "current", stale: false, data: "current" }]);
    expect(observed.get()).toMatchObject({ status: "success", data: "current", stale: false, connection: "connected" });
  } finally { observed.dispose(); }
});
