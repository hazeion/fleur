import { SQL } from 'bun';
import { Broker } from './broker';
import { createInterface } from 'node:readline';
if (!process.env.FLEUR_DISPOSABLE_DATABASE_URL || process.env.FLEUR_DISPOSABLE_DATABASE_VERIFIED !== '1') throw new Error('Only run.py owned database admission is supported');
const pool=new SQL(process.env.FLEUR_DISPOSABLE_DATABASE_URL,{max:3});
const broker=new Broker(pool,{operation:'compat.query',token:'probe-query'});
try {
 for await (const line of createInterface({input:process.stdin})) {
  let request:unknown;
  try {request=JSON.parse(line);} catch {request=null;}
  console.log(JSON.stringify(await broker.dispatch(request)));
 }
} finally {await pool.close();}
