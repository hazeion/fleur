import { SQL } from "bun";
import { quote } from "./inspection";
import { PrivilegeInsufficient } from "./privilege";

/** Private host implementation detail. Never put this identity or credential in public results. */
export const agentQueryRole = "fleur_agent_query_v1";
const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const denied = () => new PrivilegeInsufficient("agent query provisioning");

/** The development cluster's superuser owns this policy. No application or production target calls it. */
export async function provisionAgentQueryRole(control: SQL, password: string, application?: SQL, deadline = performance.now() + 5000): Promise<void> {
  if (!/^[a-f0-9-]{36}$/.test(password)) throw denied();
  const name = quote(agentQueryRole);
  const run = async (connection: Pick<SQL, "unsafe">, text: string, params: unknown[] = []) => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error("QUERY_TIMEOUT");
    await connection.unsafe(`SET statement_timeout='${Math.max(1, Math.ceil(remaining))}ms'`);
    return connection.unsafe(text, params);
  };
  if ((await run(control, "SELECT rolsuper FROM pg_roles WHERE rolname=current_user"))[0]?.rolsuper !== true) throw denied();
  // Serialize concurrent verification and password rotation in the control database only.
  const sql = control;
  await run(sql, "SET statement_timeout='5s'");
  await run(sql, "SELECT pg_advisory_lock(713406329874::bigint)");
  try {
    if (!(await run(sql, "SELECT 1 FROM pg_roles WHERE rolname=$1", [agentQueryRole])).length) await run(sql, `CREATE ROLE ${name}`);
    await run(sql, `ALTER ROLE ${name} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 4 PASSWORD ${literal(password)}`);
    for (const row of await run(sql, "SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid WHERE m.member=(SELECT oid FROM pg_roles WHERE rolname=$1)", [agentQueryRole])) await run(sql, `REVOKE ${quote(String(row.rolname))} FROM ${name}`);
    await run(sql, `ALTER ROLE ${name} RESET ALL`);
    await run(sql, `ALTER ROLE ${name} SET statement_timeout='5s'`);
    await run(sql, `ALTER ROLE ${name} SET idle_in_transaction_session_timeout='5s'`);
    await run(sql, `ALTER ROLE ${name} SET temp_file_limit='16MB'`);
    await run(sql, `REVOKE SET ON PARAMETER temp_file_limit FROM ${name}`);
    // PUBLIC cannot carry CONNECT/TEMP into current or future verification targets.
    const appName = application ? String((await run(application, "SELECT current_database() AS name"))[0].name) : undefined;
    await sql.begin(async policy => {
    const owner = String((await run(policy, "SELECT current_user AS name"))[0].name);
    for (const row of await run(policy, "SELECT datname,pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname <> 'template0'")) {
      const database = quote(String(row.datname));
      await run(policy, `REVOKE CONNECT,TEMP ON DATABASE ${database} FROM PUBLIC,${name}`);
      await run(policy, `GRANT CONNECT,TEMP ON DATABASE ${database} TO ${quote(String(row.owner))},${quote(owner)}`);
    }
    if (appName) await run(policy, `GRANT CONNECT ON DATABASE ${quote(appName)} TO ${name}`);
    });
    if (application) {
      // An unexpected owned object is not safe to repair by granting privileges.
      const owned = await run(application, "SELECT EXISTS(SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=(SELECT oid FROM pg_roles WHERE rolname=$1) AND deptype='o') AS owned", [agentQueryRole]);
      if (owned[0]?.owned !== false) throw denied();
      for (const row of await run(application, "SELECT nspname FROM pg_namespace WHERE left(nspname,3)<>'pg_' AND nspname <> 'information_schema'")) {
        const schema = quote(String(row.nspname));
        await run(application, `REVOKE ALL ON SCHEMA ${schema} FROM ${name}; REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM ${name}; REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schema} FROM ${name}; REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${schema} FROM ${name}`);
      }
      await run(application, `GRANT USAGE ON SCHEMA public TO ${name}`);
      for (const table of await run(application, "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p')")) await run(application, `GRANT SELECT ON public.${quote(String(table.relname))} TO ${name}`);
      const owners = await run(application, "SELECT DISTINCT pg_get_userbyid(relowner) AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' UNION SELECT current_user");
      for (const owner of owners) await run(application, `ALTER DEFAULT PRIVILEGES FOR ROLE ${quote(String(owner.name))} IN SCHEMA public GRANT SELECT ON TABLES TO ${name}`);
      // PostgreSQL authorizes an inheritance scan through its root, ignoring child-table ACLs and child RLS.
      const descendants = await run(application, `WITH RECURSIVE tree(root,node) AS (
        SELECT inhparent,inhrelid FROM pg_inherits UNION ALL SELECT tree.root,i.inhrelid FROM tree JOIN pg_inherits i ON i.inhparent=tree.node)
        SELECT EXISTS(SELECT 1 FROM tree JOIN pg_class root ON root.oid=tree.root JOIN pg_namespace rn ON rn.oid=root.relnamespace
          JOIN pg_class child ON child.oid=tree.node JOIN pg_namespace cn ON cn.oid=child.relnamespace
          WHERE rn.nspname='public' AND (cn.nspname<>'public' OR child.relkind NOT IN ('r','p') OR child.relrowsecurity)) AS unsafe`);
      if (descendants[0]?.unsafe !== false) throw denied();
      // PUBLIC grants can otherwise bypass an explicit REVOKE from the query role.
      const safe = await run(application, `SELECT NOT has_database_privilege($1,current_database(),'TEMP,CREATE')
        AND NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='fleur_internal' AND has_schema_privilege($1,oid,'USAGE'))
        AND NOT EXISTS(SELECT 1 FROM pg_namespace WHERE left(nspname,3)<>'pg_' AND nspname<>'information_schema' AND has_schema_privilege($1,oid,'CREATE'))
        AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND p.prosecdef AND has_function_privilege($1,p.oid,'EXECUTE'))
        AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND (pg_has_role($1,c.relowner,'MEMBER') OR (c.relkind IN ('r','p','v','m','f') AND (has_table_privilege($1,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege($1,c.oid,'INSERT,UPDATE,REFERENCES') OR ((n.nspname<>'public' OR c.relkind NOT IN ('r','p')) AND (has_table_privilege($1,c.oid,'SELECT') OR has_any_column_privilege($1,c.oid,'SELECT'))))) OR (c.relkind='S' AND has_sequence_privilege($1,c.oid,'USAGE,SELECT,UPDATE')))) AS safe`, [agentQueryRole]);
      if (safe[0]?.safe !== true) throw denied();
    }
    const verified = await run(sql, "SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AND NOT rolinherit AND rolconnlimit=4 AND rolconfig @> ARRAY['temp_file_limit=16MB'] AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AND NOT has_parameter_privilege(r.oid,'temp_file_limit','SET') AND NOT EXISTS(SELECT 1 FROM pg_db_role_setting WHERE setrole=r.oid AND setdatabase<>0) AS safe FROM pg_roles r WHERE rolname=$1", [agentQueryRole]);
    if (verified[0]?.safe !== true) throw denied();
  } finally { await run(sql, "SELECT pg_advisory_unlock(713406329874::bigint)"); }
}
