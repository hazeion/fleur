import { SQL } from "bun";
import { quote } from "./inspection";
import { PrivilegeInsufficient } from "./privilege";

/** Private host implementation detail. Never put this identity or credential in public results. */
export const agentQueryRole = "fleur_agent_query_v1";
const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const denied = () => new PrivilegeInsufficient("agent query provisioning");

/** The development cluster's superuser owns this policy. No application or production target calls it. */
export async function provisionAgentQueryRole(control: SQL, password: string, application?: SQL): Promise<void> {
  if (!/^[a-f0-9-]{36}$/.test(password)) throw denied();
  const name = quote(agentQueryRole);
  if ((await control.unsafe("SELECT rolsuper FROM pg_roles WHERE rolname=current_user"))[0]?.rolsuper !== true) throw denied();
  // Serialize concurrent verification and password rotation in the control database only.
  const sql = control;
  await sql.unsafe("SET statement_timeout='5s'");
  await sql.unsafe("SELECT pg_advisory_lock(713406329874::bigint)");
  try {
    if (!(await sql.unsafe("SELECT 1 FROM pg_roles WHERE rolname=$1", [agentQueryRole])).length) await sql.unsafe(`CREATE ROLE ${name}`);
    await sql.unsafe(`ALTER ROLE ${name} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 4 PASSWORD ${literal(password)}`);
    for (const row of await sql.unsafe("SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid WHERE m.member=(SELECT oid FROM pg_roles WHERE rolname=$1)", [agentQueryRole])) await sql.unsafe(`REVOKE ${quote(String(row.rolname))} FROM ${name}`);
    await sql.unsafe(`ALTER ROLE ${name} RESET ALL`);
    await sql.unsafe(`ALTER ROLE ${name} SET statement_timeout='5s'`);
    await sql.unsafe(`ALTER ROLE ${name} SET idle_in_transaction_session_timeout='5s'`);
    await sql.unsafe(`ALTER ROLE ${name} SET temp_file_limit='16MB'`);
    await sql.unsafe(`REVOKE SET ON PARAMETER temp_file_limit FROM ${name}`);
    // PUBLIC cannot carry CONNECT/TEMP into current or future verification targets.
    const appName = application ? String((await application.unsafe("SELECT current_database() AS name"))[0].name) : undefined;
    await sql.begin(async policy => {
    const owner = String((await policy.unsafe("SELECT current_user AS name"))[0].name);
    for (const row of await policy.unsafe("SELECT datname,pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname <> 'template0'")) {
      const database = quote(String(row.datname));
      await policy.unsafe(`REVOKE CONNECT,TEMP ON DATABASE ${database} FROM PUBLIC,${name}`);
      await policy.unsafe(`GRANT CONNECT,TEMP ON DATABASE ${database} TO ${quote(String(row.owner))},${quote(owner)}`);
    }
    if (appName) await policy.unsafe(`GRANT CONNECT ON DATABASE ${quote(appName)} TO ${name}`);
    });
    if (application) {
      // An unexpected owned object is not safe to repair by granting privileges.
      const owned = await application.unsafe("SELECT EXISTS(SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=(SELECT oid FROM pg_roles WHERE rolname=$1) AND deptype='o') AS owned", [agentQueryRole]);
      if (owned[0]?.owned !== false) throw denied();
      for (const row of await application.unsafe("SELECT nspname FROM pg_namespace WHERE left(nspname,3)<>'pg_' AND nspname <> 'information_schema'")) {
        const schema = quote(String(row.nspname));
        await application.unsafe(`REVOKE ALL ON SCHEMA ${schema} FROM ${name}; REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM ${name}; REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schema} FROM ${name}; REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${schema} FROM ${name}`);
      }
      await application.unsafe(`GRANT USAGE ON SCHEMA public TO ${name}`);
      for (const table of await application.unsafe("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p')")) await application.unsafe(`GRANT SELECT ON public.${quote(String(table.relname))} TO ${name}`);
      const owners = await application.unsafe("SELECT DISTINCT pg_get_userbyid(relowner) AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' UNION SELECT current_user");
      for (const owner of owners) await application.unsafe(`ALTER DEFAULT PRIVILEGES FOR ROLE ${quote(String(owner.name))} IN SCHEMA public GRANT SELECT ON TABLES TO ${name}`);
      // PUBLIC grants can otherwise bypass an explicit REVOKE from the query role.
      const safe = await application.unsafe(`SELECT NOT has_database_privilege($1,current_database(),'TEMP,CREATE')
        AND NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='fleur_internal' AND has_schema_privilege($1,oid,'USAGE'))
        AND NOT EXISTS(SELECT 1 FROM pg_namespace WHERE left(nspname,3)<>'pg_' AND nspname<>'information_schema' AND has_schema_privilege($1,oid,'CREATE'))
        AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND p.prosecdef AND has_function_privilege($1,p.oid,'EXECUTE'))
        AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND (pg_has_role($1,c.relowner,'MEMBER') OR (c.relkind IN ('r','p','v','m','f') AND (has_table_privilege($1,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege($1,c.oid,'INSERT,UPDATE,REFERENCES') OR ((n.nspname<>'public' OR c.relkind NOT IN ('r','p')) AND has_table_privilege($1,c.oid,'SELECT')))) OR (c.relkind='S' AND has_sequence_privilege($1,c.oid,'USAGE,SELECT,UPDATE')))) AS safe`, [agentQueryRole]);
      if (safe[0]?.safe !== true) throw denied();
    }
    const verified = await sql.unsafe("SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AND NOT rolinherit AND rolconnlimit=4 AND rolconfig @> ARRAY['temp_file_limit=16MB'] AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AND NOT has_parameter_privilege(r.oid,'temp_file_limit','SET') AND NOT EXISTS(SELECT 1 FROM pg_db_role_setting WHERE setrole=r.oid AND setdatabase<>0) AS safe FROM pg_roles r WHERE rolname=$1", [agentQueryRole]);
    if (verified[0]?.safe !== true) throw denied();
  } finally { await sql.unsafe("SELECT pg_advisory_unlock(713406329874::bigint)"); }
}
