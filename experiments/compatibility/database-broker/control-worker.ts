import {SQL} from 'bun';
import {z} from 'zod';
const stop=setTimeout(()=>process.exit(1),250);
const request=z.strictObject({action:z.enum(['cancel','terminate']),pid:z.number().int().positive(),started:z.string().min(1).max(100)});
const target=z.object({adapter:z.literal('postgres'),hostname:z.literal('127.0.0.1'),port:z.number().int().min(1).max(65535),username:z.string().regex(/^fleur_probe_[a-f0-9]+$/),database:z.string().regex(/^fleur_probe_[a-f0-9]+$/),password:z.string().min(1)});
let pool:SQL|undefined;
let result:'applied'|'absent'|'failed'='failed';
try {
 const raw:unknown=JSON.parse(process.env.FLEUR_PRIVATE_CONTROL_OPTIONS??'null');
 const admitted=target.parse(raw);
 if(process.env.FLEUR_DISPOSABLE_DATABASE_VERIFIED!=='1'||process.env.FLEUR_DISPOSABLE_DATABASE_NAME!==admitted.database)throw new Error('Unverified disposable target');
 if(admitted.username!==admitted.database)throw new Error('Owned role differs');
 const input=request.parse(JSON.parse(await Bun.stdin.text()));
 pool=new SQL({...admitted,max:1,connectionTimeout:1,tls:false});
 const statement=input.action==='cancel'
  ? 'SELECT pg_cancel_backend(pid) AS applied FROM pg_stat_activity WHERE pid=$1 AND backend_start::text=$2 AND datname=current_database() AND usename=current_user'
  : 'SELECT pg_terminate_backend(pid,200) AS applied FROM pg_stat_activity WHERE pid=$1 AND backend_start::text=$2 AND datname=current_database() AND usename=current_user';
 const rows=z.array(z.strictObject({applied:z.boolean()})).parse(await pool.unsafe(statement,[input.pid,input.started]));
 result=rows.length===0?'absent':rows.length===1&&rows[0]?.applied===true?'applied':'failed';
} catch {result='failed';}
console.log(JSON.stringify({result}));
// The host kills and confirms this process after a reply or its own deadline.
// Its independent timer also bounds lifetime if the host disappears.
try {if(pool)await pool.close({timeout:0});}catch { /* Never disclose private driver errors. */ }
clearTimeout(stop);
