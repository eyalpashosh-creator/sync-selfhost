ALTER TABLE `user_reports` ADD `emailed` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `user_reports` ADD `emailed_at` integer;
--> statement-breakpoint
CREATE INDEX `user_reports_emailed_created_idx` ON `user_reports` (`emailed`,`created_at`);
