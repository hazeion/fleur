import {z} from 'zod';
export type ControlResult='applied'|'absent'|'failed';
const response=z.strictObject({result:z.enum(['applied','absent','failed'])});
function launch(command:string[],environment:Record<string,string|undefined>) {
 return Bun.spawn(command,{stdin:'pipe',stdout:'pipe',stderr:'ignore',env:environment});
}
const live=new Set<ReturnType<typeof launch>>();
process.once('exit',()=>{for(const child of live) child.kill('SIGKILL');});
function encode(input:unknown) {
 const encoded=JSON.stringify(input);
 if(typeof encoded!=='string'||new TextEncoder().encode(encoded).byteLength>4096)throw new Error('Control input invalid or exceeded bound');
 return encoded;
}
export function ownControl(child:ReturnType<typeof launch>,input:unknown,budgetMs=250,started=performance.now()) {
 const encoded=encode(input);
 live.add(child);
 void child.exited.then(()=>live.delete(child),()=>{});
 const result=(async():Promise<ControlResult>=>{
  const reader=child.stdout.getReader();
  let readFinished=false;
  const read=(async()=>{
   let bytes=0,text='';
   const decoder=new TextDecoder();
   try {
    while(!text.includes('\n')) {
     const chunk=await reader.read();
     if(chunk.done)throw new Error('Control ended without reply');
     bytes+=chunk.value.byteLength;
     if(bytes>4096)throw new Error('Control response exceeded bound');
     text+=decoder.decode(chunk.value,{stream:true});
    }
    const newline=text.indexOf('\n');
    if(text.slice(newline+1).trim())throw new Error('Unexpected additional control output');
    return response.parse(JSON.parse(text.slice(0,newline))).result;
   } finally {readFinished=true;reader.releaseLock();}
  })();
  let rpcTimer:ReturnType<typeof setTimeout>|undefined;
  let value:ControlResult='failed';
  try {
   child.stdin.write(encoded);child.stdin.end();
   value=await Promise.race([
    read,
    new Promise<ControlResult>(resolve=>{rpcTimer=setTimeout(()=>resolve('failed'),Math.max(0,budgetMs-(performance.now()-started)));}),
   ]);
  } catch {value='failed';}
  finally {
   if(rpcTimer)clearTimeout(rpcTimer);
   // SDK shutdown is not the lifetime boundary. OS-confirmed death closes every private socket.
   if(child.exitCode===null)child.kill('SIGKILL');
   let stopTimer:ReturnType<typeof setTimeout>|undefined;
   try {
    await Promise.race([
     (async()=>{
       await child.exited;
       if(!readFinished){try {await reader.cancel();} catch { /* It may have just released its lock. */ }}
       await read.catch(()=>{});
       try {await child.stdout.cancel();} catch { /* Closed streams hold no child resources. */ }
     })(),
     new Promise<never>((_resolve,reject)=>{stopTimer=setTimeout(()=>reject(new Error('CONTROL_EXIT_UNVERIFIED')),500);}),
    ]);
   } finally {if(stopTimer)clearTimeout(stopTimer);}
  }
  return value;
 })();
 return {child,result};
}

export function startOwnedControl(command:string[],input:unknown,environment:Record<string,string|undefined>,budgetMs=250) {
 encode(input); // Reject unserializable input before allocating any process.
 const started=performance.now();
 return ownControl(launch(command,environment),input,budgetMs,started);
}
