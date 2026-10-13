import { SQL } from 'bun';
if (!process.env.FLEUR_DISPOSABLE_DATABASE_URL || process.env.FLEUR_DISPOSABLE_DATABASE_VERIFIED !== '1') throw new Error('Use uniquely owned run.py database');
const pool=new SQL(process.env.FLEUR_DISPOSABLE_DATABASE_URL,{max:1});
try {
 const rows=await pool.unsafe("SELECT current_database() AS database, current_user AS username, current_setting('server_version_num') AS version");
 const row=rows[0];
 if (row.database!==process.env.FLEUR_DISPOSABLE_DATABASE_NAME || row.username!==process.env.FLEUR_DISPOSABLE_DATABASE_NAME || row.version!=='180006') throw new Error('Disposable target identity/version differs');
 await pool.unsafe('CREATE TABLE exercise (id integer PRIMARY KEY, name text NOT NULL, version integer NOT NULL CHECK(version>0))');
 await pool.unsafe('CREATE TABLE exercise_child (id integer PRIMARY KEY, exercise_id integer NOT NULL REFERENCES exercise(id), label text NOT NULL)');
 await pool.unsafe("INSERT INTO exercise VALUES (1,'Squat',1)");
 console.log(JSON.stringify({databaseIdentityVerified:true,postgresVersion:'18.6'}));
} finally {await pool.close();}
