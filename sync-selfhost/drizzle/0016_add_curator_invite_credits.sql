ALTER TABLE `curator_profiles` ADD `invite_plan` text NOT NULL DEFAULT 'starter';
--> statement-breakpoint
ALTER TABLE `curator_profiles` ADD `invite_credits_remaining` integer NOT NULL DEFAULT 5;
--> statement-breakpoint
ALTER TABLE `curator_profiles` ADD `invite_credits_reset_at` integer NOT NULL DEFAULT 0;
