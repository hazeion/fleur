import {expect,test} from 'bun:test';
import {CleanupLease,type CleanupConnection} from './cleanup';
function deferred<T>() {
 let complete!:(value:T)=>void;
 const promise=new Promise<T>(resolve=>{complete=resolve;});
 return {promise,complete};
}
test('expired cleanup cannot issue SQL after its original statement settles',async()=>{
 const statement=deferred<unknown>();
 const calls:string[]=[];
 const connection:CleanupConnection={unsafe:async sql=>{calls.push(sql);}};
 const lease=new CleanupLease();
 const cleanup=lease.verify(connection,undefined,statement.promise,true);
 lease.expire(); // The broker retires/releases authority after the cleanup deadline.
 statement.complete(undefined);
 await expect(cleanup).rejects.toThrow('CLEANUP_EXPIRED');
 expect(calls).toEqual([]);
});
test('expired cleanup cannot issue idle verification after its rollback settles',async()=>{
 const rollback=deferred<unknown>();
 const entered=deferred<void>();
 const calls:string[]=[];
 const connection:CleanupConnection={unsafe:async sql=>{
  calls.push(sql);
  if (sql==='ROLLBACK') {entered.complete();return rollback.promise;}
 }};
 const lease=new CleanupLease();
 const cleanup=lease.verify(connection,undefined,undefined,true);
 await entered.promise;
 lease.expire();
 rollback.complete(undefined);
 await expect(cleanup).rejects.toThrow('CLEANUP_EXPIRED');
 expect(calls).toEqual(['ROLLBACK']);
});
test('expired cleanup cannot issue SQL after a cancellation acknowledgement arrives',async()=>{
 const cancellation=deferred<'applied'>();
 const calls:string[]=[];
 const connection:CleanupConnection={unsafe:async sql=>{calls.push(sql);}};
 const lease=new CleanupLease();
 const cleanup=lease.verify(connection,cancellation.promise,undefined,true);
 lease.expire();
 cancellation.complete('applied');
 await expect(cleanup).rejects.toThrow('CLEANUP_EXPIRED');
 expect(calls).toEqual([]);
});
