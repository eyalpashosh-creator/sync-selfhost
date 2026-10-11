ALTER TABLE users ADD COLUMN email_updates integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE users ADD COLUMN match_alerts integer NOT NULL DEFAULT 1;
