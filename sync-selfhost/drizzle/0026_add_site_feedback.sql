CREATE TABLE `site_feedback` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `user_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `message` text NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `site_feedback_user_idx` ON `site_feedback` (`user_id`);
--> statement-breakpoint
CREATE INDEX `site_feedback_created_idx` ON `site_feedback` (`created_at`);
