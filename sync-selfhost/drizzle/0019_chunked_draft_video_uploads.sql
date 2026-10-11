CREATE TABLE `draft_upload_sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `invite_id` integer NOT NULL,
  `curator_user_id` integer NOT NULL,
  `filename` text NOT NULL,
  `mime_type` text NOT NULL,
  `total_bytes` integer NOT NULL,
  `total_chunks` integer NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`invite_id`) REFERENCES `collaborations`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`curator_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `draft_upload_sessions_invite_idx` ON `draft_upload_sessions` (`invite_id`);
--> statement-breakpoint
CREATE INDEX `draft_upload_sessions_curator_idx` ON `draft_upload_sessions` (`curator_user_id`);
--> statement-breakpoint
CREATE TABLE `draft_upload_chunks` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `upload_id` text NOT NULL,
  `chunk_index` integer NOT NULL,
  `byte_length` integer NOT NULL,
  `bytes` blob NOT NULL,
  FOREIGN KEY (`upload_id`) REFERENCES `draft_upload_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `draft_upload_chunks_upload_chunk_idx` ON `draft_upload_chunks` (`upload_id`,`chunk_index`);
--> statement-breakpoint
CREATE INDEX `draft_upload_chunks_upload_idx` ON `draft_upload_chunks` (`upload_id`);