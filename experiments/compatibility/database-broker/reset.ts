import { SQL } from 'bun';
if (!process.env.FLEUR_DISPOSABLE_DATABASE_URL || process.env.FLEUR_DISPOSABLE_DATABASE_VERIFIED!=='1') throw new Error('Owned disposable target required');
const pool=new SQL(process.env.FLEUR_DISPOSABLE_DATABASE_URL,{max:1});
try {
 const rows=await pool.unsafe("SELECT current_database() AS database,current_user AS username,current_setting('server_version_num') AS version");
 if (rows[0].database!==process.env.FLEUR_DISPOSABLE_DATABASE_NAME||rows[0].username!==process.env.FLEUR_DISPOSABLE_DATABASE_NAME||rows[0].version!=='180006') throw new Error('Owned target identity mismatch');
 await pool.unsafe('TRUNCATE exercise_child,exercise');
 await pool.unsafe("INSERT INTO exercise VALUES (1,'Squat',1)");
} finally {await pool.close();}
