PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE collaborations_next (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  campaign_id INTEGER NOT NULL,
  curator_user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'invited',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  accepted_at INTEGER,
  live_at INTEGER,
  resolve_requested_by_role TEXT,
  resolve_requested_at INTEGER,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON UPDATE NO ACTION ON DELETE CASCADE,
  FOREIGN KEY (curator_user_id) REFERENCES users(id) ON UPDATE NO ACTION ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO collaborations_next (id, campaign_id, curator_user_id, status, created_at, updated_at, accepted_at, live_at, resolve_requested_by_role, resolve_requested_at)
SELECT id, campaign_id, curator_user_id, status, created_at, updated_at, accepted_at, live_at, resolve_requested_by_role, resolve_requested_at FROM collaborations;
--> statement-breakpoint
DROP TABLE collaborations;
--> statement-breakpoint
ALTER TABLE collaborations_next RENAME TO collaborations;
--> statement-breakpoint
CREATE INDEX campaign_invites_campaign_idx ON collaborations(campaign_id);
--> statement-breakpoint
CREATE INDEX campaign_invites_curator_idx ON collaborations(curator_user_id);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
