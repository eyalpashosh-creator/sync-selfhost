CREATE TABLE `sign_in_rate_limits` (
  `email` text PRIMARY KEY NOT NULL,
  `window_started_at` integer NOT NULL,
  `failed_count` integer NOT NULL DEFAULT 1
);
