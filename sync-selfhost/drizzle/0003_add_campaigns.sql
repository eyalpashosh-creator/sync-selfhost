CREATE TABLE campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  genre TEXT NOT NULL,
  mood TEXT NOT NULL,
  target_niche TEXT NOT NULL,
  platforms TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE NO ACTION ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX campaigns_user_id_idx ON campaigns(user_id);
--> statement-breakpoint
CREATE INDEX campaigns_created_at_idx ON campaigns(created_at);