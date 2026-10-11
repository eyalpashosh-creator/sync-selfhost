ALTER TABLE users ADD COLUMN role TEXT;
--> statement-breakpoint
ALTER TABLE users ADD COLUMN username TEXT;
--> statement-breakpoint
ALTER TABLE user_sessions ADD COLUMN role TEXT;
--> statement-breakpoint
ALTER TABLE curator_profiles ADD COLUMN platform_stats TEXT NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE curator_profiles ADD COLUMN rates_terms TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE curator_profiles ADD COLUMN portfolio_links TEXT NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE curator_profiles ADD COLUMN advertised INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE campaign_invites ADD COLUMN accepted_at INTEGER;
--> statement-breakpoint
ALTER TABLE campaign_invites ADD COLUMN live_at INTEGER;
--> statement-breakpoint
CREATE TABLE collaboration_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  invite_id INTEGER NOT NULL,
  sender_user_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (invite_id) REFERENCES campaign_invites(id) ON UPDATE NO ACTION ON DELETE CASCADE,
  FOREIGN KEY (sender_user_id) REFERENCES users(id) ON UPDATE NO ACTION ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX collaboration_messages_invite_idx ON collaboration_messages(invite_id);
--> statement-breakpoint
CREATE INDEX collaboration_messages_created_idx ON collaboration_messages(created_at);
--> statement-breakpoint
CREATE TABLE collaboration_workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  invite_id INTEGER NOT NULL UNIQUE,
  draft_ready INTEGER NOT NULL DEFAULT 0,
  revisions_complete INTEGER NOT NULL DEFAULT 0,
  posted_live INTEGER NOT NULL DEFAULT 0,
  live_link TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (invite_id) REFERENCES campaign_invites(id) ON UPDATE NO ACTION ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX collaboration_workspaces_invite_idx ON collaboration_workspaces(invite_id);