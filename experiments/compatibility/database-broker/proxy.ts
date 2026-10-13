import { createServer, connect, type Socket } from 'node:net';

// Controlled trusted test transport. The worker cannot choose a proxy target.
export async function commitFaultProxy(ownedUrl:string, mode:'drop'|'hold'|'rollback'|'verification') {
 const target=new URL(ownedUrl);
 if (process.env.FLEUR_DISPOSABLE_DATABASE_VERIFIED!=='1' || target.hostname!=='127.0.0.1' || !target.pathname.startsWith('/fleur_probe_')) throw new Error('Owned loopback test target required');
 const connections=new Set<Socket>();
 let intercepted=0;
 let verificationRequested=false;
 let closed=false;
 const server=createServer(frontend=>{
  const upstream=connect({host:'127.0.0.1',port:Number(target.port)});
  connections.add(frontend);connections.add(upstream);
  let pending=Buffer.alloc(0);
  let withheld=false;
  for (const socket of [frontend,upstream]) {
   socket.setTimeout(6000,()=>socket.destroy());
   socket.on('error',()=>{frontend.destroy();upstream.destroy();});
   socket.on('close',()=>{connections.delete(socket);frontend.destroy();upstream.destroy();});
  }
  // Inspect bounded frontend frames only to identify the trusted cleanup statement.
  let startup=true;
  let clientPending=Buffer.alloc(0);
  frontend.on('data',chunk=>{
   clientPending=Buffer.concat([clientPending,typeof chunk==='string'?Buffer.from(chunk):chunk]);
   if (clientPending.length>1024*1024) {frontend.destroy();upstream.destroy();return;}
   for (;;) {
    if (startup) {
     if (clientPending.length<4) return;
     const size=clientPending.readInt32BE(0);
     if (size<8||size>1024*1024) {frontend.destroy();upstream.destroy();return;}
     if (clientPending.length<size) return;
     clientPending=clientPending.subarray(size);startup=false;
    }
    if (clientPending.length<5) return;
    const size=clientPending.readInt32BE(1);
    if (size<4||size>1024*1024) {frontend.destroy();upstream.destroy();return;}
    if (clientPending.length<size+1) return;
    const frame=clientPending.subarray(0,size+1);clientPending=clientPending.subarray(size+1);
    if (frame[0]===81||frame[0]===80) {
     const payload=frame.subarray(5);
     const sqlStart=frame[0]===80 ? payload.indexOf(0)+1 : 0;
     const sqlEnd=payload.indexOf(0,sqlStart);
     if (sqlEnd>=sqlStart) verificationRequested=payload.subarray(sqlStart,sqlEnd).toString('utf8').trim().toUpperCase()==='SELECT 1';
    }
   }
  });
  frontend.pipe(upstream);
  upstream.on('data',chunk=>{
   if (withheld || closed) return;
   pending=Buffer.concat([pending,typeof chunk==='string' ? Buffer.from(chunk) : chunk]);
   if (pending.length>1024*1024) {frontend.destroy();upstream.destroy();return;}
   while (pending.length>=5) {
    const length=pending.readInt32BE(1);
    if (length<4||length>1024*1024) {frontend.destroy();upstream.destroy();return;}
    if (pending.length<length+1) return;
    const frame=pending.subarray(0,length+1);
    pending=pending.subarray(length+1);
    const tag=frame.subarray(5).toString('utf8');
    const fault=(mode==='drop'||mode==='hold') ? tag==='COMMIT\0' : mode==='rollback' ? tag==='ROLLBACK\0' : verificationRequested && tag==='SELECT 1\0';
    if (frame[0]===67 && fault) {
     intercepted++;
     // CommandComplete proves PostgreSQL committed, but no frontend receives this acknowledgement.
     withheld=true;
     if (mode==='drop') {frontend.destroy();upstream.destroy();}
     return;
    }
    if (!frontend.write(frame)) {upstream.pause();frontend.once('drain',()=>upstream.resume());}
   }
  });
 });
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve());});
 const address=server.address();
 if (!address || typeof address==='string') throw new Error('Loopback proxy did not bind');
 const url=new URL(ownedUrl);url.port=String(address.port);url.searchParams.set('sslmode','disable');
 return {
  url:url.toString(),
  intercepted:()=>intercepted,
  async close() {
   closed=true;
   for (const socket of connections) socket.destroy();
   await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  },
 };
}
