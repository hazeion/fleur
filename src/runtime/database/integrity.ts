import type { SQL } from "bun";
import { createHash } from "node:crypto";
import { quote } from "./inspection";

/** Every base table, including Fleur history and metadata, all sequence states and large-object pages. */
export async function dataIntegrity(sql: SQL): Promise<string> {
  const hash = createHash("sha256");
  const relations = await sql.unsafe("SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE left(n.nspname,3) <> 'pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','S','f','m') ORDER BY n.nspname COLLATE \"C\", c.relname COLLATE \"C\"");
  for (const relation of relations) {
    if (relation.kind === "f") throw new Error("UNSUPPORTED_CAPABILITY");
    const name = `${quote(String(relation.schema))}.${quote(String(relation.name))}`;
    hash.update(JSON.stringify([relation.schema, relation.name, relation.kind])+"\n");
    const query = relation.kind === "S" ? `SELECT last_value::text AS value, is_called FROM ${name}` : `SELECT encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex') AS value FROM ONLY ${name} AS t ORDER BY 1`;
    const cursor = quote(`fleur_integrity_${crypto.randomUUID().replaceAll("-", "")}`);
    await sql.unsafe(`DECLARE ${cursor} NO SCROLL CURSOR WITH HOLD FOR ${query}`);
    try {
      for (;;) {
        const rows = await sql.unsafe(`FETCH FORWARD 128 FROM ${cursor}`);
        for (const row of rows) hash.update(JSON.stringify(row)+"\n");
        if (rows.length < 128) break;
      }
    } finally { await sql.unsafe(`CLOSE ${cursor}`); }
  }
  const objects = await sql.unsafe("SELECT oid::text AS id FROM pg_largeobject_metadata ORDER BY oid");
  for (const object of objects) {
    hash.update(`large-object:${object.id}\n`);
    for (let offset = 0;; offset += 65536) {
      const rows = await sql.unsafe("SELECT octet_length(lo_get($1::oid,$2::bigint,65536)) AS bytes, encode(sha256(lo_get($1::oid,$2::bigint,65536)),'hex') AS value", [object.id, offset]);
      hash.update(JSON.stringify(rows[0])+"\n");
      if (Number(rows[0]?.bytes) < 65536) break;
    }
  }
  return hash.digest("hex");
}
