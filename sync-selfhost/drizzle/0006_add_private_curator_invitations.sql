CREATE TABLE curator_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  user_id INTEGER NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  platforms TEXT NOT NULL,
  follower_count INTEGER NOT NULL DEFAULT 0,
  niches TEXT NOT NULL DEFAULT '',
  accepting_invites INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE NO ACTION ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX curator_profiles_accepting_idx ON curator_profiles(accepting_invites);
--> statement-breakpoint
CREATE TABLE campaign_invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  campaign_id INTEGER NOT NULL,
  curator_user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'invited',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON UPDATE NO ACTION ON DELETE CASCADE,
  FOREIGN KEY (curator_user_id) REFERENCES users(id) ON UPDATE NO ACTION ON DELETE CASCADE,
  UNIQUE(campaign_id, curator_user_id)
);
--> statement-breakpoint
CREATE INDEX campaign_invites_campaign_idx ON campaign_invites(campaign_id);
--> statement-breakpoint
CREATE INDEX campaign_invites_curator_idx ON campaign_invites(curator_user_id);
