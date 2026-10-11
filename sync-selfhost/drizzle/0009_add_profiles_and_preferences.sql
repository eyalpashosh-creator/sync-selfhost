ALTER TABLE `users` ADD `bio` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `users` ADD `avatar_blob_key` text;
--> statement-breakpoint
ALTER TABLE `users` ADD `notify_invites` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `users` ADD `notify_messages` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `users` ADD `notify_deliverables` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `users` ADD `preferred_platforms` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE `users` ADD `content_styles` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE `users` ADD `default_terms` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `users` ADD `turnaround` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `users` ADD `advertise_boost` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `users` ADD `discoverable` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `users` ADD `available` integer DEFAULT 1 NOT NULL;