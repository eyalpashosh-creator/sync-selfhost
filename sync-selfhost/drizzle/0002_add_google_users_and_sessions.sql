DROP TABLE IF EXISTS entries;
--> statement-breakpoint
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_sign_in_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE user_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE NO ACTION ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX user_sessions_user_id_idx ON user_sessions(user_id);
--> statement-breakpoint
CREATE INDEX user_sessions_expires_at_idx ON user_sessions(expires_at);