import { SQL } from 'bun';
import { z } from 'zod';
import { drizzle } from 'drizzle-orm/bun-sql';
import { eq, and, sql as expression } from 'drizzle-orm';
import { pgTable, integer, text } from 'drizzle-orm/pg-core';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const read = z.strictObject({kind:z.literal('broker-request'), operation:z.literal('compat.query'), token:z.literal('probe-query'), action:z.literal('readExercise'), input:z.strictObject({id})});
const write = z.strictObject({kind:z.literal('broker-request'), operation:z.literal('compat.mutation'), token:z.literal('probe-mutation'), action:z.literal('saveExercise'), input:z.strictObject({id, expectedVersion:id, name:z.string().min(1).max(100), invalidOutput:z.boolean().optional(), invalidChild:z.boolean().optional(), delayMs:z.number().int().min(0).max(10000).optional()})});
const schema = z.union([read, write]);
export type Session = {readonly operation:'compat.query'|'compat.mutation';readonly token:string};
export function admit(request: unknown, session:Session) {
 const admitted=schema.parse(request);
 if (admitted.operation!==session.operation || admitted.token!==session.token) throw new Error('REQUEST_DENIED');
 return admitted;
}
const output = z.strictObject({id, name:z.string().min(1).max(100), version:id});
export const exercises = pgTable('exercise', {id:integer().primaryKey(), name:text().notNull(), version:integer().notNull()});
const children = pgTable('exercise_child', {id:integer().primaryKey(), exerciseId:integer('exercise_id').notNull().references(() => exercises.id), label:text().notNull()});
export type PublicExercise = z.infer<typeof output>;
export type Response = {kind:'broker-response';ok:true;value:PublicExercise|null} | {kind:'broker-response';ok:false;code:'REQUEST_DENIED'|'VERSION_CONFLICT'|'NOT_FOUND'|'INVALID_OUTPUT'|'DATABASE_FAILURE'|'DEADLINE'|'OUTCOME_UNKNOWN'};
export class Broker {
  constructor(private readonly pool:SQL, private readonly session:Session) {}
  async dispatch(request:unknown, deadlineMs=5000, loseResponse=false, workerSignal?:AbortSignal):Promise<Response> {
    let admitted:ReturnType<typeof admit>;
    try { admitted=admit(request,this.session); } catch { return {kind:'broker-response',ok:false,code:'REQUEST_DENIED'}; }
    const abort = new AbortController();
    const workerGone=() => abort.abort();
    workerSignal?.addEventListener('abort',workerGone,{once:true});
    if (workerSignal?.aborted) abort.abort();
    const timer=setTimeout(() => abort.abort(), deadlineMs);
    let connection:Awaited<ReturnType<SQL['reserve']>>|undefined;
    let committed=false;
    let commitAttempted=false;
    let activeQuery:ReturnType<SQL['unsafe']>|undefined;
    const cancelled=() => { if (abort.signal.aborted) throw new Error('DEADLINE'); };
    let backend:{pid:number;started:string}|undefined;
    let control:SQL|undefined;
    let cancellation:Promise<boolean>|undefined;
    const backendControl=async (action:'cancel'|'terminate') => {
      if (!backend) return false;
      control??=new SQL({...this.pool.options,max:1,connectionTimeout:1});
      let controlTimer:ReturnType<typeof setTimeout>|undefined;
      try {
        const statement=action==='cancel'
          ? 'SELECT pg_cancel_backend(pid) AS applied FROM pg_stat_activity WHERE pid=$1 AND backend_start::text=$2 AND datname=current_database() AND usename=current_user'
          : 'SELECT pg_terminate_backend(pid) AS applied FROM pg_stat_activity WHERE pid=$1 AND backend_start::text=$2 AND datname=current_database() AND usename=current_user';
        const result=await Promise.race([
          control.unsafe(statement,[backend.pid,backend.started]),
          new Promise<never>((_resolve,reject)=>{controlTimer=setTimeout(()=>reject(new Error('Control deadline')),250);}),
        ]);
        const rows=z.array(z.strictObject({applied:z.boolean()})).parse(result);
        return rows.length===1 && rows[0]?.applied===true;
      } catch {return false;}
      finally {if (controlTimer) clearTimeout(controlTimer);}
    };
    const onAbort=() => {
      activeQuery?.cancel();
      // Bun's native cancel alone did not settle the real PostgreSQL workload.
      // The trusted control connection targets only this verified borrowed backend.
      cancellation=backendControl('cancel');
    };
    const execute=async (query:{sql:string;params:unknown[]}) => {
      cancelled();
      if (!connection) throw new Error('DATABASE_FAILURE');
      activeQuery=connection.unsafe(query.sql,query.params);
      let rejectAbort:(()=>void)|undefined;
      const deadline=new Promise<never>((_resolve,reject)=>{
        rejectAbort=()=>reject(new Error('DEADLINE'));
        abort.signal.addEventListener('abort',rejectAbort,{once:true});
      });
      try {return z.array(z.unknown()).parse(await Promise.race([activeQuery,deadline]));}
      finally {
        if (rejectAbort) abort.signal.removeEventListener('abort',rejectAbort);
        activeQuery=undefined;
      }
    };
    abort.signal.addEventListener('abort',onAbort);
    try {
      connection=await this.pool.reserve({signal:abort.signal});
      cancelled();
      const identity=await execute({sql:'SELECT pg_backend_pid() AS pid,backend_start::text AS started FROM pg_stat_activity WHERE pid=pg_backend_pid()',params:[]});
      backend=z.strictObject({pid:z.number().int().positive(),started:z.string().min(1)}).parse(identity[0]);
      await execute({sql:admitted.operation==='compat.query' ? 'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY' : 'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE',params:[]});
      // PostgreSQL is the second enforcement boundary even if a read helper leaks.
      await execute({sql:"SET LOCAL statement_timeout = '5s'",params:[]});
      const db=drizzle(connection);
      let value:PublicExercise|null;
      if (admitted.operation==='compat.query') {
        const rows=await execute(db.select().from(exercises).where(eq(exercises.id,admitted.input.id)).toSQL());
        value=rows.length ? output.parse(rows[0]) : null;
      } else {
        const input=admitted.input;
        cancelled();
        const rows=await execute(db.update(exercises).set({name:input.name,version:expression`${exercises.version} + 1`}).where(and(eq(exercises.id,input.id),eq(exercises.version,input.expectedVersion))).returning().toSQL());
        if (!rows.length) {
          const existing=await execute(db.select({id:exercises.id}).from(exercises).where(eq(exercises.id,input.id)).toSQL());
          throw new Error(existing.length ? 'VERSION_CONFLICT' : 'NOT_FOUND');
        }
        await execute(db.insert(children).values({id:input.id,exerciseId:input.id,label:input.name}).onConflictDoUpdate({target:children.id,set:{label:input.name}}).toSQL());
        if (input.invalidChild) await execute({sql:'INSERT INTO exercise_child VALUES ($1,$2,$3)',params:[999999,999999,'bad reference']});
        try { value=output.parse(input.invalidOutput ? {...output.parse(rows[0]),version:0} : rows[0]); }
        catch { throw new Error('INVALID_OUTPUT'); }
        if (input.delayMs) {
          await execute({sql:'SELECT pg_sleep($1)',params:[input.delayMs/1000]});
        }

      }
      cancelled();
      commitAttempted=true;
      await execute({sql:'COMMIT',params:[]});
      committed=true;
      if (loseResponse) return {kind:'broker-response',ok:false,code:'OUTCOME_UNKNOWN'};
      return {kind:'broker-response',ok:true,value};
    } catch(error) {
      const code=error instanceof Error ? error.message : '';
      if (committed || commitAttempted) return {kind:'broker-response',ok:false,code:'OUTCOME_UNKNOWN'};
      if (abort.signal.aborted) return {kind:'broker-response',ok:false,code:'DEADLINE'};
      if (code==='VERSION_CONFLICT'||code==='NOT_FOUND'||code==='INVALID_OUTPUT') return {kind:'broker-response',ok:false,code};
      return {kind:'broker-response',ok:false,code:'DATABASE_FAILURE'};
    } finally {
      clearTimeout(timer);
      workerSignal?.removeEventListener('abort',workerGone);
      abort.signal.removeEventListener('abort',onAbort);
      if (connection) {
        const ownedConnection=connection;
        // Never reuse authority unless rollback and subsequent idle work both complete.
        let cleanupTimer:ReturnType<typeof setTimeout>|undefined;
        try {
          await Promise.race([
            (async()=>{
              if (cancellation) await cancellation;
              if (!committed) await ownedConnection.unsafe('ROLLBACK');
              await ownedConnection.unsafe('SELECT 1');
            })(),
            new Promise<never>((_resolve,reject)=>{
              cleanupTimer=setTimeout(()=>reject(new Error('Cleanup deadline')),250);
            }),
          ]);
          connection.release();
        } catch {
          // ReservedSQL.close closes the shared pool. Terminate only this exact owned backend instead.
          const terminated=await backendControl('terminate');
          if (terminated) connection.release();
          // Failed control leaves this reservation quarantined, never returned for reuse.
        } finally {
          if (cleanupTimer) clearTimeout(cleanupTimer);
          if (control) {try {await control.close({timeout:0});} catch { /* This pool owns only trusted control work. */ }}
        }

      }
    }
  }
}
