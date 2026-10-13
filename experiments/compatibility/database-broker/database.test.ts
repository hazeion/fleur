import { afterAll, beforeEach, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { Broker } from './broker';
// Only run.py creates this URL after verifying the container's unique ownership label.
const url=process.env.FLEUR_DISPOSABLE_DATABASE_URL;
if (!url || process.env.FLEUR_DISPOSABLE_DATABASE_VERIFIED !== '1') throw new Error('Use run.py; no supplied development database is accepted');
const pool=new SQL(url,{max:3});
const querySession={operation:'compat.query',token:'probe-query'} as const;
const mutationSession={operation:'compat.mutation',token:'probe-mutation'} as const;
const queryBroker=new Broker(pool,querySession);
const broker=new Broker(pool,mutationSession);
const read={kind:'broker-request',operation:'compat.query',token:'probe-query',action:'readExercise',input:{id:1}};
const save=(extra:Record<string,unknown>={}) => ({kind:'broker-request',operation:'compat.mutation',token:'probe-mutation',action:'saveExercise',input:{id:1,expectedVersion:1,name:'Renamed',...extra}});
beforeEach(async () => {
 await pool.unsafe('TRUNCATE exercise_child, exercise');
 await pool.unsafe("INSERT INTO exercise VALUES (1,'Squat',1)");
});
afterAll(async () => {await pool.close();});
test('registered read executes internal Drizzle SQL over Bun SQL',async () => {
 expect(await queryBroker.dispatch(read)).toEqual({kind:'broker-response',ok:true,value:{id:1,name:'Squat',version:1}});
});
test('invalid public output rolls back parent and child writes',async () => {
 expect(await broker.dispatch(save({invalidOutput:true}))).toEqual({kind:'broker-response',ok:false,code:'INVALID_OUTPUT'});
 expect(await queryBroker.dispatch(read)).toEqual({kind:'broker-response',ok:true,value:{id:1,name:'Squat',version:1}});
 expect(await pool.unsafe('SELECT count(*)::integer AS count FROM exercise_child')).toEqual([expect.objectContaining({count:0})]);
});
test('child constraint failure rolls back the entire multi-row mutation',async () => {
 expect(await broker.dispatch(save({invalidChild:true}))).toEqual({kind:'broker-response',ok:false,code:'DATABASE_FAILURE'});
 expect((await queryBroker.dispatch(read))).toEqual({kind:'broker-response',ok:true,value:{id:1,name:'Squat',version:1}});
 expect((await pool.unsafe('SELECT count(*)::integer AS count FROM exercise_child'))[0].count).toBe(0);
});
test('two expected-version writers have exactly one winner',async () => {
 const responses=await Promise.all([broker.dispatch(save()),broker.dispatch(save({name:'Competitor'}))]);
 expect(responses.filter(x=>x.ok)).toHaveLength(1);
 expect(responses.filter(x=>!x.ok)).toEqual([{kind:'broker-response',ok:false,code:'VERSION_CONFLICT'}]);
 expect((await pool.unsafe('SELECT version FROM exercise WHERE id=1'))[0].version).toBe(2);
});
test('deadline cancels PostgreSQL work, rolls back and safely reuses a one-slot pool',async () => {
 const single=new SQL(url,{max:1});
 try {
 const bounded=new Broker(single,mutationSession);
 const start=performance.now();
 expect(await bounded.dispatch(save({delayMs:3000}),100)).toEqual({kind:'broker-response',ok:false,code:'DEADLINE'});
 expect(performance.now()-start).toBeLessThan(2000);
 expect(await new Broker(single,querySession).dispatch(read)).toEqual({kind:'broker-response',ok:true,value:{id:1,name:'Squat',version:1}});
 expect((await single.unsafe('SELECT count(*)::integer AS count FROM exercise_child'))[0].count).toBe(0);
 expect(await new Broker(single,mutationSession).dispatch(save())).toEqual({kind:'broker-response',ok:true,value:{id:1,name:'Renamed',version:2}});
 } finally {await single.close();}
});
test('slow work is isolated from an admitted healthy query',async () => {
 const slow=broker.dispatch(save({delayMs:3000}),200);
 const start=performance.now();
 expect((await queryBroker.dispatch(read)).ok).toBe(true);
 expect(performance.now()-start).toBeLessThan(1000);
 expect((await slow).ok).toBe(false);
});
test('a lost response after commit is unknown and does not undo or replay the write',async () => {
 expect(await broker.dispatch(save(),5000,true)).toEqual({kind:'broker-response',ok:false,code:'OUTCOME_UNKNOWN'});
 expect(await queryBroker.dispatch(read)).toEqual({kind:'broker-response',ok:true,value:{id:1,name:'Renamed',version:2}});
 expect((await pool.unsafe('SELECT count(*)::integer AS count FROM exercise_child'))[0].count).toBe(1);
});
test('Read Committed has statement snapshots and a real read-only runtime boundary',async () => {
 const connection=await pool.reserve();
 try {
 console.error('[DEBUG-db23] snapshot:begin');
 await connection.unsafe('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
 console.error('[DEBUG-db23] snapshot:read');
 expect((await connection.unsafe('SELECT name FROM exercise WHERE id=1'))[0].name).toBe('Squat');
 console.error('[DEBUG-db23] snapshot:writer');
 await pool.unsafe("UPDATE exercise SET name='Changed' WHERE id=1");
 console.error('[DEBUG-db23] snapshot:read');
 expect((await connection.unsafe('SELECT name FROM exercise WHERE id=1'))[0].name).toBe('Changed');
 console.error('[DEBUG-db23] snapshot:readonly-negative');
 await expect(connection.unsafe("UPDATE exercise SET name='Denied' WHERE id=1")).rejects.toMatchObject({code:'25006'});
 console.error('[DEBUG-db23] snapshot:rollback');
 await connection.unsafe('ROLLBACK');
 } finally {console.error('[DEBUG-db23] snapshot:release');connection.release();}
});

test('query channel denies a valid known mutation request without changing data',async () => {
 expect(await queryBroker.dispatch(save())).toEqual({kind:'broker-response',ok:false,code:'REQUEST_DENIED'});
 expect(await queryBroker.dispatch(read)).toEqual({kind:'broker-response',ok:true,value:{id:1,name:'Squat',version:1}});
});
test('queued reservation consumes the deadline and cannot later execute a cancelled mutation',async () => {
 const single=new SQL(url,{max:1});
 const held=await single.reserve();
 try {
 const queued=new Broker(single,mutationSession);
 const start=performance.now();
 expect(await queued.dispatch(save(),100)).toEqual({kind:'broker-response',ok:false,code:'DEADLINE'});
 expect(performance.now()-start).toBeLessThan(1000);
 } finally {held.release();}
 try {expect(await new Broker(single,querySession).dispatch(read)).toEqual({kind:'broker-response',ok:true,value:{id:1,name:'Squat',version:1}});} finally {await single.close();}
});

test('terminated request worker rolls back its written transaction and leaves healthy work usable',async () => {
 const worker=Bun.spawn([process.execPath,'worker.ts'],{stdout:'pipe',stderr:'pipe'});
 const gone=new AbortController();
 void worker.exited.then(()=>gone.abort());
 try {
 const message=await worker.stdout.getReader().read();
 if (!message.value) throw new Error('worker did not send registered request');
 const request:unknown=JSON.parse(new TextDecoder().decode(message.value));
 const work=broker.dispatch(request,5000,false,gone.signal);
 const expires=performance.now()+2000;
 for (;;) {
 const active=await pool.unsafe("SELECT count(*)::integer AS count FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND wait_event='PgSleep'");
 if (active[0].count>0) break;
 if (performance.now()>expires) throw new Error('transaction never reached controlled sleep');
 await Bun.sleep(10);
 }
 expect((await queryBroker.dispatch(read)).ok).toBe(true);
 worker.kill();
 await worker.exited;
 expect((await work).ok).toBe(false);
 expect(await queryBroker.dispatch(read)).toEqual({kind:'broker-response',ok:true,value:{id:1,name:'Squat',version:1}});
 expect((await pool.unsafe('SELECT count(*)::integer AS count FROM exercise_child'))[0].count).toBe(0);
 } finally {worker.kill();await worker.exited;}
});

test('actual lost PostgreSQL COMMIT acknowledgement reports unknown with exactly one persisted write',async () => {
 const {commitFaultProxy}=await import('./proxy');
 const proxy=await commitFaultProxy(url,'drop');
 const faulty=new SQL(proxy.url,{max:1});
 try {
 const writer=new Broker(faulty,mutationSession);
 expect(await writer.dispatch(save(),1000)).toEqual({kind:'broker-response',ok:false,code:'OUTCOME_UNKNOWN'});
 expect(proxy.intercepted()).toBe(1);
 expect(await queryBroker.dispatch(read)).toEqual({kind:'broker-response',ok:true,value:{id:1,name:'Renamed',version:2}});
 expect((await pool.unsafe('SELECT count(*)::integer AS count FROM exercise_child'))[0].count).toBe(1);
 } finally {await faulty.close();await proxy.close();}
});

test('withheld COMMIT acknowledgement consumes the operation deadline and never reports rollback',async () => {
 const {commitFaultProxy}=await import('./proxy');
 const proxy=await commitFaultProxy(url,'hold');
 const faulty=new SQL(proxy.url,{max:1});
 try {
 const start=performance.now();
 expect(await new Broker(faulty,mutationSession).dispatch(save(),100)).toEqual({kind:'broker-response',ok:false,code:'OUTCOME_UNKNOWN'});
 expect(performance.now()-start).toBeLessThan(2000);
 expect(proxy.intercepted()).toBe(1);
 expect(await queryBroker.dispatch(read)).toEqual({kind:'broker-response',ok:true,value:{id:1,name:'Renamed',version:2}});
 } finally {await faulty.close();await proxy.close();}
});

test('successive current-version saves advance versions and update the child atomically',async () => {
 expect((await broker.dispatch(save())).ok).toBe(true);
 expect(await broker.dispatch(save({expectedVersion:2,name:'Second save'}))).toEqual({kind:'broker-response',ok:true,value:{id:1,name:'Second save',version:3}});
 expect((await pool.unsafe('SELECT label FROM exercise_child WHERE exercise_id=1'))[0].label).toBe('Second save');
 expect((await pool.unsafe('SELECT count(*)::integer AS count FROM exercise_child'))[0].count).toBe(1);
});

test('stalled rollback acknowledgement cannot leave the public operation pending or reuse uncertain authority',async () => {
 const {commitFaultProxy}=await import('./proxy');
 const proxy=await commitFaultProxy(url,'rollback');
 const faulty=new SQL(proxy.url,{max:1});
 try {
 const start=performance.now();
 expect(await new Broker(faulty,mutationSession).dispatch(save({invalidOutput:true}),1000)).toEqual({kind:'broker-response',ok:false,code:'INVALID_OUTPUT'});
 expect(performance.now()-start).toBeLessThan(1000);
 expect(proxy.intercepted()).toBe(1);
 expect(await queryBroker.dispatch(read)).toEqual({kind:'broker-response',ok:true,value:{id:1,name:'Squat',version:1}});
 } finally {await faulty.close({timeout:0});await proxy.close();}
});

test('stalled idle verification discards authority while preserving established commit success',async () => {
 const {commitFaultProxy}=await import('./proxy');
 const proxy=await commitFaultProxy(url,'verification');
 const faulty=new SQL(proxy.url,{max:1});
 try {
 const start=performance.now();
 expect(await new Broker(faulty,mutationSession).dispatch(save(),1000)).toEqual({kind:'broker-response',ok:true,value:{id:1,name:'Renamed',version:2}});
 expect(performance.now()-start).toBeLessThan(1500);
 expect(proxy.intercepted()).toBe(1);
 expect(await queryBroker.dispatch(read)).toEqual({kind:'broker-response',ok:true,value:{id:1,name:'Renamed',version:2}});
 } finally {await faulty.close({timeout:0});await proxy.close();}
});
