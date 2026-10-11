ALTER TABLE campaign_invites ADD COLUMN resolve_requested_by_role TEXT;
--> statement-breakpoint
ALTER TABLE campaign_invites ADD COLUMN resolve_requested_at INTEGER;
