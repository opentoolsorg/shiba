CREATE TABLE IF NOT EXISTS audit_log (
     id TEXT PRIMARY KEY,
     ts INTEGER NOT NULL,
     principal TEXT NOT NULL,
     tool TEXT NOT NULL,
     args_hash TEXT NOT NULL,
     outcome TEXT NOT NULL,
     detail TEXT
   );
