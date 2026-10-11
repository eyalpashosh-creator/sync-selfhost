CREATE TABLE `password_reset_requests` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `user_id` integer NOT NULL,
  `email` text NOT NULL,
  `token_hash` text NOT NULL,
  `reset_url` text,
  `created_at` integer NOT NULL,
  `expires_at` integer NOT NULL,
  `used_at` integer,
  `emailed` integer DEFAULT false NOT NULL,
  `emailed_at` integer,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `password_reset_requests_token_hash_unique` ON `password_reset_requests` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `password_reset_requests_user_idx` ON `password_reset_requests` (`user_id`);
--> statement-breakpoint
CREATE INDEX `password_reset_requests_pending_idx` ON `password_reset_requests` (`emailed`,`expires_at`,`used_at`);
--> statement-breakpoint
CREATE TABLE `password_reset_rate_limits` (
  `email` text PRIMARY KEY NOT NULL,
  `window_started_at` integer NOT NULL,
  `request_count` integer DEFAULT 1 NOT NULL
);
