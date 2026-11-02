import { expect, test } from "bun:test";
import { ownedPostgres } from "./owned-postgres";

test("the reference database uses owned disk storage with synchronous commits and survives PostgreSQL restart", async () => {
  const database = await ownedPostgres({ disk: true });
  try {
    expect(database.storage).toBe("volume");
    const device = await database.storageDevice();
    expect(device).toMatch(/^[0-9]+:[0-9]+$/);
    expect((await database.sql`SHOW fsync`)[0].fsync).toBe("on");
    expect((await database.sql`SHOW synchronous_commit`)[0].synchronous_commit).toBe("on");
    await database.sql`CREATE TABLE reference_persistence(id integer PRIMARY KEY, name text NOT NULL)`;
    await database.sql`INSERT INTO reference_persistence VALUES(1,'Retained reference data')`;
    await database.restart();
    expect(await database.storageDevice()).toBe(device);
    expect((await database.sql`SELECT name FROM reference_persistence WHERE id=1`)[0].name).toBe("Retained reference data");
  } finally { await database.cleanup(); }
}, 90000);
