CREATE TABLE `user_blocks` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `blocker_user_id` integer NOT NULL,
  `blocked_user_id` integer NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`blocker_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`blocked_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_blocks_pair_idx` ON `user_blocks` (`blocker_user_id`,`blocked_user_id`);
--> statement-breakpoint
CREATE INDEX `user_blocks_blocked_idx` ON `user_blocks` (`blocked_user_id`);
--> statement-breakpoint
CREATE TABLE `user_reports` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `reporter_user_id` integer NOT NULL,
  `target_user_id` integer NOT NULL,
  `reason` text NOT NULL,
  `details` text DEFAULT '' NOT NULL,
  `collaboration_id` integer,
  `message_id` integer,
  `status` text DEFAULT 'active' NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`reporter_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`target_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`collaboration_id`) REFERENCES `collaborations`(`id`) ON UPDATE no action ON DELETE set null,
  FOREIGN KEY (`message_id`) REFERENCES `collaboration_messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_reports_reporter_target_reason_idx` ON `user_reports` (`reporter_user_id`,`target_user_id`,`reason`);
--> statement-breakpoint
CREATE INDEX `user_reports_target_idx` ON `user_reports` (`target_user_id`);
--> statement-breakpoint
CREATE TABLE `collaboration_timeline_events` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `invite_id` integer NOT NULL,
  `event_type` text NOT NULL,
  `label` text NOT NULL,
  `detail` text DEFAULT '' NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`invite_id`) REFERENCES `collaborations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `collaboration_timeline_events_invite_idx` ON `collaboration_timeline_events` (`invite_id`);
--> statement-breakpoint
CREATE INDEX `collaboration_timeline_events_created_idx` ON `collaboration_timeline_events` (`created_at`);
--> statement-breakpoint
CREATE TABLE `collaboration_reviews` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `invite_id` integer NOT NULL,
  `reviewer_user_id` integer NOT NULL,
  `target_user_id` integer NOT NULL,
  `reviewer_role` text NOT NULL,
  `rating` integer NOT NULL,
  `body` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`invite_id`) REFERENCES `collaborations`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`reviewer_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`target_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collaboration_reviews_invite_reviewer_idx` ON `collaboration_reviews` (`invite_id`,`reviewer_user_id`);
--> statement-breakpoint
CREATE INDEX `collaboration_reviews_target_idx` ON `collaboration_reviews` (`target_user_id`);
--> statement-breakpoint
CREATE TABLE `notifications` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `user_id` integer NOT NULL,
  `kind` text NOT NULL,
  `title` text NOT NULL,
  `body` text DEFAULT '' NOT NULL,
  `invite_id` integer,
  `campaign_id` integer,
  `read_at` integer,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`invite_id`) REFERENCES `collaborations`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notifications_user_created_idx` ON `notifications` (`user_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `notifications_user_read_idx` ON `notifications` (`user_id`,`read_at`);