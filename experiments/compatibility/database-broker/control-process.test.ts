import {expect,test} from 'bun:test';
import {startOwnedControl,ownControl} from './control-process';
test('a replied control client cannot retain a live process while private shutdown stalls',async()=>{
 const child=Bun.spawn([process.execPath,'-e',"console.log('READY');await Bun.stdin.text();console.log(JSON.stringify({result:'applied'}));setInterval(()=>{},1000)"],{stdin:'pipe',stdout:'pipe',stderr:'ignore'});
 const ready=child.stdout.getReader();
 try {expect(new TextDecoder().decode((await ready.read()).value)).toBe('READY\n');}
 catch(error){child.kill('SIGKILL');await child.exited;throw error;}
 finally {ready.releaseLock();}
 const owned=ownControl(child,{},250);
 try {
  const verdict=await Promise.race([owned.result,new Promise<'lifetime-exceeded'>(resolve=>setTimeout(()=>resolve('lifetime-exceeded'),400))]);
  expect(verdict).toBe('applied');
  expect(owned.child.signalCode).toBe('SIGKILL');
 } finally {owned.child.kill('SIGKILL');await owned.child.exited;}
});
test('a silent private control client is killed at its own RPC deadline',async()=>{
 const owned=startOwnedControl([process.execPath,'-e','setInterval(()=>{},1000)'],{},process.env,250);
 try {
  const started=performance.now();
  expect(await owned.result).toBe('failed');
  expect(performance.now()-started).toBeLessThan(400);
  expect(owned.child.signalCode).toBe('SIGKILL');
 } finally {owned.child.kill('SIGKILL');await owned.child.exited;}
});
