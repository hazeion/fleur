export interface CleanupConnection { unsafe(statement:string):PromiseLike<unknown>; }
export type CancellationResult='applied'|'absent'|'failed';
export class CleanupLease {
 private expired=false;
 expire():void {this.expired=true;}
 assertActive():void {if(this.expired) throw new Error('CLEANUP_EXPIRED');}
 async verify(connection:CleanupConnection,cancellation:Promise<CancellationResult>|undefined,pending:Promise<unknown>|undefined,rollback:boolean):Promise<void> {
  this.assertActive();
  if (cancellation) {
   const result=await cancellation;
   this.assertActive();
   if (result==='failed') throw new Error('Uncertain control cancellation');
  }
  if (pending) {
   await pending.catch(()=>{});
   this.assertActive();
  }
  if (rollback) {
   this.assertActive();
   await connection.unsafe('ROLLBACK');
   this.assertActive();
  }
  this.assertActive();
  await connection.unsafe('SELECT 1');
  this.assertActive();
 }
}
