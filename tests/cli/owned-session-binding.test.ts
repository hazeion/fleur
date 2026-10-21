import { expect, spyOn, test } from "bun:test";
import { observeGuestSessions } from "../../scripts/observe-fresh-linux-session.ts";

test("partial owned session identity is refused before any process starts", async () => {
  let attempted = false;
  const processBoundary = spyOn(Bun, "spawn").mockImplementation(() => { attempted = true; throw new Error("invalid binding reached process boundary"); });
  try {
    const target = { port: 2222, identity: "fixture-key", knownHosts: "fixture-hosts", nonce: "12345678-1234-4234-8234-123456789abc", ownedGuestBinding: JSON.parse('{"uid":1000}') };
    const result = await observeGuestSessions(target);
    expect(result).toMatchObject({ ok: false, error: { code: "ARGUMENT_INVALID" } });
    expect(attempted).toBe(false);
  } finally { processBoundary.mockRestore(); }
});
