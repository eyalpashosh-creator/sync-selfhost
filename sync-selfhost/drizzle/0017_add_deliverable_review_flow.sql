ALTER TABLE collaboration_workspaces ADD COLUMN deliverable_stage text NOT NULL DEFAULT 'waiting_draft';
--> statement-breakpoint
ALTER TABLE collaboration_workspaces ADD COLUMN draft_blob_key text;
--> statement-breakpoint
ALTER TABLE collaboration_workspaces ADD COLUMN draft_mime_type text;
--> statement-breakpoint
ALTER TABLE collaboration_workspaces ADD COLUMN draft_filename text;
--> statement-breakpoint
ALTER TABLE collaboration_workspaces ADD COLUMN revision_rounds_used integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE collaboration_deliverable_events (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  invite_id integer NOT NULL REFERENCES collaborations(id) ON DELETE cascade,
  event_type text NOT NULL,
  label text NOT NULL,
  detail text NOT NULL DEFAULT '',
  created_at integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX collaboration_deliverable_events_invite_idx ON collaboration_deliverable_events (invite_id);
--> statement-breakpoint
CREATE INDEX collaboration_deliverable_events_created_idx ON collaboration_deliverable_events (created_at);